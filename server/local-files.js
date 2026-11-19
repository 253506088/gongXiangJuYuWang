'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const {fail, isWithin} = require('./util');

const MAX_ENTRIES = 20000;
const MAX_FILE_SIZE = 50 * 1024 * 1024 * 1024;
const METADATA_BATCH = 32;
const PICKER_TIMEOUT = 10 * 60 * 1000;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const pathKey = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;

function absolutePath(input) {
  if (typeof input !== 'string' || !input || input.length > 32767 || /[\u0000-\u001f]/.test(input) || !path.isAbsolute(input)) {
    throw fail('请填写文件或文件夹的完整绝对路径');
  }
  if (process.platform === 'win32') {
    // Device namespaces, named pipes and alternate data streams are not files.
    if (/^[\\/]{2}[.?][\\/]/.test(input) || /^[\\/]{2}[^\\/]+[\\/]pipe(?:[\\/]|$)/i.test(input) || !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(input)) {
      throw fail('请选择普通文件或文件夹，不能选择设备或管道路径');
    }
    const relative = input.slice(path.parse(input).root.length);
    if (relative.includes(':') || relative.split(/[\\/]/).some(part => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(part.split('.')[0].replace(/ +$/, '')))) {
      throw fail('请选择普通文件或文件夹，不能选择系统设备');
    }
  }
  return path.resolve(input);
}

function sourceOf(stat) {
  return {dev:String(stat.dev), ino:String(stat.ino), mtimeMs:String(stat.mtimeMs), size:String(stat.size), birthtimeMs:String(stat.birthtimeMs), mtimeNs:String(stat.mtimeNs)};
}

function sameIdentity(a, b) {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino) && String(a.birthtimeMs) === String(b.birthtimeMs);
}

function sameFile(a, b) {
  return sameIdentity(a, b) && String(a.size) === String(b.size) && String(a.mtimeMs) === String(b.mtimeMs) && (a.mtimeNs === undefined || b.mtimeNs === undefined || String(a.mtimeNs) === String(b.mtimeNs));
}

function scanError(error) {
  if (error.status) return error.message;
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '文件或目录不存在，可能已被移动或删除';
  if (error.code === 'EACCES' || error.code === 'EPERM') return '没有权限读取这个文件或目录';
  if (error.code === 'ELOOP') return '目录存在循环链接，已跳过';
  return '无法读取这个文件或目录';
}

async function inspectPath(filename, root) {
  const before = await fsp.lstat(filename, {bigint:true});
  if (before.isSymbolicLink()) throw fail('已跳过符号链接或目录链接');
  if (!before.isFile() && !before.isDirectory()) throw fail('已跳过非普通文件或目录');
  const real = await fsp.realpath(filename);
  if (root && (!isWithin(root, real) || !samePath(filename, real))) throw fail('路径已指向其他位置，已跳过目录链接');
  const stat = await fsp.lstat(real, {bigint:true});
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw fail('已跳过链接或非普通文件');
  if (before.isFile() !== stat.isFile() || !sameIdentity(before, stat) || stat.isFile() && !sameFile(before, stat)) {
    throw fail('文件或目录在选择期间已变化，请重新选择');
  }
  return {path:real, stat};
}

function rootName(filename) {
  return path.basename(filename) || path.parse(filename).root.replace(/[\\/:]+/g, '') || '文件夹';
}

async function scanLocalPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw fail('请选择要发送的文件或文件夹');
  if (paths.length > MAX_ENTRIES) throw fail(`一次最多扫描 ${MAX_ENTRIES} 个文件或目录，请分批选择`, 413);
  const files = [], skipped = [], directories = [], seenFiles = new Set(), seenDirectories = new Set();
  let entries = 0, limited = false;
  const skip = (filename, error) => skipped.push({path:typeof filename === 'string' ? filename : '', error});
  const reserve = filename => {
    if (entries < MAX_ENTRIES) { entries++; return true; }
    if (!limited) skip(filename, `一次最多扫描 ${MAX_ENTRIES} 个文件或目录，其余项目已跳过，请分批选择`);
    limited = true;
    return false;
  };

  async function inspectBatch(batch) {
    const results = await Promise.allSettled(batch.map(async entry => {
      const filename = absolutePath(entry.path);
      return {...entry, ...await inspectPath(filename, entry.root)};
    }));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') { skip(batch[i].path, scanError(result.reason)); continue; }
      const item = result.value, key = pathKey(item.path);
      if (item.stat.isFile()) {
        if (seenFiles.has(key)) { skip(item.path, '重复选择了同一个文件，已忽略'); continue; }
        if (item.stat.size > BigInt(MAX_FILE_SIZE)) { skip(item.path, '单个文件不能超过 50 GB'); continue; }
        seenFiles.add(key);
        files.push({path:item.path, name:path.basename(item.path), size:Number(item.stat.size), relativePath:item.relativePath || path.basename(item.path), source:sourceOf(item.stat)});
      } else {
        const identity = `${item.stat.dev}:${item.stat.ino}:${item.stat.birthtimeMs}`;
        // Some filesystems report zero inode IDs. Canonical paths remain useful there.
        const directoryKey = item.stat.ino === 0n ? key : identity;
        if (seenDirectories.has(directoryKey)) { skip(item.path, '重复选择了同一个目录，已忽略'); continue; }
        seenDirectories.add(directoryKey);
        directories.push({path:item.path, root:item.root || item.path, relativePath:item.relativePath || rootName(item.path), identity:item.stat});
      }
    }
  }

  for (let i = 0; i < paths.length && !limited; i += METADATA_BATCH) {
    const batch = [];
    for (const filename of paths.slice(i, i + METADATA_BATCH)) {
      if (!reserve(filename)) break;
      batch.push({path:filename});
    }
    await inspectBatch(batch);
  }
  for (let cursor = 0; cursor < directories.length && !limited; cursor++) {
    const directory = directories[cursor];
    try {
      const current = await inspectPath(directory.path, directory.root);
      if (!current.stat.isDirectory() || !sameIdentity(directory.identity, current.stat)) throw fail('目录在选择期间已变化，请重新选择');
      const reader = await fsp.opendir(directory.path);
      let batch = [];
      for await (const child of reader) {
        const filename = path.join(directory.path, child.name);
        if (!reserve(filename)) break;
        batch.push({path:filename, root:directory.root, relativePath:`${directory.relativePath}/${child.name}`});
        if (batch.length === METADATA_BATCH) { await inspectBatch(batch); batch = []; }
      }
      if (batch.length) await inspectBatch(batch);
    } catch (error) { skip(directory.path, scanError(error)); }
  }
  return {files, skipped};
}

function localSource(upload) {
  let filename;
  try { filename = absolutePath(upload?.file || upload?.path); }
  catch { throw fail('原文件路径无效，请重新选择文件', 409); }
  const source = upload?.source;
  if (!source || !['dev', 'ino', 'size', 'mtimeMs', 'birthtimeMs'].every(key => typeof source[key] === 'string' && /^-?\d+$/.test(source[key])) || !/^\d+$/.test(source.size) || source.mtimeNs !== undefined && (typeof source.mtimeNs !== 'string' || !/^-?\d+$/.test(source.mtimeNs))) {
    throw fail('原文件信息无效，请重新选择文件', 409);
  }
  const size = Number(source.size);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SIZE || upload.size !== undefined && upload.size !== size) {
    throw fail('原文件大小信息已变化，请重新选择文件', 409);
  }
  return {filename, source};
}

function verifySourceStat(source, stat) {
  if (!stat.isFile() || !sameFile(source, stat)) throw fail('原文件已被修改或替换，请重新选择文件', 409);
}

function sourceError(error) {
  if (error.status) return error;
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return fail('原文件已被移动或删除，请重新选择文件', 404);
  if (error.code === 'ELOOP') return fail('原文件路径已变成链接，请重新选择文件', 409);
  return fail('原文件暂时无法读取，请检查文件是否存在或被占用', 404);
}

async function verifySourcePath(filename, source) {
  const info = await fsp.lstat(filename, {bigint:true});
  if (info.isSymbolicLink() || !info.isFile()) throw fail('原文件路径已被替换，请重新选择文件', 409);
  verifySourceStat(source, info);
  const real = await fsp.realpath(filename);
  if (!samePath(real, filename)) throw fail('原文件路径已指向其他位置，请重新选择文件', 409);
  const after = await fsp.lstat(filename, {bigint:true});
  if (after.isSymbolicLink()) throw fail('原文件路径已变成链接，请重新选择文件', 409);
  verifySourceStat(source, after);
}

async function openLocalSource(upload) {
  let handle;
  try {
    const {filename, source} = localSource(upload);
    await verifySourcePath(filename, source);
    // O_NONBLOCK prevents a swapped FIFO from hanging an open on POSIX; Windows
    // device and pipe namespaces have already been rejected by absolutePath.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    handle = await fsp.open(filename, flags);
    verifySourceStat(source, await handle.stat({bigint:true}));
    await verifySourcePath(filename, source);
    return handle;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    throw sourceError(error);
  }
}

async function validateLocalSource(upload, opened) {
  if (!opened) {
    const handle = await openLocalSource(upload);
    await handle.close();
    return true;
  }
  try {
    const {filename, source} = localSource(upload);
    await verifySourcePath(filename, source);
    verifySourceStat(source, await opened.stat({bigint:true}));
    return true;
  } catch (error) { throw sourceError(error); }
}

let bundledPicker;
const pickerHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function pickerExecutable() {
  const asset = path.join(__dirname, 'picker', 'LinkWavePicker.exe');
  if (!process.pkg) {
    const stat = await fsp.lstat(asset);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('本机文件选择组件无效，请重新安装邻波', 500);
    return asset;
  }
  if (!bundledPicker) bundledPicker = fsp.readFile(asset).then(bytes => ({bytes, hash:pickerHash(bytes)})).catch(error => { bundledPicker = undefined; throw error; });
  const {bytes, hash} = await bundledPicker;
  const tempRoot = await fsp.realpath(os.tmpdir());
  const directory = path.join(tempRoot, 'LinkWavePicker', hash);
  await fsp.mkdir(directory, {recursive:true});
  const realDirectory = await fsp.realpath(directory);
  if (!samePath(realDirectory, directory) || !isWithin(tempRoot, realDirectory)) throw fail('本机文件选择组件缓存目录无效', 500);
  const executable = path.join(directory, 'LinkWavePicker.exe');
  async function validCache() {
    try {
      const stat = await fsp.lstat(executable);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if (!samePath(executable, await fsp.realpath(executable))) return false;
      return pickerHash(await fsp.readFile(executable)) === hash;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  if (!await validCache()) {
    const temporary = path.join(directory, `LinkWavePicker.${crypto.randomUUID()}.exe`);
    try {
      // Only the bundled GUI helper is extracted; user files are never copied.
      await fsp.writeFile(temporary, bytes, {flag:'wx', mode:0o700});
      try { await fsp.rename(temporary, executable); }
      catch (error) { if (!await validCache()) throw error; }
    } finally { await fsp.rm(temporary, {force:true}).catch(() => {}); }
    if (!await validCache()) throw fail('本机文件选择组件缓存校验失败', 500);
  }
  return executable;
}

async function pickLocalFiles({signal, timeoutMs = PICKER_TIMEOUT} = {}) {
  if (process.platform !== 'win32') throw fail('此系统不支持本机文件选择窗口，请粘贴文件的完整路径', 501);
  if (signal?.aborted) throw fail('已取消选择文件', 499);
  let executable;
  try { executable = await pickerExecutable(); }
  catch (error) { throw error.status ? error : fail('本机文件选择组件缺失或无法读取，请重新安装邻波', 500); }
  if (signal?.aborted) throw fail('已取消选择文件', 499);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {windowsHide:false, stdio:['ignore', 'pipe', 'pipe']});
    let output = '', outputBytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const stop = error => { child.kill(); finish(error); };
    const abort = () => stop(fail('已取消选择文件', 499));
    const timer = setTimeout(() => stop(fail('选择文件已超时，请重新打开选择窗口', 408)), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PICKER_TIMEOUT);
    timer.unref?.();
    signal?.addEventListener('abort', abort, {once:true});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      outputBytes += Buffer.byteLength(data);
      if (outputBytes > 2 * 1024 * 1024) { stop(fail('选择的文件过多，请分批选择', 413)); return; }
      output += data;
    });
    // Drain diagnostic output without returning machine paths in API errors.
    child.stderr.resume();
    child.once('error', () => finish(fail('无法打开本机文件选择窗口，请检查本机文件选择组件是否被拦截', 500)));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) { finish(fail('无法打开本机文件选择窗口，请重试', 500)); return; }
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, '').trim());
        if (!Array.isArray(result.paths)) throw fail('本机文件选择窗口返回了无效结果，请重试', 500);
        if (result.paths.length > MAX_ENTRIES) throw fail('选择的文件过多，请分批选择', 413);
        finish(null, result.paths.map(absolutePath));
      } catch (error) { finish(error.status ? error : fail('本机文件选择窗口返回了无效结果，请重试', 500)); }
    });
    if (signal?.aborted) abort();
  });
}

async function pickSendFiles(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => { if (!res.writableEnded) abort(); };
  req.once('aborted', abort);
  res.once('close', close);
  try {
    const paths = await pickLocalFiles({signal:controller.signal});
    if (!res.destroyed) res.json({paths});
  } finally {
    req.removeListener('aborted', abort);
    res.removeListener('close', close);
  }
}

module.exports = {scanLocalPaths, openLocalSource, validateLocalSource, pickLocalFiles, pickSendFiles, MAX_ENTRIES, MAX_FILE_SIZE};

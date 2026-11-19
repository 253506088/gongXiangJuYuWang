'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const archiver = require('archiver');
const { buildPicker } = require('./build-picker');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const version = require('../package.json').version;
const windowsOnly = process.argv.includes('--windows-only');
const noTests = process.argv.includes('--skip-tests');

function run(command, args, options = {}) {
  console.log(`\n[邻波] ${options.label || [command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`步骤失败，退出码 ${result.status}`);
}

async function zipFolder(folder, target, sourceMode = false) {
  const output = fs.createWriteStream(target);
  const zip = archiver('zip', { zlib: { level: 9 } });
  const done = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    zip.on('error', reject);
    zip.on('warning', reject);
  });
  zip.pipe(output);
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!sourceMode && !prefix && !['LinkWave.exe','启动Windows.bat','使用说明.html','LICENSE'].includes(entry.name)) continue;
      if (sourceMode && ['node_modules', 'dist', 'data', '.git', '.build', '.gradle', '.tools', 'build'].includes(entry.name)) continue;
      if(sourceMode&&prefix==='android'&&entry.name==='test-fixtures')continue;
      if (sourceMode && (entry.name === 'local.properties' || /\.(log|tmp|apk|jks|keystore)$/.test(entry.name))) continue;
      if (sourceMode && prefix === 'android/app/src/main/assets' && ['web','www'].includes(entry.name)) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, name);
      else if (entry.isFile()) zip.file(full, { name });
    }
  }
  walk(folder);
  await zip.finalize();
  await done;
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('打包需要 Node.js 22 或 24。请用 nvm use 24 / nvm use 22。');
  fs.mkdirSync(dist, { recursive: true });
  buildPicker();
  if (!noTests) run(process.execPath, ['--test', 'tests/*.test.js'], { label: '运行传输、鉴权与视频集成测试' });
  const pkgEntry = require.resolve('@yao-pkg/pkg/lib-es5/bin.js');
  const executable = path.join(dist, 'LinkWave.exe');
  run(process.execPath, [pkgEntry, 'package.json', '--targets', 'node22-win-x64', '--output', executable, '--compress', 'GZip'], { label: '生成 Windows x64 独立可执行程序' });
  run(process.execPath, ['tests/packaged-smoke.cjs', executable], { label: '在独立目录验证实际 EXE（无需系统 Node）' });
  const portable = path.join(dist, 'LinkWave-Windows');
  const resolved = path.resolve(portable);
  if (path.dirname(resolved) !== dist || path.basename(resolved) !== 'LinkWave-Windows') throw new Error('打包目录校验失败');
  // Overwrite generated files only; preserve any receive data beside a used EXE.
  fs.mkdirSync(portable, { recursive: true });
  fs.copyFileSync(executable, path.join(portable, 'LinkWave.exe'));
  for (const file of ['启动Windows.bat', '使用说明.html', 'LICENSE']) fs.copyFileSync(path.join(root, file), path.join(portable, file));
  // Archive obsolete generated launchers away from the user-facing package.
  const retired=path.join(root,'.build','retired-launchers');fs.mkdirSync(retired,{recursive:true});
  for(const file of ['启动邻波.bat','停止邻波.bat','允许局域网访问.bat','README.md','版本.txt']){
    const source=path.join(portable,file),destination=path.join(retired,file);
    if(fs.existsSync(source))fs.renameSync(source,destination);
  }
  await zipFolder(portable, path.join(dist, `邻波-LinkWave-${version}-Windows-x64.zip`));
  if (!windowsOnly) run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'build-android.ps1')], { label: '编译 Android 独立安装包' });
  await zipFolder(root, path.join(dist, `邻波-LinkWave-${version}-源码.zip`), true);
  const artifacts = fs.readdirSync(dist).filter(name => /\.(exe|apk|zip)$/.test(name));
  const hashes = artifacts.map(name => `${require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(dist, name))).digest('hex')}  ${name}`).join('\r\n');
  fs.writeFileSync(path.join(dist, 'SHA256SUMS.txt'), `${hashes}\r\n`);
  console.log(`\n邻波 ${version} 打包完成：\n${artifacts.map(name => `  ${path.join(dist, name)}`).join('\n')}\n`);
}

if (require.main === module) main().catch(error => { console.error(`\n打包失败：${error.message}`); process.exitCode = 1; });
module.exports = { zipFolder };

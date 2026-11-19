'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function buildPicker() {
  if (process.platform !== 'win32') throw new Error('Windows 文件选择组件需要在 Windows 上编译');
  const root = path.resolve(__dirname, '..');
  const folder = path.join(root, 'server', 'picker');
  const source = path.join(folder, 'Source.cs');
  const executable = path.join(folder, 'LinkWavePicker.exe');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework'].map(name => path.join(systemRoot, 'Microsoft.NET', name, 'v4.0.30319', 'csc.exe')).find(filename => fs.existsSync(filename));
  if (!compiler) throw new Error('找不到 Windows .NET Framework 4 C# 编译器，无法生成文件选择组件');
  fs.mkdirSync(folder, {recursive:true});
  const result = spawnSync(compiler, [
    '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/utf8output', '/codepage:65001',
    '/reference:System.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    `/out:${executable}`, source
  ], {cwd:root, windowsHide:true, encoding:'utf8', timeout:60000});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Windows 文件选择组件编译失败：${String(result.stdout || result.stderr || '').trim()}`);
  const check = spawnSync(executable, ['--self-test'], {cwd:root, windowsHide:false, encoding:'utf8', timeout:10000});
  if (check.error) throw check.error;
  let output;
  try { output = JSON.parse(check.stdout); } catch {}
  if (check.status !== 0 || output?.paths?.[0] !== 'C:\\中文 空格\\原文件.txt' || output?.paths?.[1] !== 'C:\\test\\quote"and\\backslash.txt') {
    throw new Error('Windows 文件选择组件的 UTF-8 输出验证失败');
  }
  console.log(`[邻波] 已生成 Windows 本机文件选择组件：${executable}`);
  return executable;
}

if (require.main === module) {
  try { buildPicker(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = {buildPicker};

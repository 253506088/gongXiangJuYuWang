'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const VERSION = '1.3.0';
const CHUNK_SIZE = 4 * 1024 * 1024;
const uuid = () => crypto.randomUUID();
const token = () => crypto.randomBytes(32).toString('hex');
function fail(message, status = 400, extra = {}) { return Object.assign(new Error(message), {status, ...extra}); }
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function cleanName(input, fallback = '未命名') {
  const value = String(input || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return value || fallback;
}
function safeFilename(input) {
  const value = String(input || '').normalize('NFC');
  if (!value || value.length > 240 || /[<>:"/\\|?*\u0000-\u001f]/.test(value) || value === '.' || value === '..' || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw fail('文件名包含系统不支持的字符');
  return value;
}
function safeRelative(input = '') {
  const value = String(input).replace(/\\/g, '/');
  if (!value) return '';
  if (value.length > 3000 || value.startsWith('/') || /[\u0000-\u001f]/.test(value)) throw fail('路径无效');
  const segments = value.split('/');
  if (segments.some(p => !p || p === '.' || p === '..' || /[<>:"|?*]/.test(p) || /[. ]$/.test(p))) throw fail('路径超出共享目录');
  return segments.join('/');
}
function isWithin(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function resolveShared(root, relative = '') {
  const clean = safeRelative(relative);
  const filename = path.resolve(root, ...clean.split('/').filter(Boolean));
  if (!isWithin(root, filename)) throw fail('路径超出共享目录', 403);
  let real;
  try { real = await fsp.realpath(filename); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw fail('文件或目录不存在', 404); throw e; }
  if (!isWithin(root, real)) throw fail('链接指向共享目录之外', 403);
  return {filename: real, relative: clean, stat: await fsp.stat(real)};
}
async function atomicJson(filename, data) {
  await fsp.mkdir(path.dirname(filename), {recursive:true});
  const temp = `${filename}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data, null, 2), {mode:0o600});
  await fsp.rename(temp, filename);
}
function localAddress(value) { return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'; }
function ips() {
  const values=[];
  for(const [name, list] of Object.entries(os.networkInterfaces())) for(const info of list || []) if ((info.family === 'IPv4' || info.family === 4) && !info.internal && !info.address.startsWith('169.254.')) values.push({name, ip:info.address, netmask:info.netmask});
  function rank(info){
    const octets=info.ip.split('.').map(Number);
    const privateLan=octets[0]===10||octets[0]===192&&octets[1]===168||octets[0]===172&&octets[1]>=16&&octets[1]<=31;
    let score=privateLan?0:20;
    if(/virtual|vEthernet|vmware|docker|tailscale|vpn|tun|tap|mihomo|clash|sing.?box|proxy|wsl|hyper.?v|zerotier|wireguard/i.test(info.name))score+=100;
    // 198.18.0.0/15 is the benchmarking range commonly used by proxy TUNs.
    if(octets[0]===198&&(octets[1]===18||octets[1]===19))score+=200;
    if(octets[0]===100&&octets[1]>=64&&octets[1]<=127)score+=50;
    if(/wi.?fi|wlan|ethernet|无线|以太网/i.test(info.name))score-=2;
    return score;
  }
  return values.sort((a,b)=>rank(a)-rank(b));
}
function lanUrls(port) { return ips().map(info => `http://${info.ip}:${port}`); }
function platform(req) { const ua=String(req.headers['user-agent']||''); return /android/i.test(ua)?'Android':/iphone|ipad/i.test(ua)?'iOS':/windows/i.test(ua)?'Windows':/macintosh/i.test(ua)?'macOS':'Browser'; }
function bearer(req) { const match = /^Bearer ([a-f0-9]{64})$/i.exec(req.headers.authorization || ''); return match?.[1] || String(req.query?.token || ''); }
function contentDisposition(filename, attachment = true) {
  const ascii = filename.replace(/[^\x20-\x7E]|["\\]/g, '_');
  return `${attachment ? 'attachment':'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
function checkOrigin(req) {
  const origin = req.headers.origin;
  if(!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { throw fail('请求来源无效', 403); }
  if(parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw fail('请求来源无效', 403);
  if(parsed.host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) throw fail('拒绝跨站请求', 403);
}
module.exports = {VERSION,CHUNK_SIZE,uuid,token,fail,asyncRoute,cleanName,safeFilename,safeRelative,isWithin,resolveShared,atomicJson,localAddress,ips,lanUrls,platform,bearer,contentDisposition,checkOrigin};

'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const {fail, asyncRoute, lanUrls} = require('./util');
const {serveFile} = require('./media');

const durations = new Set([0, 3600, 86400, 604800]);
const samePath = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function identity(stat) { return {dev:String(stat.dev),ino:String(stat.ino),birthtimeMs:String(stat.birthtimeMs)}; }
function sameIdentity(expected,stat) {
  if (!expected) return false;
  if (expected.ino !== '0') return expected.dev === String(stat.dev) && expected.ino === String(stat.ino);
  return expected.dev === String(stat.dev) && expected.birthtimeMs === String(stat.birthtimeMs);
}

function createFileLinks(config, saveConfig, notify) {
  config.fileLinks = Array.isArray(config.fileLinks) ? config.fileLinks.filter(link => /^[a-f0-9]{32}$/.test(link?.id) && typeof link.path === 'string' && link.source) : [];
  const isExpired = link => link.expiresAt !== null && (!Number.isFinite(Date.parse(link.expiresAt)) || Date.parse(link.expiresAt) <= Date.now());
  async function openSource(link) {
    let handle;
    try {
      const real = await fsp.realpath(link.path);
      const info = await fsp.lstat(link.path);
      if (!samePath(real,link.path) || info.isSymbolicLink() || !info.isFile()) throw fail('原文件已被移动、替换或删除',404);
      handle = await fsp.open(link.path, 'r');
      const stat = await handle.stat({bigint:true});
      if (!stat.isFile() || !sameIdentity(link.source,stat)) throw fail('原文件已被替换，请重新创建分享链接',404);
      const size = Number(stat.size);
      if (!Number.isSafeInteger(size)) throw fail('文件大小不受支持',404);
      return {handle,size};
    } catch (error) {
      if (handle) await handle.close().catch(()=>{});
      if (error.status) throw error;
      throw fail('原文件暂时无法读取，可能已移动或删除',404);
    }
  }
  function view(link,status='active') {
    return {id:link.id,name:link.name,path:link.path,size:link.size,createdAt:link.createdAt,expiresAt:link.expiresAt,downloads:Number(link.downloads)||0,status,
      url:`${lanUrls(config.port)[0]||`http://127.0.0.1:${config.port}`}/d/${link.id}/${encodeURIComponent(link.name)}`};
  }
  async function views() {
    const output=[];
    for(let i=0;i<config.fileLinks.length;i+=16) {
      output.push(...await Promise.all(config.fileLinks.slice(i,i+16).map(async link=>{
        if(isExpired(link)) return view(link,'expired');
        try { const source=await openSource(link);link.size=source.size;await source.handle.close();return view(link); }
        catch { return view(link,'missing'); }
      })));
    }
    return output.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  }
  async function create(body) {
    const input = typeof body.path === 'string' ? body.path.trim() : '';
    if(!input || !path.isAbsolute(input) || input.length>4000 || input.includes('\0')) throw fail('请选择文件或填写文件的完整绝对路径');
    const expiresIn=body.expiresIn===undefined?86400:Number(body.expiresIn);
    if(!durations.has(expiresIn)) throw fail('链接有效期应为 1 小时、24 小时、7 天或手动撤销');
    let filename,handle;
    try {
      filename=await fsp.realpath(input);
      if(!(await fsp.stat(filename)).isFile())throw fail('请选择单个文件，文件夹请使用影音共享');
      handle=await fsp.open(filename,'r');
      const stat=await handle.stat({bigint:true});
      if(!stat.isFile()) throw fail('请选择单个文件，文件夹请使用影音共享');
      if(!Number.isSafeInteger(Number(stat.size))) throw fail('文件大小不受支持');
      const link={id:crypto.randomBytes(16).toString('hex'),path:filename,name:path.basename(filename),size:Number(stat.size),source:identity(stat),createdAt:new Date().toISOString(),expiresAt:expiresIn?new Date(Date.now()+expiresIn*1000).toISOString():null,downloads:0};
      config.fileLinks.push(link);await saveConfig();notify();return view(link);
    } catch(error) {
      if(error.status)throw error;
      if(error.code==='ENOENT'||error.code==='ENOTDIR')throw fail('文件不存在，请重新选择',404);
      if(error.code==='EACCES'||error.code==='EPERM')throw fail('没有权限读取这个文件',403);
      throw error;
    } finally { if(handle)await handle.close().catch(()=>{}); }
  }
  function attachPublic(app) {
    const download=asyncRoute(async(req,res)=>{
      if(!/^[a-f0-9]{32}$/.test(req.params.id))throw fail('下载链接不存在或已撤销',404);
      const link=config.fileLinks.find(item=>item.id===req.params.id);
      if(!link)throw fail('下载链接不存在或已撤销',404);
      if(isExpired(link))throw fail('下载链接已过期，请联系分享者重新生成',410);
      const source=await openSource(link);link.size=source.size;
      // Read from the verified open descriptor, never reopen a potentially swapped path.
      if(req.method==='GET'&&!req.headers.range)res.once('finish',()=>{
        if(res.statusCode===200) {link.downloads=(Number(link.downloads)||0)+1;saveConfig();notify();}
      });
      res.set('Cache-Control','private, no-store');
      await serveFile(req,res,link.path,link.name,true,source.handle);
    });
    app.get('/d/:id/:name?',download); // Express also delegates HEAD to this handler.
  }
  function attachAdmin(app,admin) {
    app.get('/api/file-links',admin,asyncRoute(async(req,res)=>res.json({links:await views()})));
    app.post('/api/file-links',admin,asyncRoute(async(req,res)=>res.status(201).json(await create(req.body))));
    app.delete('/api/file-links/:id',admin,asyncRoute(async(req,res)=>{
      if(!config.fileLinks.some(link=>link.id===req.params.id))throw fail('分享链接不存在',404);
      config.fileLinks=config.fileLinks.filter(link=>link.id!==req.params.id);
      await saveConfig();notify();res.json({ok:true});
    }));
  }
  return {views,attachPublic,attachAdmin};
}
module.exports={createFileLinks};

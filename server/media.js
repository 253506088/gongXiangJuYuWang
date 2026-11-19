'use strict';
const fs = require('node:fs');
const path=require('node:path');
const {pipeline}=require('node:stream/promises');
const mime=require('mime-types');
const archiver=require('archiver');
const {fail,contentDisposition,resolveShared,isWithin}=require('./util');

async function serveFile(req,res,filename,displayName,attachment=false,opened=null) {
 try {
  const stat=opened?await opened.stat():await fs.promises.stat(filename);
  if(!stat.isFile()) throw fail('请选择一个文件',400);
  const mimeType=mime.lookup(displayName) || 'application/octet-stream';
  const etag=`"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  res.set({'Content-Type':mimeType,'Accept-Ranges':'bytes','Content-Disposition':contentDisposition(displayName,attachment),'Last-Modified':stat.mtime.toUTCString(),'ETag':etag,'Cache-Control':opened?'private, no-store':'private, no-cache','X-Content-Type-Options':'nosniff'});
  // Never execute shared HTML/SVG in the authenticated application origin.
  res.set('Content-Security-Policy',"sandbox; default-src 'none'; media-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'");
  if(req.headers['if-none-match']===etag && !req.headers.range){res.status(304).end();return;}
  let start=0,end=stat.size-1;
  if(req.headers.range && (!req.headers['if-range'] || req.headers['if-range']===etag || req.headers['if-range']===stat.mtime.toUTCString())) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(!match || (!match[1]&&!match[2])) {res.set('Content-Range',`bytes */${stat.size}`).status(416).end();return;}
    if(!match[1]) {const suffix=Number(match[2]);start=Math.max(0,stat.size-suffix);if(suffix===0)start=stat.size;}
    else {start=Number(match[1]);if(match[2])end=Math.min(Number(match[2]),end);}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=stat.size){res.set('Content-Range',`bytes */${stat.size}`).status(416).end();return;}
    res.status(206).set('Content-Range',`bytes ${start}-${end}/${stat.size}`);
  }
  res.set('Content-Length',stat.size===0?0:end-start+1);
  if(req.method==='HEAD'||stat.size===0){res.end();return;}
  try{await pipeline(opened?opened.createReadStream({start,end,autoClose:false}):fs.createReadStream(filename,{start,end}),res);}catch(e){if(!req.destroyed && !res.destroyed)throw e;}
 } finally { if(opened)await opened.close().catch(()=>{}); }
}
async function browse(root,relative,share) {
  const target=await resolveShared(root,relative);
  if(!target.stat.isDirectory())throw fail('目标不是文件夹');
  const children=await fs.promises.readdir(target.filename,{withFileTypes:true});
  const entries=[];
  // Sequential batches avoid exhausting Windows file handles on large libraries.
  for(let offset=0;offset<children.length;offset+=32){
    const batch=await Promise.all(children.slice(offset,offset+32).map(async child=>{
      const childPath=relative?`${relative}/${child.name}`:child.name;
      try {
        const item=await resolveShared(root,childPath);
        if(!item.stat.isDirectory()&&!item.stat.isFile())return null;
        return {name:child.name,path:childPath,type:item.stat.isDirectory()?'folder':'file',size:item.stat.isFile()?item.stat.size:0,modifiedAt:item.stat.mtime.toISOString(),mime:item.stat.isFile()?(mime.lookup(child.name)||'application/octet-stream'):null};
      }catch{return null;}
    }));entries.push(...batch.filter(Boolean));
  }
  entries.sort((a,b)=>Number(a.type!=='folder')-Number(b.type!=='folder')||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  return {share:{id:share.id,name:share.name},path:relative,parent:relative?relative.split('/').slice(0,-1).join('/'):null,entries,total:entries.length};
}
async function streamZip(req,res,root,relative,name) {
  const target=await resolveShared(root,relative);
  if(!target.stat.isDirectory())return serveFile(req,res,target.filename,path.basename(target.filename),true);
  res.set({'Content-Type':'application/zip','Content-Disposition':contentDisposition(`${name}.zip`),'Cache-Control':'private, no-store'});
  const archive=archiver('zip',{zlib:{level:1},forceZip64:true});
  let stopped=false;
  res.on('close',()=>{stopped=true;archive.abort();});
  archive.on('error',err=>res.destroy(err));
  archive.on('warning',err=>{if(err.code!=='ENOENT')res.destroy(err);});
  archive.pipe(res);
  async function walk(dir,prefix) {
    if(stopped)return;
    const entries=await fs.promises.readdir(dir,{withFileTypes:true});
    if(!entries.length)archive.append('',{name:`${prefix}/`});
    for(const entry of entries){
      if(stopped)return;
      // Symlink trees can contain cycles. Skip links rather than recursively following them.
      if(entry.isSymbolicLink())continue;
      const filename=path.join(dir,entry.name),zipName=prefix?`${prefix}/${entry.name}`:entry.name;
      const real=await fs.promises.realpath(filename).catch(()=>null);
      if(!real||!isWithin(root,real))continue;
      if(entry.isDirectory())await walk(real,zipName);
      else if(entry.isFile())archive.file(real,{name:zipName});
    }
  }
  try{await walk(target.filename,name);if(!stopped)await archive.finalize();}catch(e){archive.abort();if(!res.destroyed)res.destroy(e);}
}
module.exports={serveFile,browse,streamZip};

'use strict';
const express=require('express');
const http=require('node:http');
const fs=require('node:fs');
const fsp=fs.promises;
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {spawn}=require('node:child_process');
const {WebSocketServer,WebSocket}=require('ws');
const qrcode=require('qrcode');
const {createDiscovery}=require('./discovery');
const {serveFile,browse,streamZip}=require('./media');
const {createFileLinks}=require('./file-links');
const {ensureWindowsLan}=require('./windows-lan');
const {createSharedLibrary}=require('./shared-library');
const {sendChunks}=require('./peer-transfer');
const {scanLocalPaths,openLocalSource,validateLocalSource,pickSendFiles}=require('./local-files');
const {discoverSubtitles,readSubtitle}=require('./subtitles');
const {VERSION,CHUNK_SIZE,uuid,token,fail,asyncRoute,cleanName,safeFilename,safeRelative,resolveShared,atomicJson,localAddress,lanUrls,platform,bearer,contentDisposition,checkOrigin}=require('./util');

const DEFAULT_PORT=53317;
const MAX_SIZE=50*1024*1024*1024;
const RETENTION=7*24*60*60*1000;
function nativeBrowser(url){
  const command=process.platform==='win32'?'rundll32.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  const child=spawn(command,args,{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();
}
function hostIsLocal(req){
  try{const h=new URL(`http://${req.headers.host}`).hostname;return h==='localhost'||h==='127.0.0.1'||h==='[::1]'||h==='::1';}catch{return false;}
}
function localAdminRequest(req){return localAddress(req.socket.remoteAddress)&&hostIsLocal(req);}
function validDeviceId(value){return typeof value==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(value)||typeof value==='string'&&/^[a-f0-9-]{16,64}$/i.test(value);}
async function availableSpace(directory,size){
  // Fail before receiving a large file when the destination volume is already full.
  // Some filesystems do not report free space; streaming errors remain the fallback.
  try {const space=await fsp.statfs(directory,{bigint:true});if(space.bavail*space.bsize<BigInt(size)+32n*1024n*1024n)throw fail('磁盘剩余空间不足，请清理接收目录或更换磁盘',507);}catch(e){if(e.status)throw e;}
}
function decodeHeader(value){try{return decodeURIComponent(String(value||''));}catch{return String(value||'');}}

async function createApp(options={}) {
  const dataDir=path.resolve(options.dataDir||process.env.LINKWAVE_DATA_DIR||(process.pkg?path.join(path.dirname(process.execPath),'data'):path.join(process.cwd(),'data')));
  await fsp.mkdir(dataDir,{recursive:true});
  const configFile=path.join(dataDir,'config.json'),stateFile=path.join(dataDir,'state.json'),tempDir=path.join(dataDir,'uploads');
  await fsp.mkdir(tempDir,{recursive:true});
  let saved={},stored={};
  try{saved=JSON.parse(await fsp.readFile(configFile,'utf8'));}catch(e){if(e.code!=='ENOENT')console.warn('配置文件无法读取，已使用默认配置。');}
  try{stored=JSON.parse(await fsp.readFile(stateFile,'utf8'));}catch{}
  const config={id:typeof saved.id==='string'?saved.id:uuid(),name:cleanName(options.name||saved.name||os.hostname()),port:Number(options.port??process.env.LINKWAVE_PORT??saved.port??DEFAULT_PORT),downloadDir:path.resolve(options.downloadDir||saved.downloadDir||path.join(dataDir,'received')),shares:Array.isArray(saved.shares)?saved.shares:[],fileLinks:Array.isArray(saved.fileLinks)?saved.fileLinks:[],manualPeers:Array.isArray(saved.manualPeers)?saved.manualPeers:[],dataDir};
  if(!Number.isInteger(config.port)||config.port<0||config.port>65535)throw fail('端口应为 1–65535 的整数');
  await fsp.mkdir(config.downloadDir,{recursive:true});
  const sessions=new Map(),devices=new Map(),uploads=new Map(),inbox=new Map();
  const stats={sentBytes:Number(stored.stats?.sentBytes)||0,receivedBytes:Number(stored.stats?.receivedBytes)||0};
  for(const s of stored.sessions||[])if(s&&typeof s.token==='string'&&validDeviceId(s.id)) {sessions.set(s.token,s);devices.set(s.id,{id:s.id,name:s.name,platform:s.platform||'Browser',type:'browser',online:false,lastSeen:0});}
  for(const u of stored.uploads||[]) {
    if(!u?.id||Date.now()-u.createdAt>RETENTION&&u.status!=='complete')continue;
    if(u.localSource){u.busy=false;if(u.status==='sending'||u.status==='queued'){u.status='error';u.phase='paused';u.error='上次发送中断，点击继续发送';}uploads.set(u.id,u);continue;}
    if(u.status==='complete'&&String(u.targetId).startsWith('host:')&&!u.file){uploads.set(u.id,{...u,busy:false});continue;}
    if(!u.file)continue;
    try{const st=await fsp.stat(u.file);u.received=st.size;u.busy=false;if(u.status==='sending')u.status='error';if(u.status==='error')u.error='上次传输被中断，可以重试';uploads.set(u.id,u);}catch{}
  }
  for(const item of stored.inbox||[]) if(item?.id&&item.file) {try{await fsp.access(item.file);inbox.set(item.id,item);}catch{}}
  let persistTail=Promise.resolve(),stateTimer,started=false,closing=false;
  function saveConfig(){const snapshot=JSON.parse(JSON.stringify({...config,dataDir:undefined}));persistTail=persistTail.then(()=>atomicJson(configFile,snapshot)).catch(e=>console.error('配置保存失败：',e.message));return persistTail;}
  function saveState(){const snapshot={sessions:[...sessions.values()],uploads:[...uploads.values()].map(({busy,...u})=>u),inbox:[...inbox.values()],stats};const copy=JSON.parse(JSON.stringify(snapshot));persistTail=persistTail.then(()=>atomicJson(stateFile,copy)).catch(e=>console.error('状态保存失败：',e.message));return persistTail;}
  const app=express();app.disable('x-powered-by');
  const server=http.createServer(app);server.requestTimeout=0;server.headersTimeout=60000;server.keepAliveTimeout=5000;
  const wss=new WebSocketServer({noServer:true,maxPayload:4096});
  const sockets=new Map();
  function notify(){
    for(const client of wss.clients)if(client.readyState===WebSocket.OPEN)client.send('{"type":"state"}');
  }
  const fileLinks=createFileLinks(config,saveConfig,notify);
  const discovery=createDiscovery(()=>({id:config.id,name:config.name,port:config.port,platform:process.platform==='win32'?'Windows':process.platform==='darwin'?'macOS':'Linux'}),notify,{disabled:options.discovery===false,onWarning:message=>console.warn(message)});
  if(options.peers)for(const peer of options.peers)discovery.peers.set(peer.id,peer);
  for(const peer of config.manualPeers)discovery.peers.set(peer.id,{...peer,lastSeen:Date.now(),manual:true});
  function serverInfo(){return {id:config.id,name:config.name,platform:process.platform==='win32'?'Windows':process.platform==='darwin'?'macOS':'Linux',version:VERSION,port:config.port};}
  const library=createSharedLibrary(config,discovery,serverInfo,saveConfig,notify);
  function sessionOf(req){const value=bearer(req);const s=sessions.get(value);if(!s){
    const requestPath=req.baseUrl+req.path;
    const guestRead=(req.method==='GET'||req.method==='HEAD')&&(requestPath==='/api/state'||/^\/api\/shares\/[^/]+\/(browse|file|download|subtitles|subtitle)$/.test(requestPath)||/^\/api\/inbox\/[^/]+\/download$/.test(requestPath));
    if(!guestRead)throw fail('连接已断开，请刷新页面自动重连',401);req.session={id:'guest',name:'局域网设备'};req.admin=false;return req.session;
  }req.session=s;req.admin=!!s.admin&&localAdminRequest(req);return s;}
  function auth(req,res,next){try{sessionOf(req);next();}catch(e){next(e);}}
  function admin(req,res,next){if(!req.admin)return next(fail('只有服务主机可以执行此操作，请在主机打开 127.0.0.1 地址',403));next();}
  function touch(s,req){if(s.id==='guest')return;const old=devices.get(s.id);devices.set(s.id,{id:s.id,name:s.name,platform:s.platform,type:'browser',online:true,lastSeen:Date.now(),ip:req.socket.remoteAddress?.replace(/^::ffff:/,'')});if(!old?.online)notify();}
  function newSession(id,name,req,isAdmin){
    if(!validDeviceId(id))throw fail('设备标识无效');
    // Device IDs are visible in /state and are not authentication secrets. A new
    // remote pairing must never reissue another device's token or identity.
    if(!isAdmin&&devices.has(id))id=uuid();
    let s=[...sessions.values()].find(x=>x.id===id&&x.admin===isAdmin);
    if(!s){s={id,name:cleanName(name,'我的设备'),platform:platform(req),admin:isAdmin,token:token(),createdAt:Date.now()};sessions.set(s.token,s);}else if(name)s.name=cleanName(name);
    touch(s,req);saveState();return s;
  }
  function publicBootstrap(req,s){const isAdmin=!!s?.admin&&localAdminRequest(req);return {server:serverInfo(),paired:!!s,token:s?.token,device:s?{id:s.id,name:s.name}:undefined,admin:isAdmin,urls:lanUrls(config.port),downloadDir:isAdmin?config.downloadDir:undefined,capabilities:{localFiles:true,directConnect:true,folderPicker:process.platform==='win32',filePicker:process.platform==='win32',fileLinks:true,directoryZip:true}};}
  function shareView(share,adminAccess){return {id:share.id,name:share.name,type:'folder',path:adminAccess?share.path:undefined};}
  async function state(req){
    const now=Date.now(),s=req.session;
    const clients=[...devices.values()].map(d=>({id:d.id,name:d.name,platform:d.platform,type:d.type,online:now-d.lastSeen<20000,ip:d.ip,self:d.id===s.id}));
    library.refresh();
    const hosts=[...discovery.peers.values()].map(p=>({id:`host:${p.id}`,name:p.name,platform:p.platform,type:'host',online:now-p.lastSeen<25000||options.discovery===false,ip:p.ip,url:p.url,paired:true}));
    const records=[...uploads.values()].filter(u=>req.admin||u.owner===s.id||u.targetId===s.id).map(u=>({id:u.id,name:u.name,size:u.size,received:u.received,localSource:!!u.localSource,targetId:u.targetId,relativePath:u.relativePath,deliveredBytes:u.deliveredBytes||0,phase:u.phase,targetUrl:u.targetUrl,canRetry:(req.admin||u.owner===s.id)&&u.received===u.size&&u.status==='error',status:u.status,direction:u.localSource||u.owner===s.id||req.admin&&u.targetId!=='server'?'outgoing':'incoming',from:u.from,to:u.to,createdAt:u.createdAt,error:u.error}));
    const ownInbox=[...inbox.values()].filter(item=>item.targetId==='server'||item.targetId===s.id||req.admin).map(({file,source,owner,targetId,...item})=>({...item,url:`/api/inbox/${item.id}/download?token=${s.token}`}));
    return {server:serverInfo(),devices:[...clients,...hosts],transfers:records.sort((a,b)=>b.createdAt-a.createdAt).slice(0,200),inbox:ownInbox.sort((a,b)=>b.createdAt-a.createdAt),shares:[...config.shares.map(sh=>({...shareView(sh,req.admin),sourceName:config.name})),...library.remoteShares()],fileLinks:req.admin?await fileLinks.views():undefined,stats,urls:lanUrls(config.port),downloadDir:req.admin?config.downloadDir:undefined};
  }
  app.use((req,res,next)=>{
    res.set({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'SAMEORIGIN'});
    if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store');
    try{if(req.method!=='GET'&&req.method!=='HEAD'&&req.method!=='OPTIONS')checkOrigin(req);if(req.path==='/api/bootstrap')checkOrigin(req);next();}catch(e){next(e);}
  });
  app.use(express.json({limit:'64kb'}));
  fileLinks.attachPublic(app);
  library.attach(app);
  app.get('/api/health',(req,res)=>res.json({ok:true,version:VERSION,serverId:config.id}));
  app.get('/api/bootstrap',asyncRoute(async(req,res)=>{
    let s=sessions.get(bearer(req));
    if(!s||localAdminRequest(req)&&!s.admin)s=newSession(validDeviceId(req.query.deviceId)?String(req.query.deviceId):uuid(),req.query.name,req,localAdminRequest(req));
    if(s)touch(s,req);
    res.json(publicBootstrap(req,s));
  }));
  app.post('/api/pair',asyncRoute(async(req,res)=>{const s=newSession(req.body.deviceId,req.body.name,req,false);res.json({token:s.token,device:{id:s.id,name:s.name},server:serverInfo(),admin:false});notify();}));
  app.post('/api/peer/pair',(req,res)=>res.json({token:token(),server:serverInfo()}));
  app.post('/api/peer/receive',asyncRoute(async(req,res)=>{
    const name=safeFilename(req.query.name),relativePath=safeRelative(req.query.relativePath||name),size=Number(req.query.size);
    if(!Number.isSafeInteger(size)||size<0||size>MAX_SIZE)throw fail('文件大小无效或超过 50 GB');
    if(relativePath.split('/').at(-1)!==name)throw fail('文件路径与名称不一致');
    await availableSpace(tempDir,size);
    const id=uuid(),file=path.join(tempDir,`${id}.part`);let received=0;
    const sourceName=cleanName(decodeHeader(req.headers['x-linkwave-name']),'局域网设备');
    const u={id,name,size,relativePath,targetId:'server',owner:`peer:${id}`,from:sourceName,to:config.name,createdAt:Date.now(),received:0,status:'uploading',file};uploads.set(id,u);notify();
    const meter=new Transform({transform(chunk,enc,cb){received+=chunk.length;if(received>size)return cb(fail('数据超过声明大小',413));u.received=received;cb(null,chunk);}});
    try{await pipeline(req,meter,fs.createWriteStream(file,{flags:'wx'}));if(received!==size)throw fail('文件数据不完整');await finalizeLocal(u);res.status(201).json({id,status:'complete',received:size});}catch(e){uploads.delete(id);await fsp.rm(file,{force:true});notify();throw e;}
  }));
  app.use('/api',auth);
  fileLinks.attachAdmin(app,admin);
  app.get('/api/state',asyncRoute(async(req,res)=>{touch(req.session,req);res.json(await state(req));}));
  app.post('/api/heartbeat',(req,res)=>{touch(req.session,req);res.json({ok:true});});
  app.post('/api/device',asyncRoute(async(req,res)=>{req.session.name=cleanName(req.body.name);touch(req.session,req);await saveState();notify();res.json({id:req.session.id,name:req.session.name});}));
  app.post('/api/open-inbox',admin,(req,res,next)=>{
    if(process.platform!=='win32')return next(fail('请打开接收目录 '+config.downloadDir,501));
    const child=spawn('explorer.exe',[config.downloadDir],{detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();res.json({ok:true,downloadDir:config.downloadDir});
  });
  app.get('/api/qr',asyncRoute(async(req,res)=>{const base=lanUrls(config.port)[0]||`http://127.0.0.1:${config.port}`;res.type('png').send(await qrcode.toBuffer(`${base}/`,{width:360,margin:2,errorCorrectionLevel:'M'}));}));
  app.post('/api/peers/pair',admin,asyncRoute(async(req,res)=>{
    const id=String(req.body.id||'').replace(/^host:/,''),peer=discovery.peers.get(id);if(!peer)throw fail('设备已离线，请刷新后重试',404);
    res.json({id:`host:${id}`,paired:true});
  }));
  function uploadOf(req){const u=uploads.get(req.params.id);if(!u)throw fail('传输任务不存在',404);if(u.owner!==req.session.id&&!req.admin)throw fail('无法操作其他设备的传输',403);return u;}
  function targetName(id){return id==='server'?config.name:id.startsWith('host:')?discovery.peers.get(id.slice(5))?.name:devices.get(id)?.name;}
  app.post('/api/pick-send-files',admin,asyncRoute(pickSendFiles));
  app.post('/api/local-transfers',admin,asyncRoute(async(req,res)=>{
    const targetId=String(req.body.targetId||'');const to=targetName(targetId);if(!to)throw fail('请先选择接收设备',404);
    const result=await scanLocalPaths(req.body.paths),created=[];
    for(const file of result.files){
      try{safeFilename(file.name);safeRelative(file.relativePath);}catch(error){result.skipped.push({path:file.path,error:error.message});continue;}
      const u={id:uuid(),name:file.name,size:file.size,relativePath:file.relativePath,source:file.source,localSource:true,file:file.path,targetId,owner:req.session.id,from:config.name,to,createdAt:Date.now(),received:file.size,deliveredBytes:0,status:'queued',phase:'queued',busy:false};
      uploads.set(u.id,u);created.push({id:u.id,name:u.name,size:u.size,status:'queued',targetId,to,relativePath:u.relativePath,localSource:true});
    }
    await saveState();notify();res.status(201).json({transfers:created,skipped:result.skipped});setImmediate(runLocalQueue);
  }));
  app.post('/api/uploads',asyncRoute(async(req,res)=>{
    const name=safeFilename(req.body.name),size=Number(req.body.size),relativePath=safeRelative(req.body.relativePath||name),targetId=String(req.body.targetId||'server');
    if(!Number.isSafeInteger(size)||size<0||size>MAX_SIZE)throw fail('文件大小无效或超过 50 GB');
    if(relativePath.split('/').at(-1)!==name)throw fail('文件路径与名称不一致');
    const to=targetName(targetId);if(!to)throw fail('目标设备不存在',404);
    const prior=[...uploads.values()].find(u=>u.owner===req.session.id&&u.name===name&&u.size===size&&u.relativePath===relativePath&&u.targetId===targetId&&u.lastModified===(req.body.lastModified||0)&&u.status==='uploading');
    if(prior)return res.json({id:prior.id,offset:prior.received,chunkSize:CHUNK_SIZE});
    await availableSpace(tempDir,size);
    const id=uuid(),file=path.join(tempDir,`${id}.part`);await fsp.writeFile(file,'',{flag:'wx'});
    const u={id,name,size,relativePath,targetId,owner:req.session.id,from:req.session.name,to,createdAt:Date.now(),received:0,status:'uploading',lastModified:req.body.lastModified||0,file,busy:false};uploads.set(id,u);await saveState();notify();res.status(201).json({id,offset:0,chunkSize:CHUNK_SIZE});
  }));
  app.get('/api/uploads/:id',(req,res,next)=>{try{const u=uploadOf(req);res.json({id:u.id,offset:u.received,size:u.size,status:u.status});}catch(e){next(e);}});
  app.put('/api/uploads/:id',asyncRoute(async(req,res)=>{
    const u=uploadOf(req),offset=Number(req.query.offset);if(u.status!=='uploading')throw fail('该任务已结束，不能继续上传',409);
    if(u.localSource)throw fail('原文件任务直接发送，不接受上传',409);
    if(!Number.isSafeInteger(offset)||offset!==u.received)throw fail('上传位置不一致，请恢复任务',409,{offset:u.received});
    if(u.busy)throw fail('此文件正在上传另一分块',409,{offset:u.received});
    const length=Number(req.headers['content-length']);if(req.headers['content-length']&&(!Number.isSafeInteger(length)||length>CHUNK_SIZE||offset+length>u.size))throw fail('分块大小超出限制',413);
    u.busy=true;let received=0;
    const meter=new Transform({transform(chunk,enc,cb){received+=chunk.length;if(received>CHUNK_SIZE||offset+received>u.size)return cb(fail('分块大小超出限制',413));cb(null,chunk);}});
    try{await pipeline(req,meter,fs.createWriteStream(u.file,{flags:'r+',start:offset}));u.received=offset+received;await saveState();notify();res.json({offset:u.received});}
    catch(e){await fsp.truncate(u.file,offset).catch(()=>{});throw e;}
    finally{u.busy=false;}
  }));
  async function finalizeLocal(u){
    const final=path.join(config.downloadDir,u.id,...u.relativePath.split('/'));await fsp.mkdir(path.dirname(final),{recursive:true});
    try{await fsp.rename(u.file,final);}catch(e){if(e.code!=='EXDEV')throw e;await fsp.copyFile(u.file,final,fs.constants.COPYFILE_EXCL);await fsp.unlink(u.file);}
    u.file=final;u.status='complete';u.received=u.size;
    inbox.set(u.id,{id:u.id,name:u.name,size:u.size,relativePath:u.relativePath,from:u.from,createdAt:Date.now(),file:final,owner:u.owner,targetId:u.targetId});
    stats.receivedBytes+=u.size;if(!String(u.owner).startsWith('peer:'))stats.sentBytes+=u.size;
    await saveState();notify();console.log(`  已收到：${u.name}，保存到 ${final}`);
  }
  const outgoing=new Map();
  let localQueueRunning=false;
  async function publishLocalSource(u){
    await validateLocalSource(u);
    if(uploads.get(u.id)!==u||u.status!=='sending')return;
    inbox.set(u.id,{id:u.id,name:u.name,size:u.size,relativePath:u.relativePath,from:u.from,createdAt:Date.now(),file:u.file,source:u.source,localSource:true,owner:u.owner,targetId:u.targetId});
    u.status='complete';u.phase='complete';u.deliveredBytes=u.size;u.error=undefined;
    if(u.targetId!=='server')stats.sentBytes+=u.size;
    await saveState();notify();
  }
  async function runLocalQueue(){
    if(localQueueRunning||closing)return;localQueueRunning=true;
    try{while(!closing){const u=[...uploads.values()].find(item=>item.localSource&&item.status==='queued');if(!u)break;
      u.status='sending';u.phase='connecting';u.error=undefined;await saveState();notify();
      try{if(u.targetId.startsWith('host:'))await sendPeer(u);else await publishLocalSource(u);}catch(error){u.status='error';u.phase=error.status===499?'paused':'error';u.error=cleanName(error.message,'发送失败');await saveState();notify();}
    }}finally{localQueueRunning=false;}
  }
  async function sendPeer(u){
    if(u.localSource)await validateLocalSource(u);
    const peer=discovery.peers.get(u.targetId.slice(5));
    if(!peer)throw fail('目标主机已离线');
    const controller=new AbortController();let finish;controller.finished=new Promise(resolve=>finish=resolve);outgoing.set(u.id,controller);
    try {
      await sendChunks(u,peer,config,controller,async changes=>{Object.assign(u,changes);await saveState();notify();});
      if(!u.localSource)await fsp.unlink(u.file);u.status='complete';u.phase='complete';u.error=undefined;stats.sentBytes+=u.size;uploads.delete(u.id);uploads.set(u.id,{...u,file:u.localSource?u.file:'',completedAt:Date.now()});await saveState();notify();
    } finally{outgoing.delete(u.id);finish();}
  }
  app.post('/api/uploads/:id/complete',asyncRoute(async(req,res)=>{
    const u=uploadOf(req);if(u.busy)throw fail('请等待当前分块完成',409);if(u.status==='complete')return res.json({id:u.id,status:'complete'});if(u.status==='sending')return res.json({id:u.id,status:'sending'});
    if(u.localSource){
      try{await validateLocalSource(u);}catch(error){u.status='error';u.phase='error';u.error=error.message;await saveState();notify();throw error;}
      u.status='queued';u.phase='queued';u.error=undefined;await saveState();notify();res.json({id:u.id,status:'queued',localSource:true});setImmediate(runLocalQueue);return;
    }
    if(u.received!==u.size)throw fail('文件尚未上传完整',409,{offset:u.received});
    u.busy=true;
    try {
    if(u.targetId.startsWith('host:')) {
      u.status='sending';u.error=undefined;await saveState();notify();res.json({id:u.id,status:'sending'});
      sendPeer(u).catch(async e=>{u.status='error';u.error=cleanName(e.message,'发送失败');await saveState();notify();});
    }else{await finalizeLocal(u);res.json({id:u.id,status:'complete'});}
    }finally{u.busy=false;}
  }));
  app.delete('/api/uploads/:id',asyncRoute(async(req,res)=>{
    const u=uploadOf(req);
    if(u.localSource){if(u.status==='sending'){const controller=outgoing.get(u.id);controller?.abort();if(controller?.finished)await controller.finished;}uploads.delete(u.id);inbox.delete(u.id);await saveState();notify();res.json({ok:true});return;}
    if(u.busy)throw fail('请先暂停传输',409);if(u.status==='complete')throw fail('已完成的文件请从收件箱删除',409);if(u.status==='sending')throw fail('正在发送至主机，请稍后重试',409);
    await fsp.rm(u.file,{force:true});uploads.delete(u.id);await saveState();notify();res.json({ok:true});
  }));
  app.post('/api/uploads/:id/pause',asyncRoute(async(req,res)=>{
    const u=uploadOf(req);if(u.status!=='sending'&&!(u.localSource&&u.status==='queued'))throw fail('文件当前没有转送',409);
    const controller=outgoing.get(u.id);controller?.abort();
    if(controller?.finished)await controller.finished;
    u.status='error';u.phase='paused';u.error='已暂停，点击继续发送';await saveState();notify();res.json({ok:true,status:'error'});
  }));
  function inboxOf(req){const item=inbox.get(req.params.id);if(!item)throw fail('文件不存在或已删除',404);if(item.targetId!=='server'&&item.targetId!==req.session.id&&!req.admin)throw fail('文件不属于当前设备',403);return item;}
  app.get('/api/inbox/:id/download',asyncRoute(async(req,res)=>{const item=inboxOf(req);const opened=item.localSource?await openLocalSource({...item,size:item.size}):null;await serveFile(req,res,item.file,item.name,true,opened);}));
  app.delete('/api/inbox/:id',asyncRoute(async(req,res)=>{
    const item=inboxOf(req);if(!req.admin&&item.targetId==='server'&&item.owner!==req.session.id)throw fail('只有发送者或服务主机可以删除公共收件文件',403);
    if(!item.localSource)await fsp.rm(item.file,{force:true});inbox.delete(item.id);uploads.delete(item.id);await saveState();notify();res.json({ok:true});
  }));
  function getShare(req){const sh=config.shares.find(sh=>sh.id===req.params.id);if(!sh)throw fail('共享文件夹不存在',404);return sh;}
  app.post('/api/shares',admin,asyncRoute(async(req,res)=>{
    if(!req.body.path||!path.isAbsolute(String(req.body.path)))throw fail('请输入文件夹的完整绝对路径');
    const root=await fsp.realpath(String(req.body.path)).catch(()=>{throw fail('文件夹不存在',404);});if(!(await fsp.stat(root)).isDirectory())throw fail('只能共享文件夹');
    const old=config.shares.find(sh=>sh.path.toLowerCase()===root.toLowerCase());if(old)return res.json(shareView(old,true));
    const sh={id:uuid(),name:cleanName(req.body.name||path.basename(root)||root),path:root};config.shares.push(sh);await saveConfig();notify();res.status(201).json(shareView(sh,true));
  }));
  app.delete('/api/shares/:id',admin,asyncRoute(async(req,res)=>{getShare(req);config.shares=config.shares.filter(sh=>sh.id!==req.params.id);await saveConfig();notify();res.json({ok:true});}));
  app.get('/api/shares/:id/browse',asyncRoute(async(req,res)=>{const sh=getShare(req),relative=safeRelative(req.query.path||'');res.json(await browse(sh.path,relative,sh));}));
  app.get('/api/shares/:id/subtitles',asyncRoute(async(req,res)=>{const sh=getShare(req);res.json(await discoverSubtitles(sh.path,req.query.path||''));}));
  app.get('/api/shares/:id/subtitle',asyncRoute(async(req,res)=>{const sh=getShare(req),format=req.query.format||'vtt';if(!['raw','vtt'].includes(format))throw fail('字幕输出格式无效');res.set({'Content-Type':format==='raw'?'text/plain; charset=utf-8':'text/vtt; charset=utf-8','Content-Security-Policy':"sandbox; default-src 'none'"}).send(await readSubtitle(sh.path,req.query.path||'',format));}));
  app.get('/api/shares/:id/file',asyncRoute(async(req,res)=>{const sh=getShare(req),target=await resolveShared(sh.path,req.query.path||'');await serveFile(req,res,target.filename,path.basename(target.filename),false);}));
  app.get('/api/shares/:id/download',asyncRoute(async(req,res)=>{const sh=getShare(req),relative=safeRelative(req.query.path||'');const target=await resolveShared(sh.path,relative);if(target.stat.isDirectory())await streamZip(req,res,sh.path,relative,path.basename(target.filename)||sh.name);else await serveFile(req,res,target.filename,path.basename(target.filename),true);}));
  app.post('/api/pick-folder',admin,asyncRoute(async(req,res)=>{
    if(process.platform!=='win32')throw fail('此系统请直接输入文件夹路径',501);
    const script="Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'LinkWave - Select folder'; $dialog.ShowNewFolderButton = $false; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; [Console]::Write($dialog.SelectedPath) }";
    const encoded=Buffer.from(script,'utf16le').toString('base64');
    const selection=await new Promise((resolve,reject)=>{const child=spawn('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-EncodedCommand',encoded],{windowsHide:true});let out='',err='';child.stdout.setEncoding('utf8');child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);child.on('error',reject);child.on('exit',code=>code===0?resolve(out):reject(fail(`无法打开目录选择器：${err.slice(0,300)}`,500)));res.on('close',()=>{if(!res.writableEnded)child.kill();});});res.json({path:selection||null});
  }));
  app.post('/api/pick-file',admin,asyncRoute(async(req,res)=>{
    if(process.platform!=='win32')throw fail('此系统请直接输入文件的完整路径',501);
    const script="Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title = 'LinkWave - Select a file to share'; $dialog.Filter = 'All files (*.*)|*.*'; $dialog.CheckFileExists = $true; $dialog.Multiselect = $false; $dialog.RestoreDirectory = $true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; [Console]::Write($dialog.FileName) }";
    const encoded=Buffer.from(script,'utf16le').toString('base64');
    const selected=await new Promise((resolve,reject)=>{
      // Hide only the helper console; the native file dialog remains interactive.
      const child=spawn('powershell.exe',['-NoProfile','-STA','-EncodedCommand',encoded],{windowsHide:true});let out='',err='';
      child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);child.on('error',reject);
      child.on('exit',code=>code===0?resolve(out):reject(fail(`无法打开文件选择器：${err.slice(0,300)}`,500)));
      res.on('close',()=>{if(!res.writableEnded)child.kill();});
    });
    if(!selected)return res.json({path:null});
    const stat=await fsp.stat(selected);if(!stat.isFile())throw fail('请选择单个文件');
    res.json({path:selected,name:path.basename(selected),size:stat.size});
  }));
  app.patch('/api/settings',admin,asyncRoute(async(req,res)=>{
    const changes={};
    if(req.body.name!==undefined)changes.name=cleanName(req.body.name);
    if(req.body.downloadDir!==undefined){if(!path.isAbsolute(String(req.body.downloadDir)))throw fail('接收目录需要使用完整绝对路径');const directory=path.resolve(String(req.body.downloadDir));await fsp.mkdir(directory,{recursive:true});await fsp.access(directory,fs.constants.W_OK);changes.downloadDir=directory;}
    Object.assign(config,changes);
    await saveConfig();discovery.announce();notify();res.json(publicBootstrap(req,req.session));
  }));
  app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在'}));
  const publicDir=path.join(__dirname,'..','public');
  app.use(express.static(publicDir,{etag:true,maxAge:0,setHeaders(res,filename){res.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; child-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: blob:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");if(filename.endsWith('sw.js'))res.set('Cache-Control','no-cache');}}));
  app.get('/',(req,res)=>res.sendFile(path.join(publicDir,'index.html')));
  app.use((err,req,res,next)=>{
    if(res.headersSent){if(!res.destroyed)res.destroy(err);return;}
    let status=err.status||500;if(err.type==='entity.parse.failed')status=400;if(err.code==='ENOENT')status=404;if(err.code==='EACCES'||err.code==='EPERM')status=403;
    if(status>=500)console.error('请求失败：',err.message);
    res.status(status).json({error:status>=500&&!err.status?'操作失败，请检查目录权限或稍后重试':err.message,offset:err.offset});
  });
  server.on('upgrade',(req,socket,head)=>{
    try{const parsed=new URL(req.url,`http://${req.headers.host}`);if(parsed.pathname!=='/ws')throw fail('Not found');req.query=Object.fromEntries(parsed.searchParams);checkOrigin(req);const s=sessions.get(bearer(req));if(!s)throw fail('Unauthorized');wss.handleUpgrade(req,socket,head,ws=>{sockets.set(ws,s);touch(s,req);wss.emit('connection',ws,req);});}catch{socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');socket.destroy();}
  });
  wss.on('connection',ws=>{ws.send('{"type":"state"}');ws.on('close',()=>sockets.delete(ws));ws.on('error',()=>{});ws.on('message',()=>{});});
  async function start(){
    if(started)return result;
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,options.host||process.env.LINKWAVE_HOST||'0.0.0.0',()=>{server.off('error',reject);resolve();});});
    config.port=server.address().port;started=true;await saveConfig();await saveState();discovery.start();library.start();
    stateTimer=setInterval(()=>{let changed=false;const now=Date.now();for(const d of devices.values())if(d.online&&now-d.lastSeen>20000){d.online=false;changed=true;}for(const [ws,s] of sockets)if(ws.readyState===WebSocket.OPEN){const d=devices.get(s.id);if(d){d.lastSeen=now;d.online=true;}}if(changed)notify();},5000);stateTimer.unref();
    return result;
  }
  async function close(){
    if(closing)return;closing=true;clearInterval(stateTimer);library.close();discovery.close();for(const controller of outgoing.values())controller.abort();for(const client of wss.clients)client.terminate();wss.close();
    if(started)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();});await saveState();await persistTail;
  }
  // Remove abandoned partial files without touching completed receive folders.
  for(const entry of await fsp.readdir(tempDir,{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith('.part')&&!uploads.has(entry.name.slice(0,-5)))await fsp.rm(path.join(tempDir,entry.name),{force:true}).catch(()=>{});
  const result={app,server,start,close,config,discovery};return result;
}

function parseArgs(args){
  const values={};for(let i=0;i<args.length;i++){const arg=args[i];if(arg==='--no-open')values.noOpen=true;else if(arg==='--lan')values.lan=true;else if(['--port','--data-dir','--host','--name'].includes(arg)){const value=args[++i];if(!value)throw new Error(`${arg} 缺少参数`);values[arg==='--data-dir'?'dataDir':arg.slice(2)]=arg==='--port'?Number(value):value;}else if(arg==='--help'||arg==='-h')values.help=true;else throw new Error(`未知参数 ${arg}`);}return values;
}
async function main(){
  const options=parseArgs(process.argv.slice(2));if(options.help){console.log('邻波 LinkWave\n用法: LinkWave.exe [--port 53317] [--data-dir "D:\\LinkWave-data"] [--name "我的电脑"] [--no-open]\nNode: node server/index.js [相同参数]');return;}
  const instance=await createApp(options);
  try{await instance.start();}catch(e){if(e.code==='EADDRINUSE'){
    const url=`http://127.0.0.1:${instance.config.port}`;
    try{const response=await fetch(`${url}/api/health`,{signal:AbortSignal.timeout(1500)});const info=await response.json();if(info.ok&&info.serverId===instance.config.id){console.log(`邻波已经运行，本机管理地址：${url}`);if(!options.noOpen&&process.env.LINKWAVE_NO_OPEN!=='1'){nativeBrowser(url);if(options.lan)await ensureWindowsLan(instance.config.port);}return;}}catch{}
    console.error(`端口 ${instance.config.port} 已被其他程序占用，请关闭该程序，或使用 --port 指定其他端口。`);process.exitCode=1;return;
  }throw e;}
  const config=instance.config;
  console.log(`\n  邻波 LinkWave v${VERSION}\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  本机管理：http://127.0.0.1:${config.port}\n${lanUrls(config.port).map(url=>`  局域网：  ${url}`).join('\n')}\n  直连模式：同一局域网打开即用，无需配对\n  接收目录：${config.downloadDir}\n  按 Ctrl+C 安全退出。\n`);
  if(!options.noOpen&&process.env.LINKWAVE_NO_OPEN!=='1')nativeBrowser(`http://127.0.0.1:${config.port}`);
  let quitting=false;const quit=async()=>{if(quitting)return;quitting=true;console.log('\n正在保存状态并退出…');await instance.close();process.exit(0);};process.on('SIGINT',quit);process.on('SIGTERM',quit);
  if(options.lan&&!options.noOpen&&process.env.LINKWAVE_NO_OPEN!=='1')await ensureWindowsLan(config.port);
}
if(require.main===module)main().catch(e=>{console.error(`启动失败：${e.message}`);process.exitCode=1;});
module.exports={createApp,parseArgs,DEFAULT_PORT};

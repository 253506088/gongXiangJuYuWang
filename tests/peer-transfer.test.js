'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {createApp}=require('../server/index');
const {sendChunks}=require('../server/peer-transfer');
const {CHUNK_SIZE}=require('../server/util');

const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function request(base,route,token,method='GET',body,extra={}){
  const headers={...(token?{Authorization:'Bearer '+token}:{}),...extra};
  if(body!==undefined){
    if(!Buffer.isBuffer(body)){body=Buffer.from(JSON.stringify(body));headers['Content-Type']='application/json';}
    else headers['Content-Type']='application/octet-stream';
    headers['Content-Length']=body.length;
  }
  return new Promise((resolve,reject)=>{
    const req=http.request(base+route,{method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{
        const bytes=Buffer.concat(chunks);
        try{resolve({status:res.statusCode,bytes,data:String(res.headers['content-type']).includes('json')&&bytes.length?JSON.parse(bytes):undefined});}catch(error){reject(error);}
      });
    });req.on('error',reject);req.end(body);
  });
}
async function waitFor(read,accept,message,timeout=5000){
  const until=Date.now()+timeout;let value;
  do{value=await read();if(accept(value))return value;await delay(25);}while(Date.now()<until);
  assert.fail(message+': '+JSON.stringify(value));
}
async function stage(base,token,name,bytes,targetId){
  const created=await request(base,'/api/uploads',token,'POST',{name,size:bytes.length,targetId});
  assert.equal(created.status,201,JSON.stringify(created.data));assert.equal(created.data.chunkSize,CHUNK_SIZE);
  for(let offset=0;offset<bytes.length;offset+=CHUNK_SIZE){
    const chunk=await request(base,`/api/uploads/${created.data.id}?offset=${offset}`,token,'PUT',bytes.subarray(offset,offset+CHUNK_SIZE));
    assert.equal(chunk.status,200,JSON.stringify(chunk.data));assert.equal(chunk.data.offset,Math.min(bytes.length,offset+CHUNK_SIZE));
  }
  return created.data;
}

// Both upload endpoints are real Node hosts. Only the receiver's HTTP replies
// are controlled, so recovery must use the receiver's actual persisted offset.
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'linkwave-chunks-'));
  const receiver=await createApp({dataDir:path.join(directory,'receiver'),port:0,host:'127.0.0.1',discovery:false,name:'真实分块接收主机'});
  await receiver.start();
  const receiverBase='http://127.0.0.1:'+receiver.config.port,trace=[],stored=deferred();
  let mode='pass',controlledOffset=0;
  const proxy=http.createServer((req,res)=>{
    const url=new URL(req.url,receiverBase),entry={method:req.method,path:url.pathname,offset:url.searchParams.has('offset')?Number(url.searchParams.get('offset')):undefined,length:Number(req.headers['content-length'])||0};
    trace.push(entry);
    if(req.method==='PUT'&&mode==='timeout'){
      req.resume();return;
    }
    // A LAN receiver creates a device session, unlike a localhost admin tab.
    const upstream=http.request(url,{method:req.method,headers:{...req.headers,host:'192.168.44.3:'+receiver.config.port}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>{
        const body=Buffer.concat(chunks);entry.status=response.statusCode;
        if(String(response.headers['content-type']).includes('json'))entry.data=JSON.parse(body);
        if(req.method==='PUT'&&entry.offset===controlledOffset&&(mode==='lose-ack'||mode==='pause')){
          const action=mode;mode='pass';stored.resolve(entry);
          if(action==='lose-ack')res.destroy();
          return;
        }
        if(!res.destroyed){res.writeHead(response.statusCode,response.headers);res.end(body);}
      });
      response.on('error',()=>res.destroy());
    });
    upstream.on('error',()=>res.destroy());req.pipe(upstream);
    res.on('close',()=>upstream.destroy());
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const proxyBase='http://127.0.0.1:'+proxy.address().port;
  let sender=await createApp({dataDir:path.join(directory,'sender'),port:0,host:'127.0.0.1',discovery:false,name:'Windows分块发送主机'});
  await sender.start();
  let senderBase='http://127.0.0.1:'+sender.config.port;
  const admin=(await request(senderBase,'/api/bootstrap?deviceId='+crypto.randomUUID())).data;
  assert.equal((await request(senderBase,'/api/peers/connect',null,'POST',{url:proxyBase})).status,200);
  const receiverAdmin=(await request(receiverBase,'/api/bootstrap?deviceId='+crypto.randomUUID())).data;
  t.after(async()=>{
    await sender.close();
    proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));
    await receiver.close();await fs.rm(directory,{recursive:true,force:true});
  });
  return {
    directory,receiver,receiverBase,receiverAdmin,trace,admin,stored,
    get sender(){return sender;},get senderBase(){return senderBase;},
    control(action,offset=0){mode=action;controlledOffset=offset;},
    async state(token=admin.token){const result=await request(senderBase,'/api/state',token);assert.equal(result.status,200);return result.data;},
    async restart(){await sender.close();sender=await createApp({dataDir:path.join(directory,'sender'),port:0,host:'127.0.0.1',discovery:false});await sender.start();senderBase='http://127.0.0.1:'+sender.config.port;},
    async received(name){return waitFor(async()=>(await request(receiverBase,'/api/state',receiverAdmin.token)).data,s=>s.inbox.some(file=>file.name===name),'接收主机没有落盘');}
  };
}
async function verifyCompleted(f,task,bytes,token=f.admin.token){
  const state=await waitFor(()=>f.state(token),s=>s.transfers.some(item=>item.id===task.id&&item.status==='complete'),'发送任务没有收到远端完成确认');
  const transfer=state.transfers.find(item=>item.id===task.id);
  assert.equal(transfer.received,bytes.length);assert.equal(transfer.deliveredBytes,bytes.length);assert.equal(transfer.phase,'complete');assert.equal(transfer.canRetry,false);
  const received=await f.received(transfer.name),inbox=received.inbox.find(item=>item.name===transfer.name);
  assert.equal(digest((await request(f.receiverBase,inbox.url)).bytes),digest(bytes));
  assert.equal(digest(await fs.readFile(path.join(f.receiver.config.downloadDir,inbox.id,...inbox.relativePath.split('/')))),digest(bytes));
  assert.equal(state.stats.sentBytes,bytes.length);assert.equal(received.stats.receivedBytes,bytes.length);
  await assert.rejects(fs.access(path.join(f.sender.config.dataDir,'uploads',task.id+'.part')),{code:'ENOENT'});
  const senderMeta=JSON.parse(await fs.readFile(path.join(f.sender.config.dataDir,'state.json'),'utf8')).uploads.find(item=>item.id===task.id);
  assert.equal(senderMeta.remoteUpload.id,inbox.id);assert.equal(senderMeta.remoteUpload.serverId,f.receiver.config.id);assert.equal(senderMeta.deliveredBytes,bytes.length);
  assert.ok(!f.trace.some(entry=>entry.path.startsWith('/api/peer/')),'主机发送仍调用了旧式单次传输接口');
  assert.equal((await request(f.senderBase,`/api/uploads/${task.id}/complete`,token,'POST',{})).data.status,'complete');
  assert.equal((await f.state(token)).stats.sentBytes,bytes.length);
  return state;
}

test('Windows多分块互传：真实接收主机已落盘但中途ACK丢失，通过GET恢复且不重复发块',{timeout:15000},async t=>{
  const f=await fixture(t),bytes=crypto.randomBytes(CHUNK_SIZE*3+239);
  f.control('lose-ack',CHUNK_SIZE);
  const task=await stage(f.senderBase,f.admin.token,'中途ACK丢失.bin',bytes,'host:'+f.receiver.config.id);
  assert.equal((await request(f.senderBase,`/api/uploads/${task.id}/complete`,f.admin.token,'POST',{})).data.status,'sending');
  await verifyCompleted(f,task,bytes);
  const puts=f.trace.filter(entry=>entry.method==='PUT');
  assert.deepEqual(puts.map(entry=>entry.offset),[0,CHUNK_SIZE,CHUNK_SIZE*2,CHUNK_SIZE*3]);
  assert.ok(puts.every(entry=>entry.length<=CHUNK_SIZE));
  const lostIndex=f.trace.indexOf(puts[1]);
  assert.equal(f.trace[lostIndex+1].method,'GET');assert.equal(f.trace[lostIndex+1].data.offset,CHUNK_SIZE*2);
  assert.equal(f.trace.filter(entry=>entry.path==='/api/uploads'&&entry.method==='POST').length,1);
});

test('Windows发送暂停后保留源与远端断点，重启后新管理员可继续旧后台任务',{timeout:15000},async t=>{
  const f=await fixture(t),bytes=crypto.randomBytes(CHUNK_SIZE*2+239);
  f.control('pause',CHUNK_SIZE);
  const task=await stage(f.senderBase,f.admin.token,'后台暂停续传.bin',bytes,'host:'+f.receiver.config.id);
  assert.equal((await request(f.senderBase,`/api/uploads/${task.id}/complete`,f.admin.token,'POST',{})).data.status,'sending');
  const stored=await f.stored.promise;assert.equal(stored.data.offset,CHUNK_SIZE*2);
  const paused=await request(f.senderBase,`/api/uploads/${task.id}/pause`,f.admin.token,'POST',{});
  assert.equal(paused.status,200);assert.equal(paused.data.status,'error');
  const failed=await waitFor(()=>f.state(),s=>s.transfers.some(item=>item.id===task.id&&item.status==='error'&&item.phase==='paused'),'暂停后状态未保存');
  const item=failed.transfers.find(item=>item.id===task.id);
  assert.equal(item.deliveredBytes,CHUNK_SIZE);assert.equal(item.canRetry,true);assert.equal(failed.stats.sentBytes,0);
  assert.equal(digest(await fs.readFile(path.join(f.sender.config.dataDir,'uploads',task.id+'.part'))),digest(bytes));
  const metadata=JSON.parse(await fs.readFile(path.join(f.sender.config.dataDir,'state.json'),'utf8')).uploads.find(item=>item.id===task.id);
  assert.equal(metadata.remoteUpload.serverId,f.receiver.config.id);assert.equal(metadata.deliveredBytes,CHUNK_SIZE);
  await f.restart();
  const newAdmin=(await request(f.senderBase,'/api/bootstrap?deviceId='+crypto.randomUUID())).data;
  assert.equal(newAdmin.admin,true);assert.notEqual(newAdmin.device.id,f.admin.device.id);
  assert.equal((await f.state(newAdmin.token)).transfers.find(item=>item.id===task.id).canRetry,true);
  const guest=(await request(f.senderBase,'/api/bootstrap?deviceId='+crypto.randomUUID(),null,'GET',undefined,{Host:'192.168.44.2:'+f.sender.config.port})).data;
  assert.equal((await request(f.senderBase,`/api/uploads/${task.id}/complete`,guest.token,'POST',{}, {Host:'192.168.44.2:'+f.sender.config.port})).status,403);
  assert.equal((await request(f.senderBase,`/api/uploads/${task.id}/complete`,newAdmin.token,'POST',{})).data.status,'sending');
  await verifyCompleted(f,task,bytes,newAdmin.token);
  assert.deepEqual(f.trace.filter(entry=>entry.method==='PUT').map(entry=>entry.offset),[0,CHUNK_SIZE,CHUNK_SIZE*2]);
  assert.equal(f.trace.filter(entry=>entry.path==='/api/uploads'&&entry.method==='POST').length,1);
});

test('Windows分块请求超时有限重试后报错，源文件保留并可恢复完成',{timeout:10000},async t=>{
  const nativeTimeout=AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal,'timeout',milliseconds=>nativeTimeout(milliseconds===90000?60:milliseconds));
  const f=await fixture(t),bytes=crypto.randomBytes(65539);
  f.control('timeout');
  const task=await stage(f.senderBase,f.admin.token,'连接超时可恢复.bin',bytes,'host:'+f.receiver.config.id);
  await request(f.senderBase,`/api/uploads/${task.id}/complete`,f.admin.token,'POST',{});
  const failed=await waitFor(()=>f.state(),s=>s.transfers.some(item=>item.id===task.id&&item.status==='error'),'超时任务未显示失败');
  const item=failed.transfers.find(item=>item.id===task.id);
  assert.match(item.error,/中断或超时/);assert.equal(item.canRetry,true);assert.equal(item.deliveredBytes,0);assert.equal(failed.stats.sentBytes,0);
  assert.deepEqual(await fs.readFile(path.join(f.sender.config.dataDir,'uploads',task.id+'.part')),bytes);
  assert.equal(f.trace.filter(entry=>entry.method==='PUT').length,3);
  assert.equal(f.trace.filter(entry=>entry.method==='GET'&&/^\/api\/uploads\//.test(entry.path)).length,2);
  f.control('pass');
  await request(f.senderBase,`/api/uploads/${task.id}/complete`,f.admin.token,'POST',{});
  await verifyCompleted(f,task,bytes);
  assert.equal(f.trace.filter(entry=>entry.path==='/api/uploads'&&entry.method==='POST').length,1);
});

test('远端保存完成后Windows缓存清理失败可重试，发送统计只记账一次',{timeout:10000},async t=>{
  const f=await fixture(t),bytes=crypto.randomBytes(65539);
  const task=await stage(f.senderBase,f.admin.token,'缓存清理可重试.bin',bytes,'host:'+f.receiver.config.id);
  const sourceFile=path.join(f.sender.config.dataDir,'uploads',task.id+'.part'),unlink=fs.unlink.bind(fs);
  let cleanupFailed=false;
  t.mock.method(fs,'unlink',async filename=>{
    if(filename===sourceFile&&!cleanupFailed){cleanupFailed=true;throw Object.assign(new Error('缓存文件暂时被占用'),{code:'EACCES'});}
    return unlink(filename);
  });
  await request(f.senderBase,`/api/uploads/${task.id}/complete`,f.admin.token,'POST',{});
  const failed=await waitFor(()=>f.state(),s=>s.transfers.some(item=>item.id===task.id&&item.status==='error'),'缓存清理失败未显示可重试');
  assert.equal(cleanupFailed,true);assert.equal(failed.transfers.find(item=>item.id===task.id).canRetry,true);
  assert.equal(failed.stats.sentBytes,0,'失败任务不应预先记账');
  assert.deepEqual(await fs.readFile(sourceFile),bytes);
  await request(f.senderBase,`/api/uploads/${task.id}/complete`,f.admin.token,'POST',{});
  await verifyCompleted(f,task,bytes);
  assert.equal(f.trace.filter(entry=>entry.method==='PUT').length,1,'远端已保存完整，不应重复发送');
  assert.equal(f.trace.filter(entry=>entry.path==='/api/uploads'&&entry.method==='POST').length,1);
});

test('大于2GiB的稀疏文件使用安全整数断点，仅传输尾块且保留4MiB块上限',{timeout:10000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'linkwave-large-offset-')),filename=path.join(directory,'large.part');
  await fs.writeFile(filename,'');
  if(process.platform==='win32')execFileSync('fsutil.exe',['sparse','setflag',filename],{windowsHide:true,stdio:'pipe'});
  const offset=2*1024**3+CHUNK_SIZE+137,tail=crypto.randomBytes(65539),size=offset+tail.length;
  const file=await fs.open(filename,'r+');await file.truncate(size);await file.write(tail,0,tail.length,offset);await file.close();
  assert.equal((await fs.stat(filename)).size,size);
  const id=crypto.randomUUID(),remoteId=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex'),requests=[];
  const peer=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');requests.push({method:req.method,path:url.pathname,offset:url.searchParams.get('offset')});
    const json=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(url.pathname==='/api/health')return json({serverId:id});
    if(url.pathname==='/api/bootstrap')return json({token,server:{id}});
    assert.equal(req.headers.authorization,'Bearer '+token);
    if(req.method==='GET')return json({id:remoteId,offset,size,status:'uploading'});
    if(req.method==='PUT'){
      assert.equal(url.searchParams.get('offset'),String(offset));assert.ok(Number(req.headers['content-length'])<=CHUNK_SIZE);
      const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{assert.deepEqual(Buffer.concat(chunks),tail);json({offset:size});});return;
    }
    req.resume();json({id:remoteId,status:'complete'});
  });
  await new Promise(resolve=>peer.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{peer.closeAllConnections();await new Promise(resolve=>peer.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  const progress=[],upload={name:'超过2GiB.bin',size,relativePath:'超过2GiB.bin',file:filename,createdAt:Date.now(),deliveredBytes:offset,remoteUpload:{serverId:id,id:remoteId}};
  const done=await sendChunks(upload,{id,url:'http://127.0.0.1:'+peer.address().port},{id:crypto.randomUUID(),name:'大文件电脑'},new AbortController(),async value=>progress.push(value));
  assert.equal(done.status,'complete');assert.equal(progress.find(value=>value.phase==='sending').deliveredBytes,offset);assert.equal(progress.at(-1).deliveredBytes,size);
  assert.equal(requests.filter(entry=>entry.method==='PUT').length,1);assert.ok(!requests.some(entry=>entry.path==='/api/uploads'));
});

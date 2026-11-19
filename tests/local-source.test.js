'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const {createApp}=require('../server/index');
const {CHUNK_SIZE}=require('../server/util');

const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function request(base,endpoint,token,method='GET',body,extra={}){
  const headers={...(token?{Authorization:'Bearer '+token}:{}),...extra};
  if(body!==undefined){
    if(!Buffer.isBuffer(body)){body=Buffer.from(JSON.stringify(body));headers['Content-Type']='application/json';}
    else headers['Content-Type']='application/octet-stream';
    headers['Content-Length']=body.length;
  }
  return new Promise((resolve,reject)=>{
    const req=http.request(base+endpoint,{method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{
        const bytes=Buffer.concat(chunks);
        try{resolve({status:res.statusCode,headers:res.headers,bytes,data:String(res.headers['content-type']).includes('json')&&bytes.length?JSON.parse(bytes):undefined});}catch(error){reject(error);}
      });
    });req.on('error',reject);req.end(body);
  });
}
async function waitFor(read,accept,message,timeout=8000){
  const deadline=Date.now()+timeout;let value;
  do{value=await read();if(accept(value))return value;await delay(25);}while(Date.now()<deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'linkwave-local-source-'));
  const sourceDirectory=path.join(directory,'原文件 中文');await fs.mkdir(sourceDirectory);
  const receiver=await createApp({dataDir:path.join(directory,'receiver'),port:0,host:'127.0.0.1',discovery:false,name:'直接接收主机'});await receiver.start();
  const receiverBase='http://127.0.0.1:'+receiver.config.port,trace=[];
  let mode='pass',held=deferred();
  const proxy=http.createServer((req,res)=>{
    const url=new URL(req.url,receiverBase),entry={method:req.method,path:url.pathname,offset:url.searchParams.has('offset')?Number(url.searchParams.get('offset')):undefined,length:Number(req.headers['content-length'])||0};trace.push(entry);
    const upstream=http.request(url,{method:req.method,headers:{...req.headers,host:'192.168.44.3:'+receiver.config.port}},reply=>{
      const chunks=[];reply.on('data',chunk=>chunks.push(chunk));reply.on('end',()=>{
        const bytes=Buffer.concat(chunks);entry.status=reply.statusCode;
        if(String(reply.headers['content-type']).includes('json')&&bytes.length)entry.data=JSON.parse(bytes);
        if(req.method==='PUT'&&mode==='pause'){mode='pass';held.resolve(entry);return;}
        if(!res.destroyed){res.writeHead(reply.statusCode,reply.headers);res.end(bytes);}
      });reply.on('error',()=>res.destroy());
    });upstream.on('error',()=>res.destroy());req.pipe(upstream);res.on('close',()=>upstream.destroy());
  });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const peer={id:receiver.config.id,name:receiver.config.name,platform:'Windows',url:'http://127.0.0.1:'+proxy.address().port,lastSeen:Date.now()};
  let sender=await createApp({dataDir:path.join(directory,'sender'),port:0,host:'127.0.0.1',discovery:false,name:'原文件发送主机',peers:[peer]});await sender.start();
  let senderBase='http://127.0.0.1:'+sender.config.port;
  const admin=(await request(senderBase,'/api/bootstrap?deviceId='+crypto.randomUUID())).data;
  const receiverAdmin=(await request(receiverBase,'/api/bootstrap?deviceId='+crypto.randomUUID())).data;
  t.after(async()=>{await sender.close();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));await receiver.close();await fs.rm(directory,{recursive:true,force:true});});
  return {
    directory,sourceDirectory,receiver,receiverBase,receiverAdmin,trace,admin,peer,
    get sender(){return sender;},get senderBase(){return senderBase;},
    controlPause(){held=deferred();mode='pause';return held.promise;},
    async state(token=admin.token){const response=await request(senderBase,'/api/state',token);assert.equal(response.status,200,JSON.stringify(response.data));return response.data;},
    async receiverState(){return (await request(receiverBase,'/api/state',receiverAdmin.token)).data;},
    async metadata(){return JSON.parse(await fs.readFile(path.join(sender.config.dataDir,'state.json'),'utf8'));},
    async create(paths,targetId='host:'+receiver.config.id){
      const response=await request(senderBase,'/api/local-transfers',admin.token,'POST',{paths,targetId});
      assert.equal(response.status,201,JSON.stringify(response.data));assert.ok(Array.isArray(response.data.transfers));assert.ok(Array.isArray(response.data.skipped));
      for(const item of response.data.transfers){assert.equal(item.status,'queued');assert.equal(item.localSource,true);assert.equal(item.targetId,targetId);}
      return response.data;
    },
    async restart(){await sender.close();sender=await createApp({dataDir:path.join(directory,'sender'),port:0,host:'127.0.0.1',discovery:false,peers:[peer]});await sender.start();senderBase='http://127.0.0.1:'+sender.config.port;}
  };
}
async function assertOriginal(filename,bytes,before){
  const after=await fs.stat(filename);assert.equal(after.size,before.size);assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(digest(await fs.readFile(filename)),digest(bytes));
}
async function assertNoSourceCopy(f){assert.deepEqual((await fs.readdir(path.join(f.sender.config.dataDir,'uploads'))).filter(name=>name.endsWith('.part')),[],'本机原文件被复制到 uploads/*.part');}
async function complete(f,task,bytes,token=f.admin.token){
  const senderState=await waitFor(()=>f.state(token),s=>{
    const item=s.transfers.find(file=>file.id===task.id);assert.notEqual(item?.status,'error',JSON.stringify(item));return item?.status==='complete';
  },'原文件任务未自动发送并完成');
  const item=senderState.transfers.find(file=>file.id===task.id);
  assert.equal(item.localSource,true);assert.equal(item.received,bytes.length);assert.equal(item.deliveredBytes,bytes.length);assert.equal(item.phase,'complete');assert.equal(item.canRetry,false);
  const receiverState=await waitFor(()=>f.receiverState(),s=>s.inbox.some(file=>file.name===task.name&&file.relativePath===task.relativePath),'接收主机未保存原文件发送的数据');
  const matches=receiverState.inbox.filter(file=>file.name===task.name&&file.relativePath===task.relativePath);assert.equal(matches.length,1);
  const received=matches[0];assert.equal(received.size,bytes.length);assert.equal(digest((await request(f.receiverBase,received.url)).bytes),digest(bytes));
  assert.equal(digest(await fs.readFile(path.join(f.receiver.config.downloadDir,received.id,...received.relativePath.split('/')))),digest(bytes));
  await assertNoSourceCopy(f);return {senderState,receiverState,item,received};
}
async function pausedTask(f,filename){
  const stored=f.controlPause(),created=await f.create([filename]),task=created.transfers[0];
  const ack=await waitFor(()=>Promise.race([stored,delay(25).then(()=>null)]),Boolean,'真实接收主机未保存第一块');assert.equal(ack.data.offset,CHUNK_SIZE);
  const response=await request(f.senderBase,`/api/uploads/${task.id}/pause`,f.admin.token,'POST',{});assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.status,'error');
  const state=await waitFor(()=>f.state(),s=>s.transfers.some(file=>file.id===task.id&&file.status==='error'&&file.phase==='paused'),'原文件暂停状态未保存');
  const item=state.transfers.find(file=>file.id===task.id);assert.equal(item.localSource,true);assert.equal(item.received,item.size);assert.equal(item.canRetry,true);assert.equal(state.stats.sentBytes,0);
  await assertNoSourceCopy(f);return task;
}

test('本机原文件直接自动分块发送：原路径与元数据保留、不生成临时副本且双方只记账一次',{timeout:20000},async t=>{
  const f=await fixture(t),bytes=crypto.randomBytes(CHUNK_SIZE*3+239),filename=path.join(f.sourceDirectory,'原始 中文 & 空格.bin');await fs.writeFile(filename,bytes);const before=await fs.stat(filename);
  const created=await f.create([filename]);assert.deepEqual(created.skipped,[]);assert.equal(created.transfers.length,1);
  const task=created.transfers[0],result=await complete(f,task,bytes);
  await assertOriginal(filename,bytes,before);assert.equal(result.senderState.stats.sentBytes,bytes.length);assert.equal(result.senderState.stats.receivedBytes,0);assert.equal(result.receiverState.stats.receivedBytes,bytes.length);
  const meta=(await f.metadata()).uploads.find(file=>file.id===task.id);assert.equal(meta.localSource,true);assert.equal(meta.file,filename,'任务必须保留原文件引用');assert.equal(meta.received,bytes.length);
  const sourceStat=await fs.stat(filename,{bigint:true});for(const key of ['dev','ino','size','mtimeMs','birthtimeMs','mtimeNs']){assert.equal(typeof meta.source[key],'string');assert.equal(meta.source[key],String(sourceStat[key]));}
  assert.deepEqual(f.trace.filter(entry=>entry.method==='PUT').map(entry=>entry.offset),[0,CHUNK_SIZE,CHUNK_SIZE*2,CHUNK_SIZE*3]);assert.ok(f.trace.filter(entry=>entry.method==='PUT').every(entry=>entry.length<=CHUNK_SIZE));
  assert.ok(!f.trace.some(entry=>entry.path.startsWith('/api/peer/')),'原文件发送仍采用旧式单次接口');
  const again=await request(f.senderBase,`/api/uploads/${task.id}/complete`,f.admin.token,'POST',{});assert.equal(again.status,200);assert.equal(again.data.status,'complete');
  assert.deepEqual((await f.state()).stats,result.senderState.stats);assert.deepEqual((await f.receiverState()).stats,result.receiverState.stats);
  const deleted=await request(f.senderBase,`/api/uploads/${task.id}`,f.admin.token,'DELETE');assert.equal(deleted.status,200,JSON.stringify(deleted.data));await assertOriginal(filename,bytes,before);
  assert.ok(!(await f.state()).transfers.some(file=>file.id===task.id));assert.deepEqual((await f.state()).stats,result.senderState.stats);
});

test('本机目录自动发送保留中文相对路径，跳过外部链接与循环 junction',{timeout:15000},async t=>{
  const f=await fixture(t),root=path.join(f.sourceDirectory,'文件夹 中文'),sub=path.join(root,'子目录 空格');await fs.mkdir(sub,{recursive:true});
  const entries=[['根文件.txt',Buffer.from('根文件内容')],['子目录 空格/影片 中文.bin',crypto.randomBytes(CHUNK_SIZE+31)]];
  for(const [relative,bytes] of entries)await fs.writeFile(path.join(root,...relative.split('/')),bytes);
  const outside=path.join(f.directory,'不应发送');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'机密.txt'),'outside');
  await fs.symlink(outside,path.join(root,'越界链接'),process.platform==='win32'?'junction':'dir');
  await fs.symlink(root,path.join(sub,'循环链接'),process.platform==='win32'?'junction':'dir');
  const created=await f.create([root]);assert.equal(created.transfers.length,entries.length);
  assert.deepEqual(created.transfers.map(file=>file.relativePath).sort(),entries.map(([relative])=>'文件夹 中文/'+relative).sort());
  assert.ok(created.skipped.some(item=>String(item.path).includes('越界链接')));assert.ok(created.skipped.some(item=>String(item.path).includes('循环链接')));
  for(const task of created.transfers){const relative=task.relativePath.slice('文件夹 中文/'.length),bytes=entries.find(([name])=>name===relative)[1];await complete(f,task,bytes);assert.equal(digest(await fs.readFile(path.join(root,...relative.split('/')))),digest(bytes));}
  assert.equal((await f.receiverState()).inbox.length,entries.length);assert.equal((await f.state()).stats.sentBytes,entries.reduce((sum,[,bytes])=>sum+bytes.length,0));await assertNoSourceCopy(f);
});

test('本机路径接口要求本机管理员与同源，远端会话没有磁盘选择权限',{timeout:10000},async t=>{
  const f=await fixture(t),filename=path.join(f.sourceDirectory,'不应远端读取.txt');await fs.writeFile(filename,'original');
  const remoteHost={Host:'192.168.44.2:'+f.sender.config.port};
  const remote=(await request(f.senderBase,'/api/bootstrap?deviceId='+crypto.randomUUID(),null,'GET',undefined,remoteHost)).data;assert.equal(remote.admin,false);
  for(const endpoint of ['/api/local-transfers','/api/pick-send-files']){
    const body=endpoint.endsWith('local-transfers')?{paths:[filename],targetId:'server'}:{};
    assert.equal((await request(f.senderBase,endpoint,remote.token,'POST',body,remoteHost)).status,403);
    assert.equal((await request(f.senderBase,endpoint,f.admin.token,'POST',body,remoteHost)).status,403);
    assert.equal((await request(f.senderBase,endpoint,f.admin.token,'POST',body,{Origin:'http://other-host.invalid'})).status,403);
  }
  assert.equal((await f.state()).transfers.length,0);assert.equal(await fs.readFile(filename,'utf8'),'original');await assertNoSourceCopy(f);
});

test('暂停原文件传输后重启保留真实源引用与远端断点，新管理员继续且不重复发送',{timeout:20000},async t=>{
  const f=await fixture(t),bytes=crypto.randomBytes(CHUNK_SIZE*2+239),filename=path.join(f.sourceDirectory,'原文件暂停续传.bin');await fs.writeFile(filename,bytes);const before=await fs.stat(filename);
  const task=await pausedTask(f,filename),saved=(await f.metadata()).uploads.find(file=>file.id===task.id);assert.equal(saved.file,filename);assert.equal(saved.received,bytes.length);assert.equal(saved.localSource,true);assert.equal(saved.remoteUpload.serverId,f.receiver.config.id);
  await assertOriginal(filename,bytes,before);await f.restart();const fresh=(await request(f.senderBase,'/api/bootstrap?deviceId='+crypto.randomUUID())).data;
  assert.equal(fresh.admin,true);assert.notEqual(fresh.device.id,f.admin.device.id);
  const loaded=(await f.state(fresh.token)).transfers.find(file=>file.id===task.id);assert.equal(loaded.localSource,true);assert.equal(loaded.received,bytes.length);assert.equal(loaded.status,'error');assert.equal(loaded.canRetry,true);assert.equal(loaded.phase,'paused');
  const response=await request(f.senderBase,`/api/uploads/${task.id}/complete`,fresh.token,'POST',{});assert.equal(response.status,200,JSON.stringify(response.data));assert.ok(['queued','sending'].includes(response.data.status));
  const result=await complete(f,task,bytes,fresh.token);await assertOriginal(filename,bytes,before);assert.equal(result.senderState.stats.sentBytes,bytes.length);assert.equal(result.receiverState.stats.receivedBytes,bytes.length);
  assert.deepEqual(f.trace.filter(entry=>entry.method==='PUT').map(entry=>entry.offset),[0,CHUNK_SIZE,CHUNK_SIZE*2]);assert.equal(f.trace.filter(entry=>entry.method==='POST'&&entry.path==='/api/uploads').length,1);
});

test('暂停后原文件 size、mtime 或 inode 变化均拒绝重试，保持原大小并禁止发送变更数据',{timeout:30000},async t=>{
  for(const kind of ['size','mtime','inode'])await t.test(kind,{timeout:10000},async sub=>{
    const f=await fixture(sub),bytes=crypto.randomBytes(CHUNK_SIZE*2+31),filename=path.join(f.sourceDirectory,'源身份-'+kind+'.bin');await fs.writeFile(filename,bytes);
    const before=await fs.stat(filename),task=await pausedTask(f,filename);
    if(kind==='size')await fs.appendFile(filename,Buffer.from('changed-size'));
    else if(kind==='mtime')await fs.utimes(filename,before.atime,new Date(before.mtimeMs+2000));
    else{await fs.rename(filename,filename+'.original');await fs.writeFile(filename,bytes);await fs.utimes(filename,before.atime,before.mtime);assert.notEqual((await fs.stat(filename)).ino,before.ino);}
    const changed=await fs.readFile(filename),putsBefore=f.trace.filter(entry=>entry.method==='PUT').length;
    const response=await request(f.senderBase,`/api/uploads/${task.id}/complete`,f.admin.token,'POST',{});assert.equal(response.status,409,JSON.stringify(response.data));assert.match(response.data.error,/原文件|源文件|重新选择/);
    const state=await f.state(),item=state.transfers.find(file=>file.id===task.id);assert.equal(item.status,'error');assert.equal(item.size,bytes.length);assert.equal(item.received,bytes.length,'原文件变化不能伪装成新上传进度');assert.equal(state.stats.sentBytes,0);
    await delay(100);assert.equal(f.trace.filter(entry=>entry.method==='PUT').length,putsBefore,'重试发送了已经变更的原文件');assert.ok(!(await f.receiverState()).inbox.some(file=>file.name===task.name));
    assert.deepEqual(await fs.readFile(filename),changed);if(kind==='inode')assert.deepEqual(await fs.readFile(filename+'.original'),bytes);await assertNoSourceCopy(f);
    const removed=await request(f.senderBase,`/api/uploads/${task.id}`,f.admin.token,'DELETE');assert.equal(removed.status,200);assert.deepEqual(await fs.readFile(filename),changed);
  });
});

test('重启加载已变化的暂停源不覆盖 received 元数据，重试报错且原文件仍存在',{timeout:15000},async t=>{
  const f=await fixture(t),bytes=crypto.randomBytes(CHUNK_SIZE+31),filename=path.join(f.sourceDirectory,'重启时已变化.bin');await fs.writeFile(filename,bytes);const task=await pausedTask(f,filename);await fs.appendFile(filename,'changed');
  await f.restart();const fresh=(await request(f.senderBase,'/api/bootstrap?deviceId='+crypto.randomUUID())).data;
  const item=(await f.state(fresh.token)).transfers.find(file=>file.id===task.id);assert.ok(item,'变化的本机源任务被启动扫描丢弃');assert.equal(item.localSource,true);assert.equal(item.size,bytes.length);assert.equal(item.received,bytes.length);assert.equal(item.status,'error');
  assert.equal((await request(f.senderBase,`/api/uploads/${task.id}/complete`,fresh.token,'POST',{})).status,409);assert.equal((await fs.stat(filename)).size,bytes.length+7);assert.equal((await f.state(fresh.token)).stats.sentBytes,0);await assertNoSourceCopy(f);
});

test('本机任务单并发排队，暂停和删除队列任务都保留原文件',{timeout:15000},async t=>{
  const f=await fixture(t),bytes=crypto.randomBytes(CHUNK_SIZE+31),filenames=[];
  for(let index=0;index<3;index++){const filename=path.join(f.sourceDirectory,'排队-'+index+'.bin');await fs.writeFile(filename,bytes);filenames.push(filename);}
  const sourceReads=[],wholeReads=[],nativeOpen=fs.open.bind(fs),nativeReadFile=fs.readFile.bind(fs);
  t.mock.method(fs,'open',async(...args)=>{const handle=await nativeOpen(...args);if(filenames.includes(args[0])){const read=handle.read.bind(handle);handle.read=(...input)=>{sourceReads.push(args[0]);return read(...input);};}return handle;});
  t.mock.method(fs,'readFile',async(...args)=>{if(filenames.includes(args[0]))wholeReads.push(args[0]);return nativeReadFile(...args);});
  const held=f.controlPause(),created=await f.create(filenames);assert.equal(created.transfers.length,3);
  await waitFor(()=>Promise.race([held,delay(25).then(()=>null)]),Boolean,'第一个排队文件没有开始');
  const state=await f.state(),tasks=created.transfers.map(file=>state.transfers.find(item=>item.id===file.id));
  assert.equal(tasks.filter(item=>item.status==='sending').length,1,'本机队列同时打开了多个发送');assert.equal(tasks.filter(item=>item.status==='queued').length,2);assert.equal(f.trace.filter(entry=>entry.method==='PUT').length,1);
  assert.deepEqual(wholeReads,[],'创建任务读取了整个原文件');assert.ok(sourceReads.length>0);assert.ok(sourceReads.every(filename=>filename===filenames[0]),'创建队列任务时读取了尚未发送的原文件');
  const queued=tasks.filter(item=>item.status==='queued'),deleted=queued[1];assert.equal((await request(f.senderBase,`/api/uploads/${deleted.id}`,f.admin.token,'DELETE')).status,200);
  const active=tasks.find(item=>item.status==='sending');assert.equal((await request(f.senderBase,`/api/uploads/${active.id}/pause`,f.admin.token,'POST',{})).status,200);
  await complete(f,queued[0],bytes);assert.equal((await f.state()).transfers.find(file=>file.id===active.id).phase,'paused');assert.equal((await request(f.senderBase,`/api/uploads/${active.id}`,f.admin.token,'DELETE')).status,200);
  for(const filename of filenames)assert.deepEqual(await fs.readFile(filename),bytes);assert.equal((await f.state()).stats.sentBytes,bytes.length);await assertNoSourceCopy(f);
});

test('本机 server 和浏览器收件箱引用原文件：Range 下载、删除及重新验证身份',{timeout:15000},async t=>{
  const f=await fixture(t),remote=(await request(f.senderBase,'/api/bootstrap?deviceId='+crypto.randomUUID(),null,'GET',undefined,{Host:'192.168.44.2:'+f.sender.config.port})).data;
  for(const target of ['server',remote.device.id]){
    const bytes=crypto.randomBytes(65539),filename=path.join(f.sourceDirectory,'原文件收件-'+target+'.bin');await fs.writeFile(filename,bytes);const before=await fs.stat(filename),created=await f.create([filename],target),task=created.transfers[0];
    const state=await waitFor(()=>f.state(),s=>s.inbox.some(file=>file.id===task.id),'原文件引用没有自动进入收件箱'),inbox=state.inbox.find(file=>file.id===task.id);
    const records=await f.metadata();assert.equal(records.inbox.find(file=>file.id===task.id).file,filename);assert.equal(records.uploads.find(file=>file.id===task.id).file,filename);await assertNoSourceCopy(f);await assertOriginal(filename,bytes,before);
    assert.equal((await fs.readdir(f.sender.config.downloadDir)).length,0,'本机收件箱复制了原文件');
    const range=await request(f.senderBase,`/api/inbox/${inbox.id}/download`,target==='server'?null:remote.token,'GET',undefined,{Range:'bytes=17-123'});assert.equal(range.status,206);assert.deepEqual(range.bytes,bytes.subarray(17,124));
    if(target!=='server')assert.equal((await request(f.senderBase,`/api/inbox/${inbox.id}/download`)).status,403);
    const result=await request(f.senderBase,`/api/inbox/${inbox.id}`,target==='server'?f.admin.token:remote.token,'DELETE');assert.equal(result.status,200,JSON.stringify(result.data));await assertOriginal(filename,bytes,before);
    assert.equal((await request(f.senderBase,`/api/inbox/${inbox.id}/download`,f.admin.token)).status,404);
  }
  const filename=path.join(f.sourceDirectory,'下载前已替换.bin'),bytes=Buffer.from('original reference');await fs.writeFile(filename,bytes);const created=await f.create([filename],'server'),task=created.transfers[0];await waitFor(()=>f.state(),s=>s.inbox.some(file=>file.id===task.id),'引用未创建');
  await fs.rename(filename,filename+'.original');await fs.writeFile(filename,'replacement must never be served');const changed=await request(f.senderBase,`/api/inbox/${task.id}/download`,f.admin.token);assert.ok([404,409].includes(changed.status),JSON.stringify(changed.data));assert.notEqual(changed.bytes.toString(),'replacement must never be served');
  assert.equal((await request(f.senderBase,`/api/inbox/${task.id}`,f.admin.token,'DELETE')).status,200);assert.equal(await fs.readFile(filename,'utf8'),'replacement must never be served');assert.deepEqual(await fs.readFile(filename+'.original'),bytes);
});

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const http=require('node:http');
const {createApp}=require('../server/index');
const {CHUNK_SIZE}=require('../server/util');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function request(url,token,method='GET',body,extra={}){
  const headers={...(token?{Authorization:`Bearer ${token}`} : {}),...extra};
  if(body!==undefined){
    if(!Buffer.isBuffer(body)){body=Buffer.from(JSON.stringify(body));headers['Content-Type']='application/json';}
    else if(!headers['Content-Type'])headers['Content-Type']='application/octet-stream';
    headers['Content-Length']=body.length;
  }
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method,headers},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{
        const buffer=Buffer.concat(chunks);
        try{resolve({status:res.statusCode,headers:res.headers,buffer,data:String(res.headers['content-type']).includes('json')&&buffer.length?JSON.parse(buffer.toString()):undefined});}catch(e){reject(e);}
      });
    });req.on('error',reject);req.end(body);
  });
}
async function waitFor(read,accept,message,timeout=5000){
  const deadline=Date.now()+timeout;let value;
  do{value=await read();if(accept(value))return value;await pause(50);}while(Date.now()<deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}
async function upload(base,token,name,bytes,targetId){
  const created=await request(base+'/api/uploads',token,'POST',{name,size:bytes.length,targetId});
  assert.equal(created.status,201,JSON.stringify(created.data));
  for(let offset=0;offset<bytes.length;offset+=created.data.chunkSize){
    const chunk=await request(`${base}/api/uploads/${created.data.id}?offset=${offset}`,token,'PUT',bytes.subarray(offset,offset+created.data.chunkSize));
    assert.equal(chunk.status,200,JSON.stringify(chunk.data));
  }
  const done=await request(`${base}/api/uploads/${created.data.id}/complete`,token,'POST',{});
  assert.equal(done.status,200,JSON.stringify(done.data));return {...created.data,status:done.data.status};
}

test('两台 Node 主机直接连接：真实发现、接收落盘、共享影音和手动地址', {timeout:40000},async t=>{
  // Still use real UDP sockets; loopback makes the test independent of host firewall settings.
  t.mock.method(os,'networkInterfaces',()=>({Loopback:[{address:'127.0.0.1',netmask:'255.0.0.0',family:'IPv4',internal:false}]}));
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'linkwave-direct-'));
  const a=await createApp({port:0,host:'127.0.0.1',dataDir:path.join(tmp,'a'),name:'直连电脑 A'});
  const b=await createApp({port:0,host:'127.0.0.1',dataDir:path.join(tmp,'b'),name:'直连电脑 B'});
  const pairRequests=[],hostUploadRequests=[];
  for(const host of [a,b])host.server.on('request',req=>{
    if(/^\/api\/(?:pair|peer\/pair|peers\/pair)(?:\?|$)/.test(req.url))pairRequests.push(req.url);
    if(req.headers['user-agent']?.startsWith('LinkWaveHost')||req.method==='PUT')hostUploadRequests.push({method:req.method,url:req.url});
  });
  await a.start();await b.start();
  t.after(async()=>{await a.close();await b.close();await fs.rm(tmp,{recursive:true,force:true});});
  const baseA=`http://127.0.0.1:${a.config.port}`,baseB=`http://127.0.0.1:${b.config.port}`;
  const adminA=(await request(baseA+'/api/bootstrap')).data,adminB=(await request(baseB+'/api/bootstrap')).data;
  const state=(base,token)=>request(base+'/api/state',token).then(r=>{assert.equal(r.status,200,JSON.stringify(r.data));return r.data;});
  const remoteHeaders={Host:`192.168.33.8:${a.config.port}`};

  await t.test('未提供设备ID也自动连接；匿名只能看公共收件箱且各设备任务隔离',async()=>{
    const sender=(await request(baseA+'/api/bootstrap',null,'GET',undefined,remoteHeaders)).data;
    const receiver=(await request(baseA+'/api/bootstrap?name=收件设备',null,'GET',undefined,remoteHeaders)).data;
    assert.equal(sender.paired,true);assert.equal(sender.admin,false);assert.equal(sender.capabilities.directConnect,true);
    assert.match(sender.token,/^[a-f0-9]{64}$/);assert.ok(sender.device.id);assert.notEqual(sender.device.id,receiver.device.id);
    const privateBytes=Buffer.from('only-the-addressed-device-can-read-this');
    const privateFile=await upload(baseA,sender.token,'设备私有.bin',privateBytes,receiver.device.id);
    const publicFile=await upload(baseA,sender.token,'主机公共.bin',Buffer.from('server-inbox'), 'server');
    assert.equal(privateFile.status,'complete');assert.equal(publicFile.status,'complete');
    const anonymous=await state(baseA);
    assert.ok(anonymous.inbox.some(file=>file.id===publicFile.id));assert.ok(!anonymous.inbox.some(file=>file.id===privateFile.id));
    assert.ok(!anonymous.transfers.some(file=>file.id===privateFile.id));assert.equal(anonymous.downloadDir,undefined);
    assert.equal((await request(`${baseA}/api/inbox/${privateFile.id}/download`)).status,403);
    assert.equal((await request(`${baseA}/api/inbox/${privateFile.id}/download`,sender.token)).status,403);
    assert.equal((await request(`${baseA}/api/uploads/${privateFile.id}`,receiver.token)).status,403);
    assert.deepEqual((await request(`${baseA}/api/inbox/${privateFile.id}/download`,receiver.token)).buffer,privateBytes);
    assert.deepEqual((await request(`${baseA}/api/inbox/${publicFile.id}/download`)).buffer,Buffer.from('server-inbox'));
    assert.equal((await request(baseA+'/api/shares',sender.token,'POST',{path:tmp})).status,403);
    assert.equal((await request(baseA+'/api/settings',sender.token,'PATCH',{name:'越权'})).status,403);
  });

  await t.test('真实 UDP 双向发现后直接互传，远端落盘和发送完成状态一致',async()=>{
    await waitFor(async()=>{
      await Promise.all([a.discovery.announce(),b.discovery.announce()]);
      return {a:await state(baseA,adminA.token),b:await state(baseB,adminB.token)};
    },states=>states.a.devices.some(d=>d.id===`host:${b.config.id}`&&d.online&&d.paired)&&states.b.devices.some(d=>d.id===`host:${a.config.id}`&&d.online&&d.paired),'两台主机未直接显示为可发送设备');
    for(const [source,dest,sourceToken,destToken,destHost,destApp,label] of [
      [baseA,baseB,adminA.token,adminB.token,b.config.id,b,'A到B'],
      [baseB,baseA,adminB.token,adminA.token,a.config.id,a,'B到A']
    ]){
      const bytes=crypto.randomBytes(CHUNK_SIZE*2+193),name=`直接互传-${label}.bin`;
      const statsBefore=(await state(source,sourceToken)).stats.sentBytes;
      const task=await upload(source,sourceToken,name,bytes,`host:${destHost}`);
      assert.ok(['sending','complete'].includes(task.status));
      const receivedState=await waitFor(()=>state(dest,destToken),s=>s.inbox.some(file=>file.name===name),'发现主机后文件未直接到达');
      const received=receivedState.inbox.find(file=>file.name===name);
      assert.equal(sha256((await request(dest+received.url)).buffer),sha256(bytes));
      const diskFile=path.join(destApp.config.downloadDir,received.id,...received.relativePath.split('/'));
      assert.equal(sha256(await fs.readFile(diskFile)),sha256(bytes));
      const completed=await waitFor(()=>state(source,sourceToken),s=>s.transfers.some(file=>file.id===task.id&&file.status==='complete'),'发送方未显示远端接收完成');
      const result=completed.transfers.find(file=>file.id===task.id);
      assert.equal(result.received,bytes.length);assert.equal(result.deliveredBytes,bytes.length);assert.equal(result.phase,'complete');
      assert.equal(completed.stats.sentBytes,statsBefore+bytes.length);
      assert.equal((await request(`${source}/api/uploads/${task.id}/complete`,sourceToken,'POST',{})).data.status,'complete');
      assert.equal((await state(source,sourceToken)).stats.sentBytes,completed.stats.sentBytes);
    }
    assert.ok(hostUploadRequests.some(req=>req.method==='GET'&&req.url.startsWith('/api/bootstrap?deviceId=sender-')));
    assert.ok(hostUploadRequests.some(req=>req.method==='PUT'&&req.url.endsWith(`?offset=${CHUNK_SIZE}`)));
    const bytes=crypto.randomBytes(8193);
    const direct=await request(`${baseB}/api/peer/receive?name=原生主机.bin&size=${bytes.length}`,null,'POST',bytes,{'X-LinkWave-Name':encodeURIComponent('Android原生主机')});
    assert.equal(direct.status,201);assert.equal(direct.data.status,'complete');assert.equal(direct.data.received,bytes.length);
    const inbox=(await state(baseB)).inbox.find(file=>file.id===direct.data.id);assert.ok(inbox);
    assert.equal(inbox.from,'Android原生主机');assert.equal(sha256((await request(baseB+inbox.url)).buffer),sha256(bytes));
    for(const name of ['../escape.bin','CON','bad:name.bin'])assert.equal((await request(`${baseB}/api/peer/receive?name=${encodeURIComponent(name)}&size=0`,null,'POST',Buffer.alloc(0))).status,400);
    assert.equal((await request(`${baseB}/api/peer/receive?name=unsafe.bin&size=-1`,null,'POST',Buffer.alloc(0))).status,400);
    assert.equal((await request(`${baseB}/api/peer/receive?name=unsafe.bin&relativePath=../unsafe.bin&size=0`,null,'POST',Buffer.alloc(0))).status,400);
  });

  await t.test('共享在五秒内显示于另一台主机，目录列表仅发布本机项且不会循环',async()=>{
    const dirA=path.join(tmp,'A影音'),dirB=path.join(tmp,'B影音');await fs.mkdir(dirA);await fs.mkdir(dirB);
    const bytes=Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    await fs.writeFile(path.join(dirA,'中文片段.mp4'),bytes);await fs.writeFile(path.join(dirB,'说明.txt'),'B 本机文件');
    const shareA=(await request(baseA+'/api/shares',adminA.token,'POST',{path:dirA,name:'A 家庭影音'})).data;
    const shareB=(await request(baseB+'/api/shares',adminB.token,'POST',{path:dirB,name:'B 家庭影音'})).data;
    const started=Date.now();
    const visible=await waitFor(async()=>({a:await state(baseA),b:await state(baseB)}),s=>s.a.shares.some(sh=>sh.id===shareB.id&&sh.hostId===b.config.id)&&s.b.shares.some(sh=>sh.id===shareA.id&&sh.hostId===a.config.id),'新共享未在五秒内出现在远端');
    assert.ok(Date.now()-started<=5000);
    const remote=visible.b.shares.find(sh=>sh.id===shareA.id);
    assert.equal(remote.remote,true);assert.equal(remote.sourceName,a.config.name);assert.equal(remote.path,undefined);
    for(const [base,localShare,remoteShare] of [[baseA,shareA,shareB],[baseB,shareB,shareA]]){
      const library=(await request(base+'/api/shared-library')).data;
      assert.deepEqual(library.shares,[{id:localShare.id,name:localShare.name,type:'folder'}]);
      assert.ok(!library.shares.some(sh=>sh.id===remoteShare.id));assert.ok(!JSON.stringify(library).includes(tmp));
      const latest=await state(base);assert.equal(latest.shares.filter(sh=>sh.id===localShare.id).length,1);assert.equal(latest.shares.filter(sh=>sh.id===remoteShare.id).length,1);
    }
    const proxy=`${baseB}/api/peers/${a.config.id}/shares/${shareA.id}`;
    const listing=await request(proxy+'/browse');assert.equal(listing.status,200);assert.equal(listing.data.entries[0].name,'中文片段.mp4');
    const media=proxy+'/file?path='+encodeURIComponent('中文片段.mp4');
    const range=await request(media,null,'GET',undefined,{Range:'bytes=10-15'});
    assert.equal(range.status,206);assert.equal(range.headers['content-range'],'bytes 10-15/36');assert.deepEqual(range.buffer,bytes.subarray(10,16));assert.equal(range.headers['accept-ranges'],'bytes');
    const head=await request(media,null,'HEAD',undefined,{Range:'bytes=0-9'});
    assert.equal(head.status,206);assert.equal(head.headers['content-length'],'10');assert.equal(head.headers['content-range'],'bytes 0-9/36');assert.equal(head.buffer.length,0);
    assert.equal((await request(media,null,'GET',undefined,{'If-None-Match':range.headers.etag})).status,304);
    const invalid=await request(media,null,'GET',undefined,{Range:'bytes=99-'});assert.equal(invalid.status,416);assert.equal(invalid.headers['content-range'],'bytes */36');
    const download=await request(proxy+'/download?path='+encodeURIComponent('中文片段.mp4'));assert.equal(download.status,200);assert.match(download.headers['content-disposition'],/^attachment;/);assert.deepEqual(download.buffer,bytes);
    const zip=await request(proxy+'/download');assert.equal(zip.status,200);assert.equal(zip.headers['content-type'],'application/zip');assert.equal(zip.buffer.readUInt32LE(0),0x04034b50);
    const unsafe=await request(proxy+'/file?path='+encodeURIComponent('../private.bin'));assert.ok([400,403].includes(unsafe.status));
  });

  await t.test('手动地址无需确认即可补充发现，仅允许 LAN HTTP，拒绝公网和异常服务',async()=>{
    const c=await createApp({port:0,host:'127.0.0.1',dataDir:path.join(tmp,'c'),name:'手动地址电脑',discovery:false});await c.start();
    try{
      const baseC=`http://127.0.0.1:${c.config.port}`;
      const connected=await request(baseB+'/api/peers/connect',null,'POST',{url:baseC});
      assert.equal(connected.status,200);assert.equal(connected.data.device.id,`host:${c.config.id}`);assert.equal(connected.data.device.paired,true);assert.equal(connected.data.device.online,true);
      assert.ok((await state(baseB)).devices.some(d=>d.id===`host:${c.config.id}`&&d.paired));
      for(const url of ['https://127.0.0.1:53317','http://8.8.8.8:53317','http://172.32.0.1:53317','http://192.169.1.1:53317','http://example.com','http://user:password@127.0.0.1:53317','ftp://192.168.1.1']){
        const invalid=await request(baseB+'/api/peers/connect',null,'POST',{url});assert.equal(invalid.status,400,url);
      }
      assert.equal((await request(baseB+'/api/peers/connect',null,'POST',{url:baseB})).status,400);
      const decoy=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,serverId:'not-a-linkwave-id'}));});
      await new Promise(resolve=>decoy.listen(0,'127.0.0.1',resolve));
      try{assert.equal((await request(baseB+'/api/peers/connect',null,'POST',{url:`http://127.0.0.1:${decoy.address().port}`})).status,400);}finally{await new Promise(resolve=>decoy.close(resolve));}
    }finally{await c.close();}
  });

  await t.test('远端未确认完整接收时任务报错，保留源文件供重试',async()=>{
    const peerId=crypto.randomUUID(),peerToken=crypto.randomBytes(32).toString('hex');
    let completeStatus='uploading',receivedBytes=0,remoteId,remoteSize;
    const peer=http.createServer((req,res)=>{
      const url=new URL(req.url,'http://127.0.0.1');
      const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
      if(url.pathname==='/api/health')return json({ok:true,serverId:peerId});
      if(url.pathname==='/api/shared-library')return json({server:{id:peerId,name:'接收确认测试'},shares:[]});
      if(url.pathname==='/api/bootstrap')return json({token:peerToken,server:{id:peerId}});
      assert.equal(req.headers.authorization,'Bearer '+peerToken);
      if(url.pathname==='/api/uploads'&&req.method==='POST'){
        const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
          const input=JSON.parse(Buffer.concat(chunks));remoteId=crypto.randomUUID();remoteSize=input.size;receivedBytes=0;
          json({id:remoteId,offset:0,chunkSize:CHUNK_SIZE},201);
        });return;
      }
      if(url.pathname===`/api/uploads/${remoteId}`&&req.method==='PUT'){
        assert.equal(Number(url.searchParams.get('offset')),receivedBytes);
        req.on('data',chunk=>receivedBytes+=chunk.length);req.on('end',()=>json({offset:receivedBytes}));return;
      }
      if(url.pathname===`/api/uploads/${remoteId}`&&req.method==='GET')return json({id:remoteId,offset:receivedBytes,size:remoteSize,status:'uploading'});
      if(url.pathname===`/api/uploads/${remoteId}/complete`&&req.method==='POST'){req.resume();return json({id:remoteId,status:completeStatus});}
      json({error:'旧式或未知接收接口'},404);
    });
    await new Promise(resolve=>peer.listen(0,'127.0.0.1',resolve));
    try{
      assert.equal((await request(baseA+'/api/peers/connect',null,'POST',{url:`http://127.0.0.1:${peer.address().port}`})).status,200);
      const bytes=crypto.randomBytes(4097);
      for(const status of ['uploading','error']){
        completeStatus=status;receivedBytes=0;
        const statsBefore=(await state(baseA,adminA.token)).stats.sentBytes;
        const task=await upload(baseA,adminA.token,`缺少完成确认-${status}.bin`,bytes,`host:${peerId}`);
        const failed=await waitFor(()=>state(baseA,adminA.token),s=>s.transfers.some(file=>file.id===task.id&&file.status==='error'),'远端未完成却被显示为接收完成');
        assert.equal(receivedBytes,bytes.length);assert.ok(failed.transfers.find(file=>file.id===task.id).error);
        assert.equal(failed.stats.sentBytes,statsBefore);
        assert.deepEqual(await fs.readFile(path.join(a.config.dataDir,'uploads',task.id+'.part')),bytes);
        completeStatus='complete';
        assert.equal((await request(`${baseA}/api/uploads/${task.id}/complete`,adminA.token,'POST',{})).status,200);
        const done=await waitFor(()=>state(baseA,adminA.token),s=>s.transfers.some(file=>file.id===task.id&&file.status==='complete'),'确认完整接收后重试未完成');
        assert.equal(done.stats.sentBytes,statsBefore+bytes.length);assert.equal(done.transfers.find(file=>file.id===task.id).deliveredBytes,bytes.length);
        await assert.rejects(fs.access(path.join(a.config.dataDir,'uploads',task.id+'.part')),{code:'ENOENT'});
      }
    }finally{await new Promise(resolve=>peer.close(resolve));}
  });
  assert.deepEqual(pairRequests,[],'自动发现、影音浏览和互传不应发出任何配对请求');
});

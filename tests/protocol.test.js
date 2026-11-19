'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const http=require('node:http');
const {createApp}=require('../server/index');
const {WebSocket}=require('ws');

test('完整局域网直连协议：自动连接、断点续传、双向互传、目录和视频', {timeout:60000}, async t=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'linkwave-test-'));
  const a=await createApp({port:0,host:'127.0.0.1',dataDir:path.join(tmp,'a'),discovery:false,noOpen:true,name:'测试电脑 A'});
  const b=await createApp({port:0,host:'127.0.0.1',dataDir:path.join(tmp,'b'),discovery:false,noOpen:true,name:'测试电脑 B'});
  await a.start();await b.start();
  const base=`http://127.0.0.1:${a.config.port}`,other=`http://127.0.0.1:${b.config.port}`;
  t.after(async()=>{await a.close();await b.close();await fs.rm(tmp,{recursive:true,force:true});});
  async function req(url,token,method='GET',body,extra={}){
    const headers={...(token?{Authorization:`Bearer ${token}`} : {}),...extra};
    if(body!==undefined&&!(body instanceof Uint8Array)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
    return new Promise((resolve,reject)=>{
      const request=http.request(url,{method,headers},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
        response.on('end',()=>{
          const buffer=Buffer.concat(chunks);
          const res={status:response.statusCode,headers:{get:name=>response.headers[name.toLowerCase()]||null}};
          try{resolve({res,data:String(res.headers.get('content-type')).includes('json')?JSON.parse(buffer.toString()):buffer});}catch(e){reject(e);}
        });
      });request.on('error',reject);request.end(body);
    });
  }
  const adminId=crypto.randomUUID(),senderId=crypto.randomUUID(),receiverId=crypto.randomUUID();
  const boot=await req(`${base}/api/bootstrap?deviceId=${adminId}&name=管理电脑`);
  assert.equal(boot.res.status,200);assert.equal(boot.data.admin,true);
  const admin=boot.data.token;
  const remoteHeaders={Host:`192.168.1.88:${a.config.port}`};
  const sender=(await req(`${base}/api/bootstrap?deviceId=${senderId}&name=安卓手机甲`,null,'GET',undefined,remoteHeaders)).data.token;
  const receiver=(await req(`${base}/api/bootstrap?deviceId=${receiverId}&name=安卓手机乙`,null,'GET',undefined,remoteHeaders)).data.token;
  const bootB=(await req(`${other}/api/bootstrap?deviceId=${crypto.randomUUID()}&name=B管理员`)).data;

  await t.test('局域网自动建立会话，匿名只读可访问且远程没有本机管理权限',async()=>{
    assert.equal((await req(`${base}/api/state`)).res.status,200);
    const remote=await req(`${base}/api/bootstrap?deviceId=${crypto.randomUUID()}`,null,'GET',undefined,remoteHeaders);
    assert.equal(remote.data.paired,true);assert.equal(remote.data.admin,false);assert.equal(remote.data.capabilities.directConnect,true);assert.ok(remote.data.token);
    assert.equal((await req(`${base}/api/settings`,sender,'PATCH',{name:'越权'})).res.status,403);
    assert.equal((await req(`${base}/api/settings`,admin,'PATCH',{name:'冒充本机'},{Host:`192.168.1.88:${a.config.port}`})).res.status,403);
    assert.equal((await req(`${base}/api/device`,sender,'POST',{name:'跨站'},{Origin:'https://evil.example'})).res.status,403);
  });

  let upload;
  const bytes=crypto.randomBytes(4*1024*1024+12345);
  await t.test('大文件分块传输、错位拒绝、任务恢复和完整性',async()=>{
    const meta={name:'旅行 视频.mp4',size:bytes.length,relativePath:'相册/旅行 视频.mp4',targetId:receiverId,lastModified:123456};
    const created=await req(`${base}/api/uploads`,sender,'POST',meta);assert.equal(created.res.status,201);upload=created.data;
    const cut=1048576;
    const part=await req(`${base}/api/uploads/${upload.id}?offset=0`,sender,'PUT',bytes.subarray(0,cut),{'Content-Type':'application/octet-stream'});
    assert.equal(part.data.offset,cut);
    const wrong=await req(`${base}/api/uploads/${upload.id}?offset=0`,sender,'PUT',Buffer.from('x'),{'Content-Type':'application/octet-stream'});
    assert.equal(wrong.res.status,409);assert.equal(wrong.data.offset,cut);
    const resumed=(await req(`${base}/api/uploads`,sender,'POST',meta)).data;assert.equal(resumed.id,upload.id);assert.equal(resumed.offset,cut);
    assert.equal((await req(`${base}/api/uploads/${upload.id}`,receiver)).res.status,403);
    assert.equal((await req(`${base}/api/uploads/${upload.id}/complete`,sender,'POST',{})).res.status,409);
    assert.equal((await req(`${base}/api/uploads/${upload.id}?offset=${cut}`,sender,'PUT',bytes.subarray(cut),{'Content-Type':'application/octet-stream'})).data.offset,bytes.length);
    assert.equal((await req(`${base}/api/uploads/${upload.id}/complete`,sender,'POST',{})).data.status,'complete');
    const state=(await req(`${base}/api/state`,receiver)).data;assert.ok(state.inbox.some(x=>x.id===upload.id));
    const received=await req(`${base}/api/inbox/${upload.id}/download`,receiver);assert.equal(received.res.status,200);assert.deepEqual(received.data,bytes);
    assert.match(received.res.headers.get('content-disposition'),/filename\*=UTF-8/);
    assert.equal((await req(`${base}/api/inbox/${upload.id}/download`,sender)).res.status,403);
  });

  await t.test('反向手机互传、零字节文件、取消任务和恶意文件名',async()=>{
    const empty=(await req(`${base}/api/uploads`,receiver,'POST',{name:'空文件.txt',size:0,targetId:senderId})).data;
    assert.equal((await req(`${base}/api/uploads/${empty.id}/complete`,receiver,'POST',{})).data.status,'complete');
    assert.equal((await req(`${base}/api/inbox/${empty.id}/download`,sender)).data.length,0);
    const cancel=(await req(`${base}/api/uploads`,sender,'POST',{name:'取消.bin',size:1024,targetId:'server'})).data;
    assert.equal((await req(`${base}/api/uploads/${cancel.id}`,sender,'DELETE')).res.status,200);
    assert.equal((await req(`${base}/api/uploads/${cancel.id}`,sender)).res.status,404);
    for(const name of ['../escape.txt','CON','bad:name.txt'])assert.equal((await req(`${base}/api/uploads`,sender,'POST',{name,size:0,targetId:'server'})).res.status,400);
    assert.equal((await req(`${base}/api/uploads`,sender,'POST',{name:'file.txt',size:0,relativePath:'../file.txt',targetId:'server'})).res.status,400);
    assert.equal((await req(`${base}/api/uploads`,sender,'POST',{name:'file.txt',size:51*1024**3,targetId:'server'})).res.status,400);
  });

  let share;
  const library=path.join(tmp,'影音库');
  await fs.mkdir(path.join(library,'子目录'),{recursive:true});
  await fs.writeFile(path.join(library,'示例.mp4'),Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'));
  await fs.writeFile(path.join(library,'子目录','说明.txt'),'你好，邻波');
  await fs.writeFile(path.join(tmp,'机密.txt'),'outside');
  await t.test('只读共享目录、中文路径、浏览和 ZIP 下载',async()=>{
    assert.equal((await req(`${base}/api/shares`,sender,'POST',{path:library})).res.status,403);
    const created=await req(`${base}/api/shares`,admin,'POST',{path:library,name:'家庭影音'});assert.equal(created.res.status,201);share=created.data;
    const browse=(await req(`${base}/api/shares/${share.id}/browse`,receiver)).data;
    assert.equal(browse.entries[0].type,'folder');assert.ok(browse.entries.some(x=>x.name==='示例.mp4'&&x.mime==='video/mp4'));
    const nested=(await req(`${base}/api/shares/${share.id}/browse?path=${encodeURIComponent('子目录')}`,receiver)).data;assert.equal(nested.entries[0].name,'说明.txt');
    const state=(await req(`${base}/api/state`,receiver)).data;assert.equal(state.shares[0].path,undefined);
    const zip=await req(`${base}/api/shares/${share.id}/download?token=${receiver}`,null);assert.equal(zip.res.status,200);assert.equal(zip.res.headers.get('content-type'),'application/zip');assert.equal(zip.data.readUInt32LE(0),0x04034b50);assert.ok(zip.data.includes(Buffer.from('说明.txt')));
  });

  await t.test('视频在线拖动：Range、suffix、HEAD、416、缓存验证',async()=>{
    const url=`${base}/api/shares/${share.id}/file?path=${encodeURIComponent('示例.mp4')}&token=${receiver}`;
    const range=await req(url,null,'GET',undefined,{Range:'bytes=10-15'});assert.equal(range.res.status,206);assert.equal(range.data.toString(),'abcdef');assert.equal(range.res.headers.get('content-range'),'bytes 10-15/36');
    assert.equal((await req(url,null,'GET',undefined,{Range:'bytes=-3'})).data.toString(),'xyz');
    const head=await req(url,null,'HEAD',undefined,{Range:'bytes=0-9'});assert.equal(head.res.status,206);assert.equal(head.res.headers.get('content-length'),'10');assert.equal(head.data.length,0);
    const invalid=await req(url,null,'GET',undefined,{Range:'bytes=999-1000'});assert.equal(invalid.res.status,416);assert.equal(invalid.res.headers.get('content-range'),'bytes */36');
    assert.equal((await req(url,null,'GET',undefined,{'If-None-Match':range.res.headers.get('etag')})).res.status,304);
  });

  await t.test('目录穿越、Windows 特殊路径和越界链接均被阻止',async()=>{
    for(const unsafe of ['../机密.txt','..\\机密.txt','C:\\Windows','/etc/passwd','子目录/../../机密.txt']){
      const result=await req(`${base}/api/shares/${share.id}/file?path=${encodeURIComponent(unsafe)}`,receiver);assert.ok([400,403].includes(result.res.status),`${unsafe} status ${result.res.status}`);
    }
    await fs.symlink(tmp,path.join(library,'越界链接'),process.platform==='win32'?'junction':'dir');
    assert.equal((await req(`${base}/api/shares/${share.id}/file?path=${encodeURIComponent('越界链接/机密.txt')}`,receiver)).res.status,403);
    const entries=(await req(`${base}/api/shares/${share.id}/browse`,receiver)).data.entries;assert.ok(!entries.some(x=>x.name==='越界链接'));
  });

  await t.test('WebSocket 状态通知与未鉴权连接拒绝',async()=>{
    await new Promise((resolve,reject)=>{
      const ws=new WebSocket(`ws://127.0.0.1:${a.config.port}/ws?token=${sender}`);
      const timeout=setTimeout(()=>{ws.terminate();reject(new Error('未收到状态通知'));},5000);
      ws.on('open',async()=>{try{await req(`${base}/api/device`,sender,'POST',{name:'改名后的手机'});}catch(e){reject(e);}});
      ws.on('message',message=>{assert.equal(JSON.parse(message).type,'state');clearTimeout(timeout);ws.close();resolve();});ws.on('error',reject);
    });
    await new Promise((resolve,reject)=>{
      const ws=new WebSocket(`ws://127.0.0.1:${a.config.port}/ws`);
      ws.on('open',()=>{ws.close();reject(new Error('未经鉴权的WS被放行'));});ws.on('unexpected-response',(r,res)=>{assert.equal(res.statusCode,401);resolve();});ws.on('error',()=>{});
    });
  });

  await t.test('两台独立主机无需操作即可双向转发（Windows↔Windows 协议）',async()=>{
    a.discovery.peers.set(b.config.id,{id:b.config.id,name:b.config.name,platform:'Windows',port:b.config.port,ip:'127.0.0.1',url:other,lastSeen:Date.now()});
    b.discovery.peers.set(a.config.id,{id:a.config.id,name:a.config.name,platform:'Windows',port:a.config.port,ip:'127.0.0.1',url:base,lastSeen:Date.now()});
    for(const [source,dest,sourceToken,destToken,hostId] of [[base,other,admin,bootB.token,b.config.id],[other,base,bootB.token,admin,a.config.id]]){
      const file=crypto.randomBytes(768*1024+7);
      const up=(await req(`${source}/api/uploads`,sourceToken,'POST',{name:'主机互传.bin',size:file.length,targetId:`host:${hostId}`})).data;
      assert.equal((await req(`${source}/api/uploads/${up.id}?offset=0`,sourceToken,'PUT',file,{'Content-Type':'application/octet-stream'})).data.offset,file.length);
      assert.equal((await req(`${source}/api/uploads/${up.id}/complete`,sourceToken,'POST',{})).data.status,'sending');
      let received;
      for(let i=0;i<100;i++){const state=(await req(`${dest}/api/state`,destToken)).data;received=state.inbox.find(x=>x.name==='主机互传.bin');if(received)break;await new Promise(resolve=>setTimeout(resolve,50));}
      assert.ok(received,'目标主机未收到文件');assert.deepEqual((await req(`${dest}/api/inbox/${received.id}/download`,destToken)).data,file);
    }
    const direct=await req(`${other}/api/peer/receive?name=直接接收.txt&size=0`,null,'POST',Buffer.alloc(0),{'Content-Type':'application/octet-stream'});
    assert.equal(direct.res.status,201);assert.equal(direct.data.status,'complete');
  });

  await t.test('配置与断点任务在重启后保留',async()=>{
    const saved=await req(`${base}/api/settings`,admin,'PATCH',{name:'已保存名称'});assert.equal(saved.res.status,200);
    const up=(await req(`${base}/api/uploads`,sender,'POST',{name:'重启续传.bin',size:20,targetId:'server'})).data;
    await req(`${base}/api/uploads/${up.id}?offset=0`,sender,'PUT',Buffer.from('1234567890'),{'Content-Type':'application/octet-stream'});
    await a.close();
    const restarted=await createApp({port:0,host:'127.0.0.1',dataDir:path.join(tmp,'a'),discovery:false,noOpen:true});await restarted.start();
    try{
      const after=`http://127.0.0.1:${restarted.config.port}`;
      assert.equal(restarted.config.name,'已保存名称');
      const task=(await req(`${after}/api/uploads/${up.id}`,sender)).data;assert.equal(task.offset,10);
      assert.equal((await req(`${after}/api/inbox/${upload.id}/download`,receiver)).res.status,200);
      await req(`${after}/api/uploads/${up.id}?offset=10`,sender,'PUT',Buffer.from('abcdefghij'),{'Content-Type':'application/octet-stream'});
      assert.equal((await req(`${after}/api/uploads/${up.id}/complete`,sender,'POST',{})).data.status,'complete');
    }finally{await restarted.close();}
  });
});

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const http=require('node:http');
const {createApp}=require('../server/index');

test('服务端安全与并发回归', {timeout:30000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'linkwave-hardening-'));
  const instance=await createApp({dataDir:directory,port:0,host:'127.0.0.1',discovery:false,name:'安全回归主机'});
  await instance.start();
  t.after(async()=>{await instance.close();await fs.rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${instance.config.port}`;
  async function json(route,token,method='GET',body,extra={}){
    const payload=body!==undefined?JSON.stringify(body):undefined;
    return new Promise((resolve,reject)=>{
      const req=http.request(base+route,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(payload!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...extra}},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
        response.on('end',()=>{try{resolve({status:response.statusCode,data:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}});
      });req.on('error',reject);req.end(payload);
    });
  }
  const adminId=crypto.randomUUID();
  const admin=(await json(`/api/bootstrap?deviceId=${adminId}`)).data;
  const remoteHeaders={Host:`192.168.44.2:${instance.config.port}`};
  const receiver=(await json(`/api/bootstrap?deviceId=${crypto.randomUUID()}&name=收件手机`,null,'GET',undefined,remoteHeaders)).data;

  await t.test('可见设备ID不能在自动连接时冒充已有设备，会话token可恢复身份',async()=>{
    const duplicate=(await json(`/api/bootstrap?deviceId=${receiver.device.id}&name=另一个浏览器`,null,'GET',undefined,remoteHeaders)).data;
    assert.notEqual(duplicate.device.id,receiver.device.id);
    assert.notEqual(duplicate.token,receiver.token);
    const spoofAdmin=(await json(`/api/bootstrap?deviceId=${adminId}&name=冒充管理员`,null,'GET',undefined,remoteHeaders)).data;
    assert.notEqual(spoofAdmin.device.id,adminId);
    assert.notEqual(spoofAdmin.token,admin.token);
    assert.equal(spoofAdmin.admin,false);
    assert.equal((await json('/api/settings',spoofAdmin.token,'PATCH',{name:'越权'})).status,403);
    const resumed=(await json(`/api/bootstrap?deviceId=${receiver.device.id}`,receiver.token,'GET',undefined,remoteHeaders)).data;
    assert.equal(resumed.device.id,receiver.device.id);assert.equal(resumed.token,receiver.token);
  });

  await t.test('并发完成同一文件仅落盘与记账一次',async()=>{
    const bytes=crypto.randomBytes(65536);
    const upload=(await json('/api/uploads',admin.token,'POST',{name:'并发完成.bin',size:bytes.length,targetId:receiver.device.id})).data;
    const chunk=await fetch(`${base}/api/uploads/${upload.id}?offset=0`,{method:'PUT',headers:{Authorization:`Bearer ${admin.token}`,'Content-Type':'application/octet-stream'},body:bytes});
    assert.equal(chunk.status,200);
    const results=await Promise.all([json(`/api/uploads/${upload.id}/complete`,admin.token,'POST',{}),json(`/api/uploads/${upload.id}/complete`,admin.token,'POST',{})]);
    assert.ok(results.some(result=>result.status===200));
    assert.ok(results.every(result=>result.status===200||result.status===409));
    const state=(await json('/api/state',receiver.token)).data;
    assert.equal(state.inbox.filter(item=>item.id===upload.id).length,1);
    assert.equal(state.stats.receivedBytes,bytes.length);
    assert.equal(state.stats.sentBytes,bytes.length);
    const received=await fetch(base+state.inbox[0].url);
    assert.deepEqual(Buffer.from(await received.arrayBuffer()),bytes);
  });

  await t.test('无效设置不会部分修改主机名',async()=>{
    assert.equal((await json('/api/settings',admin.token,'PATCH',{name:'不应该生效',downloadDir:'relative-folder'})).status,400);
    assert.equal(instance.config.name,'安全回归主机');
    assert.equal((await json('/api/state',admin.token)).data.server.name,'安全回归主机');
  });
});

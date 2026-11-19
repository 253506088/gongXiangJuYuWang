'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises'),child=require('node:child_process');
const {randomBytes,randomUUID,createHash}=require('node:crypto'),{createApp}=require('../server');
const serial=process.env.ANDROID_BIGFILE_SERIAL||'emulator-5580';assert.match(serial,/^emulator-\d+$/);
const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe'),android={base:process.env.ANDROID_BIGFILE_URL||'http://127.0.0.1:55817'},windows={base:'http://127.0.0.1:55989'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),hash=buffer=>createHash('sha256').update(buffer).digest('hex');
async function api(device,route,method='GET',body){const headers={};if(device.token)headers.Authorization='Bearer '+device.token;if(body!==undefined){headers['Content-Type']=Buffer.isBuffer(body)?'application/octet-stream':'application/json';if(!Buffer.isBuffer(body))body=JSON.stringify(body);}const response=await fetch(device.base+route,{method,body,headers,signal:AbortSignal.timeout(60000)}),value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
async function until(probe,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const result=await probe();if(result)return result;await sleep(150);}throw Error('Timed out '+label);}
(async()=>{let node;const results=[];try{
  node=await createApp({port:55989,host:'127.0.0.1',name:'Windows 正式64MB互传主机',dataDir:path.join(__dirname,'test-fixtures','node-bigfile-'+Date.now()),discovery:false});await node.start();
  for(const device of [android,windows]){device.boot=await api(device,'/api/bootstrap?deviceId='+randomUUID());device.token=device.boot.token;}
  child.execFileSync(adb,['-s',serial,'reverse','tcp:55989','tcp:55989']);await api(android,'/api/peers/connect','POST',{url:windows.base});await api(windows,'/api/peers/connect','POST',{url:android.base});
  for(const [from,to,label] of [[windows,android,'Windows→Android'],[android,windows,'Android→Windows']]){
    const data=randomBytes(64*1024*1024+57),name='正式-'+label+'-'+Date.now()+'.bin';const upload=await api(from,'/api/uploads','POST',{name,size:data.length,targetId:'host:'+to.boot.server.id});for(let offset=0;offset<data.length;offset+=4*1024*1024)await api(from,`/api/uploads/${upload.id}?offset=${offset}`,'PUT',data.subarray(offset,Math.min(offset+4*1024*1024,data.length)));await api(from,`/api/uploads/${upload.id}/complete`,'POST',{});
    const record=await until(async()=>{const transfer=(await api(from,'/api/state')).transfers.find(t=>t.id===upload.id);assert.notEqual(transfer?.status,'error',transfer?.error);return transfer?.status==='complete'&&transfer;},label+' sender complete');assert.equal(record.deliveredBytes,data.length);
    let item=await until(async()=>(await api(to,'/api/state')).inbox.find(f=>f.name===name),label+' inbox');assert.equal(item.from,from.boot.server.name);const downloaded=await fetch(to.base+item.url,{signal:AbortSignal.timeout(60000)});assert.equal(downloaded.status,200);assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())),hash(data));
    if(to===android){item=await until(async()=>{const f=(await api(android,'/api/state')).inbox.find(f=>f.id===item.id);return f&&!f.saving&&f;},label+' public save');const publicHash=child.execFileSync(adb,['-s',serial,'shell',"sha256sum '/sdcard/Download/邻波/"+item.savedPath.split('/').at(-1)+"'"],{encoding:'utf8'}).trim().split(/\s+/)[0];assert.equal(publicHash,hash(data));}
    results.push({label,bytes:data.length,sha256:hash(data),phase:record.phase});console.log('PASS '+label+' real host 64MB+57B, acknowledged progress, inbox SHA256'+(to===android?', MediaStore SHA256':''));
  }
  await fs.writeFile(path.join(__dirname,'verify-bigfile-interop-result.json'),JSON.stringify(results,null,2));console.log('ALL ANDROID BIGFILE REAL INTEROP CHECKS PASSED');
}finally{if(node)await node.close();}})().catch(error=>{console.error(error);process.exitCode=1;});

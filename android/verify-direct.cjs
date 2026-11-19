'use strict';
// The two Android hosts are real release APK services in independent API 30
// emulators. Node only prepares input and checks bytes; Android forwards files.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const child=require('node:child_process');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {createApp}=require('../server');
const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');
const devices=[{serial:'emulator-5580',port:55817},{serial:'emulator-5582',port:55819}];
const fixtures=path.join(__dirname,'direct-fixtures');
const stage=process.env.ANDROID_DIRECT_STAGE||'all';
const hash=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const adbCall=(d,...args)=>{assert.match(d.serial,/^emulator-\d+$/);return child.execFileSync(adb,['-s',d.serial,...args],{encoding:'utf8'});};
const shellQuote=s=>"'"+s.replace(/'/g,"'\\''")+"'";
async function api(d,route,method='GET',body,auth=d.token,extra={}){
  const headers={...extra};if(auth)headers.Authorization='Bearer '+auth;
  if(body!==undefined){headers['Content-Type']=Buffer.isBuffer(body)?'application/octet-stream':'application/json';if(!Buffer.isBuffer(body))body=JSON.stringify(body);}
  // Node fetch normalizes Host; raw HTTP is needed to model a LAN browser
  // arriving at the forwarded APK instead of its localhost admin authority.
  if(extra.Host)return new Promise((resolve,reject)=>{const request=require('node:http').request(d.base+route,{method,headers},response=>{let text='';response.setEncoding('utf8');response.on('data',part=>text+=part);response.on('end',()=>{try{const value=JSON.parse(text);assert.ok(response.statusCode<400,text);resolve(value);}catch(e){reject(e);}});});request.on('error',reject);request.end(body);});
  const response=await fetch(d.base+route,{method,body,headers,signal:AbortSignal.timeout(60000)});
  const value=await response.json();assert.ok(response.ok,`${d.base}${route}: ${response.status} ${JSON.stringify(value)}`);return value;
}
async function until(probe,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){const result=await probe();if(result)return result;await sleep(250);}throw new Error('Timed out: '+label);}
async function connectAndroidPeers(){for(const d of devices)for(const other of devices)if(d!==other){adbCall(d,'reverse','tcp:'+other.port,'tcp:'+other.port);await api(d,'/api/peers/connect','POST',{url:'http://127.0.0.1:'+other.port});}}
async function download(d,file,data){const r=await fetch(d.base+file.url,{signal:AbortSignal.timeout(60000)});assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(data));}
async function send(from,to,label){
  const data=randomBytes(4194304+451),name=label+'-'+Date.now()+'.bin';
  const u=await api(from,'/api/uploads','POST',{name,size:data.length,targetId:'host:'+to.boot.server.id});
  for(let offset=0;offset<data.length;offset+=4194304)await api(from,`/api/uploads/${u.id}?offset=${offset}`,'PUT',data.subarray(offset,offset+4194304));
  const done=await api(from,`/api/uploads/${u.id}/complete`,'POST',{});assert.equal(done.status,'sending');
  let file=await until(async()=>((await api(to,'/api/state','GET',undefined,null)).inbox.find(f=>f.name===name)),label+' inbox');
  const tx=await until(async()=>{const t=(await api(from,'/api/state')).transfers.find(t=>t.id===u.id);if(t?.status==='error')throw new Error(t.error);return t?.status==='complete'&&t;},label+' sender completion');
  assert.equal(tx.received,data.length);await download(to,file,data);assert.equal(file.from,from.boot.server.name);
  if(to.serial){file=await until(async()=>{const item=(await api(to,'/api/state','GET',undefined,null)).inbox.find(f=>f.id===file.id);return item&&!item.saving&&item;},label+' public Downloads save',30000);const notification=adbCall(to,'shell','dumpsys','notification','--noredact');assert.ok(notification.includes(name),'system incoming notification '+name);const saved=adbCall(to,'shell','sha256sum '+shellQuote('/sdcard/Download/邻波/'+name));assert.equal(saved.trim().split(/\s+/)[0],hash(data),'automatically saved public Downloads file');}
  console.log('PASS '+label+': no pair request, native direct stream, 4 MiB chunks, sender completion, inbox SHA256'+(to.serial?', Android system notification':''));
  return file;
}
async function rangeChecks(d,route,data,label){
  let r=await fetch(d.base+route,{method:'HEAD'});assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),String(data.length));assert.equal((await r.arrayBuffer()).byteLength,0);
  r=await fetch(d.base+route,{headers:{Range:'bytes=512-1535'}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),`bytes 512-1535/${data.length}`);assert.equal(r.headers.get('content-type').split(';')[0],'video/mp4');assert.deepEqual(Buffer.from(await r.arrayBuffer()),data.subarray(512,1536));
  r=await fetch(d.base+route);assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(data));
  r=await fetch(d.base+route,{headers:{Range:`bytes=${data.length+1}-`}});assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),`bytes */${data.length}`);await r.text();
  console.log('PASS '+label+': anonymous MP4, HEAD, 206 Range, 416, complete SHA256');
}
(async()=>{
  await fs.mkdir(fixtures,{recursive:true});let node;
  try{
    for(const d of devices){d.base='http://127.0.0.1:'+d.port;adbCall(d,'forward','tcp:'+d.port,'tcp:53317');d.boot=await api(d,'/api/bootstrap?deviceId='+randomUUID()+'&name=Direct%20test','GET',undefined,null);d.token=d.boot.token;assert.equal(d.boot.server.version,'1.2.0');assert.equal(d.boot.admin,true);assert.equal(d.boot.capabilities.directConnect,true);assert.equal(d.boot.pairCode,undefined);assert.match(d.token,/^[a-f0-9]{64}$/);
      const remoteId=randomUUID(),remoteRoute='/api/bootstrap?deviceId='+remoteId+'&name=LAN%20client';const remote=await api(d,remoteRoute,'GET',undefined,null,{Host:'10.0.2.2:'+d.port});assert.equal(remote.paired,true);assert.equal(remote.admin,false);assert.match(remote.token,/^[a-f0-9]{64}$/);assert.equal(remote.pairCode,undefined);const reconnect=await api(d,remoteRoute,'GET',undefined,null,{Host:'10.0.2.2:'+d.port});assert.equal(reconnect.token,remote.token);assert.equal(reconnect.device.id,remote.device.id);d.remote=remote;const publicState=await api(d,'/api/state','GET',undefined,null);assert.equal(publicState.pairCode,undefined);assert.equal(publicState.fileLinks,undefined);console.log('PASS '+d.serial+': 1.2 bootstrap, LAN automatic stable session, public state, no PIN');
    }
    assert.notEqual(devices[0].boot.server.id,devices[1].boot.server.id);
    if(stage==='all'||stage==='native'){
    const privateData=randomBytes(179),privateName='private-browser-'+Date.now()+'.bin';const privateUpload=await api(devices[0],'/api/uploads','POST',{name:privateName,size:privateData.length,targetId:devices[0].remote.device.id});await api(devices[0],`/api/uploads/${privateUpload.id}?offset=0`,'PUT',privateData);await api(devices[0],`/api/uploads/${privateUpload.id}/complete`,'POST',{});const ownInbox=await api(devices[0],'/api/state','GET',undefined,devices[0].remote.token);const privateFile=ownInbox.inbox.find(f=>f.name===privateName);assert.ok(privateFile);const anonymous=await api(devices[0],'/api/state','GET',undefined,null);assert.ok(!anonymous.inbox.some(f=>f.name===privateName));const privateDownload=await fetch(devices[0].base+'/api/inbox/'+privateFile.id+'/download');assert.ok([401,403].includes(privateDownload.status));await privateDownload.text();console.log('PASS public state/download excludes private browser inbox');
    for(const d of devices)for(const other of devices)if(d!==other){await api(d,'/api/peers/connect','POST',{url:'http://10.0.2.2:'+other.port});const found=(await api(d,'/api/state')).devices.find(x=>x.id==='host:'+other.boot.server.id);assert.ok(found);assert.equal(found.paired,true);}
    // API30 emulator NAT at 10.0.2.2 corrupts some large downstream reads.
    // Address discovery above still uses its LAN route; adb reverse preserves
    // bytes while invoking the identical native HTTP forwarding/proxy routes.
    await connectAndroidPeers();
    const direct=randomBytes(77031),name='匿名直接接收-'+Date.now()+'.bin';let r=await fetch(devices[1].base+`/api/peer/receive?name=${encodeURIComponent(name)}&size=${direct.length}&relativePath=${encodeURIComponent(name)}`,{method:'POST',body:direct,headers:{'Content-Type':'application/octet-stream','X-LinkWave-Name':encodeURIComponent('Direct Windows caller')}});assert.equal(r.status,200);const reply=await r.json();assert.equal(reply.status,'complete');const f=(await api(devices[1],'/api/state','GET',undefined,null)).inbox.find(x=>x.id===reply.id);assert.ok(f);await download(devices[1],f,direct);console.log('PASS anonymous peer/receive immediately persisted file and public inbox download SHA256');
    await send(devices[0],devices[1],'Android A → Android B');await send(devices[1],devices[0],'Android B → Android A');
    }
    if(stage==='native')return;
    await connectAndroidPeers();
    const nodeData=path.join(fixtures,'node-data-'+Date.now());node=await createApp({port:55917,host:'0.0.0.0',name:'Windows 免配对主机',dataDir:nodeData,discovery:false});await node.start();const windows={base:'http://127.0.0.1:55917'};windows.boot=await api(windows,'/api/bootstrap?deviceId='+randomUUID()+'&name=Windows%20direct','GET',undefined,null);windows.token=windows.boot.token;
    await api(windows,'/api/peers/connect','POST',{url:devices[0].base});adbCall(devices[0],'reverse','tcp:55917','tcp:55917');await api(devices[0],'/api/peers/connect','POST',{url:'http://127.0.0.1:55917'});
    if(stage!=='shared'){await send(windows,devices[0],'Windows → Android');await send(devices[0],windows,'Android → Windows');}
    const sdkMedia=path.join(process.env.LOCALAPPDATA,'Android/Sdk/emulator/resources/macroPreviews/Track_horizontal_plane.mp4');const media=await fs.readFile(sdkMedia);const mediaPath=path.join(fixtures,'direct-video.mp4');await fs.writeFile(mediaPath,media);adbCall(devices[0],'shell','mkdir','-p','/sdcard/LinkWaveSAF');adbCall(devices[0],'push',mediaPath,'/sdcard/LinkWaveSAF/direct-video.mp4');
    const androidShare=(await api(devices[0],'/api/shared-library','GET',undefined,null)).shares.find(s=>s.name==='LinkWaveSAF');assert.ok(androidShare,'A must have the persisted, real SAF folder grant from earlier validation');const localBrowse=await api(devices[0],`/api/shares/${androidShare.id}/browse?path=`,'GET',undefined,null);assert.ok(localBrowse.entries.some(e=>e.name==='direct-video.mp4'));let traversal=await fetch(devices[0].base+`/api/shares/${androidShare.id}/browse?path=..%2FDownload`);assert.equal(traversal.status,400);await traversal.text();await rangeChecks(devices[0],`/api/shares/${androidShare.id}/file?path=direct-video.mp4`,media,'Android SAF local service');
    for(const d of [devices[1],windows]){const s=await until(async()=>((await api(d,'/api/state','GET',undefined,null)).shares.find(s=>s.hostId===devices[0].boot.server.id&&s.id===androidShare.id)),d.base+' automatic Android share',8000);assert.equal(s.remote,true);assert.equal(s.sourceName,devices[0].boot.server.name);const route=`/api/peers/${s.hostId}/shares/${s.id}`;const b=await api(d,route+'/browse?path=','GET',undefined,null);assert.ok(b.entries.some(e=>e.name==='direct-video.mp4'));await rangeChecks(d,route+'/file?path=direct-video.mp4',media,d.base+' Android share proxy');const dl=await fetch(d.base+route+'/download?path=direct-video.mp4',{method:'HEAD'});assert.equal(dl.status,200);assert.match(dl.headers.get('content-disposition'),/^attachment/);}
    const windowsShare=await api(windows,'/api/shares','POST',{path:fixtures,name:'Windows direct media'});const remote=await until(async()=>((await api(devices[0],'/api/state','GET',undefined,null)).shares.find(s=>s.hostId===windows.boot.server.id&&s.id===windowsShare.id)),'automatic Windows share on Android',8000);await rangeChecks(devices[0],`/api/peers/${remote.hostId}/shares/${remote.id}/file?path=direct-video.mp4`,media,'Android proxy of Windows share');
    const exported=await api(devices[0],'/api/shared-library','GET',undefined,null);assert.ok(exported.shares.every(s=>!s.remote&&!s.hostId),'shared library exports local shares only');console.log('PASS local-only library prevents cycles, Android SAF and Windows shares automatically visible within 8s');
    console.log('ALL ANDROID 1.2 DIRECT CONNECTION CHECKS PASSED');
  }finally{if(node)await node.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

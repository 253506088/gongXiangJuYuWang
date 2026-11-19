'use strict';
// Run after installing and opening the APK on an emulator, with adb forward
// tcp:55317 tcp:53317 and emulator redir udp:55318:53318 configured.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const dgram=require('node:dgram');
const child=require('node:child_process');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const {createApp}=require('../server');
const base=process.env.ANDROID_TEST_URL||'http://127.0.0.1:55317';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=b=>createHash('sha256').update(b).digest('hex');
let token;
async function req(url,method='GET',body,auth=token,extra={}){
  const headers={...extra};if(auth)headers.Authorization='Bearer '+auth;
  if(body!==undefined&&!Buffer.isBuffer(body)){headers['Content-Type']='application/json';body=JSON.stringify(body);}else if(Buffer.isBuffer(body))headers['Content-Type']='application/octet-stream';
  const r=await fetch(url,{method,body,headers,signal:AbortSignal.timeout(60000)});const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}if(!r.ok)throw Object.assign(new Error(JSON.stringify(value)),{status:r.status,value});return value;
}
async function upload(url,auth,name,data,target='server'){
  const u=await req(url+'/api/uploads','POST',{name,size:data.length,relativePath:name,targetId:target},auth);
  for(let offset=u.offset;offset<data.length;offset+=4194304)await req(url+`/api/uploads/${u.id}?offset=${offset}`,'PUT',data.subarray(offset,offset+4194304),auth);
  return {u,result:await req(url+`/api/uploads/${u.id}/complete`,'POST',{},auth)};
}
(async()=>{
  const runId=Date.now().toString(36);
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'linkwave-android-interop-'));let node;const udp=dgram.createSocket('udp4');let timer;
  try{
    const boot=await req(base+'/api/bootstrap?deviceId='+randomUUID()+'&name=Android%20API%20Test','GET',undefined,null);token=boot.token;
    assert.equal(boot.admin,true);assert.match(token,/^[a-f0-9]{64}$/);assert.equal(boot.server.platform,'android');console.log('PASS Android bootstrap, local admin, 64hex credentials');
    const remote=await new Promise((resolve,reject)=>require('node:http').get(base+'/api/bootstrap',{headers:{Host:'rebinding.invalid:55317'}},r=>{let data='';r.on('data',b=>data+=b);r.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject));assert.equal(remote.paired,false);assert.equal(remote.token,undefined);console.log('PASS DNS rebinding blocked');
    await assert.rejects(req(base+'/api/state','GET',undefined,token,{Origin:'http://evil.invalid'}),e=>e.status===403);console.log('PASS foreign Origin blocked');
    const paired=await req(base+'/api/pair','POST',{code:boot.pairCode,deviceId:boot.device.id,name:'Second browser'},null);assert.notEqual(paired.device.id,boot.device.id);assert.equal(paired.admin,false);console.log('PASS pair collision cannot impersonate device');
    const qr=await fetch(base+'/api/qr',{headers:{Authorization:'Bearer '+token}});assert.equal(qr.status,200);assert.equal(qr.headers.get('content-type'),'image/png');assert.ok((await qr.arrayBuffer()).byteLength>1000);console.log('PASS QR image');
    const sample=randomBytes(4194304+831),name='安卓 binary 样本-'+runId+'.bin';const local=await upload(base,token,name,sample);
    assert.equal(local.result.status,'complete');let state=await req(base+'/api/state');let received=state.inbox.find(f=>f.name===name);assert.ok(received);const actual=Buffer.from(await(await fetch(base+received.url)).arrayBuffer());assert.equal(hash(actual),hash(sample));console.log('PASS binary chunk upload and inbox download SHA256');
    const range=await fetch(base+received.url,{headers:{Range:'bytes=4096-5119'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),`bytes 4096-5119/${sample.length}`);assert.deepEqual(Buffer.from(await range.arrayBuffer()),sample.subarray(4096,5120));console.log('PASS Android byte-range 206');
    await assert.rejects(req(base+`/api/inbox/${received.id}`,'DELETE',undefined,paired.token),e=>e.status===403);console.log('PASS unrelated browser cannot delete server inbox');
    node=await createApp({port:55417,name:'Node 电脑 Interop',dataDir,discovery:false,peers:[{id:boot.server.id,name:boot.server.name,platform:'android',ip:'127.0.0.1',url:base,lastSeen:Date.now()}]});await node.start();const nodeBase='http://127.0.0.1:55417';
    const nb=await req(nodeBase+'/api/bootstrap?deviceId='+randomUUID()+'&name=Node%20Test','GET',undefined,null);
    await req(nodeBase+'/api/peers/pair','POST',{id:'host:'+boot.server.id,code:boot.pairCode},nb.token);
    const send=randomBytes(600123),sentName='Windows → Android 二进制-'+runId+'.bin';const toAndroid=await upload(nodeBase,nb.token,sentName,send,'host:'+boot.server.id);assert.equal(toAndroid.result.status,'sending');
    for(let i=0;i<40;i++){state=await req(base+'/api/state');received=state.inbox.find(f=>f.name===sentName);if(received)break;await sleep(250);}assert.ok(received,'Node to Android receive');assert.equal(hash(Buffer.from(await(await fetch(base+received.url)).arrayBuffer())),hash(send));console.log('PASS Node → Android peer pairing and streaming SHA256');
    // Emulator Wi-Fi uses 10.0.2.16, while emulator UDP redirection targets the
    // inactive .15 radio interface. Inject the actual UDP packet locally and
    // reverse the Node TCP port; real Wi-Fi discovery uses the same receiver.
    const adb=process.env.ANDROID_TEST_ADB||path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');const serial=process.env.ANDROID_TEST_SERIAL||'emulator-5570';assert.ok(serial.startsWith('emulator-'));
    child.execFileSync(adb,['-s',serial,'reverse','tcp:55417','tcp:55417']);
    const packet=Buffer.from(JSON.stringify({app:'linkwave',version:1,id:nb.server.id,name:nb.server.name,port:55417,platform:'Windows'})+'\n');const announce=()=>{const p=child.spawn(adb,['-s',serial,'shell','toybox','nc','-u','-w','1','-q','1','127.0.0.1','53318'],{stdio:['pipe','ignore','ignore']});p.stdin.on('error',()=>{});p.stdin.end(packet);};announce();timer=setInterval(announce,2000);
    let peer;for(let i=0;i<30;i++){state=await req(base+'/api/state');peer=state.devices.find(x=>x.id==='host:'+nb.server.id);if(peer)break;await sleep(250);}assert.ok(peer,'Android discovered Node UDP');assert.equal(peer.url,'http://127.0.0.1:55417');console.log('PASS Android UDP host discovery (emulator NAT proxied)');
    await req(base+'/api/peers/pair','POST',{id:peer.id,code:nb.pairCode});
    const reverse=randomBytes(500543),reverseName='Android → Windows 二进制-'+runId+'.bin';const toNode=await upload(base,token,reverseName,reverse,peer.id);assert.equal(toNode.result.status,'sending');
    let nf;for(let i=0;i<40;i++){const ns=await req(nodeBase+'/api/state','GET',undefined,nb.token);nf=ns.inbox.find(f=>f.name===reverseName);if(nf)break;await sleep(250);}assert.ok(nf,'Android to Node receive');const got=Buffer.from(await(await fetch(nodeBase+nf.url)).arrayBuffer());assert.equal(hash(got),hash(reverse));assert.equal(nf.from,boot.server.name);console.log('PASS Android → Node peer pairing and streaming SHA256, Unicode sender name');
    const resumeData=randomBytes(16384),resumeName='restart-resume-'+runId+'.bin';const partial=await req(base+'/api/uploads','POST',{name:resumeName,size:resumeData.length,targetId:'server'});await req(base+`/api/uploads/${partial.id}?offset=0`,'PUT',resumeData.subarray(0,2048));
    child.execFileSync(adb,['-s',serial,'shell','am','force-stop','com.linkwave.app']);child.execFileSync(adb,['-s',serial,'shell','am','start','-n','com.linkwave.app/.MainActivity']);
    let restored;for(let i=0;i<30;i++){try{restored=await req(base+`/api/uploads/${partial.id}`);break;}catch{await sleep(250);}}assert.ok(restored);assert.equal(restored.offset,2048);await req(base+`/api/uploads/${partial.id}?offset=2048`,'PUT',resumeData.subarray(2048));await req(base+`/api/uploads/${partial.id}/complete`,'POST',{});state=await req(base+'/api/state');const resumed=state.inbox.find(x=>x.name===resumeName);assert.equal(hash(Buffer.from(await(await fetch(base+resumed.url)).arrayBuffer())),hash(resumeData));console.log('PASS Android process restart preserves credentials and resumes exact byte offset');
    const saf=state.shares.find(x=>x.name==='LinkWaveSAF');if(saf){const listing=await req(base+`/api/shares/${saf.id}/browse?path=`);const entry=listing.entries.find(x=>x.name==='range-video.mp4');assert.ok(entry);const testFile=await fs.readFile(path.join(os.tmpdir(),'linkwave-saf-range.bin'));const media=await fetch(base+`/api/shares/${saf.id}/file?path=range-video.mp4&token=${token}`,{headers:{Range:'bytes=512-1535'}});assert.equal(media.status,206);assert.equal(media.headers.get('content-type'),'video/mp4');assert.deepEqual(Buffer.from(await media.arrayBuffer()),testFile.subarray(512,1536));await assert.rejects(req(base+`/api/shares/${saf.id}/browse?path=..%2FDownload`),e=>e.status===400);console.log('PASS native SAF directory authorization survives restart; browse, video MIME, Range and traversal guard');}
    await req(base+`/api/inbox/${received.id}`,'DELETE');await req(base+`/api/inbox/${state.inbox.find(x=>x.name===name)?.id}`,'DELETE').catch(()=>{});
    console.log('ALL ANDROID EMULATOR INTEROP CHECKS PASSED');
  }finally{clearInterval(timer);udp.close();if(node)await node.close();await fs.rm(dataDir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

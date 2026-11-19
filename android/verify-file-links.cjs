'use strict';
// Only targets an explicitly named emulator. Its SAF chooser grants the real
// app read access; adb prepares fixtures and controls that emulator's UI.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const child=require('node:child_process');
const {randomBytes,randomUUID,createHash}=require('node:crypto');
const serial=process.env.ANDROID_TEST_SERIAL||'emulator-5580';
assert.match(serial,/^emulator-\d+$/);
const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');
const base=process.env.ANDROID_TEST_URL||'http://127.0.0.1:55817';
const fixtures=path.join(__dirname,'file-link-fixtures');
const sourcePath='/sdcard/LinkWaveSAF/linkwave-1.1-source.bin';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const adbCall=(...args)=>child.execFileSync(adb,['-s',serial,...args],{encoding:'utf8'});
const hash=b=>createHash('sha256').update(b).digest('hex');
let token;
async function request(route,method='GET',body,auth=token,headers={}){
  if(auth)headers.Authorization='Bearer '+auth;
  if(body!==undefined){headers['Content-Type']='application/json';body=JSON.stringify(body);}
  // Node fetch normalizes Host; a raw request models a LAN authority while
  // retaining the forwarded emulator socket used by these release-APK tests.
  if(headers.Host)return new Promise((resolve,reject)=>{const req=require('node:http').request(base+route,{method,headers},res=>{let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>{try{resolve({response:{status:res.statusCode},value:JSON.parse(text)});}catch(e){reject(e);}});});req.on('error',reject);req.end(body);});
  const response=await fetch(base+route,{method,body,headers,signal:AbortSignal.timeout(15000)});
  const value=await response.json();return {response,value};
}
async function ok(route,method,body,auth,headers){const {response,value}=await request(route,method,body,auth,headers);assert.equal(response.status,200,JSON.stringify(value));return value;}
async function status(route,expected,method='GET',body,auth=token){const r=await request(route,method,body,auth);assert.equal(r.response.status,expected,JSON.stringify(r.value));}
async function waitState(){for(let n=0;n<40;n++){try{return await ok('/api/state');}catch{await sleep(250);}}throw new Error('Android server did not restart');}
function restart(){adbCall('shell','am','force-stop','com.linkwave.app');adbCall('shell','am','start','-n','com.linkwave.app/.MainActivity');}
async function pickFixture(){
  const previous=(await waitState()).pickedFile?.selectionId;
  if(adbCall('shell','dumpsys','window','windows').match(/mCurrentFocus[^\n]*com\.android\.documentsui/))adbCall('shell','input','keyevent','4');
  assert.deepEqual(await ok('/api/pick-file','POST',{}),{pending:true});
  for(let attempt=0;attempt<12;attempt++){
    await sleep(400);adbCall('shell','uiautomator','dump','/sdcard/linkwave-file-picker.xml');
    const xml=adbCall('shell','cat','/sdcard/linkwave-file-picker.xml');
    const match=xml.match(/<node\b[^>]*text="linkwave-1\.1-source\.bin"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if(match){const [,x1,y1,x2,y2]=match.map(Number);adbCall('shell','input','tap',String(Math.floor((x1+x2)/2)),String(Math.floor((y1+y2)/2)));adbCall('shell','input','keyevent','20');adbCall('shell','input','keyevent','66');break;}
    if(attempt===11)throw new Error('SAF fixture is not visible. Open the LinkWaveSAF folder on this emulator.');
  }
  for(let attempt=0;attempt<30;attempt++){const state=await waitState();if(state.pickedFile?.name==='linkwave-1.1-source.bin'&&state.pickedFile.selectionId!==previous)return state.pickedFile;await sleep(250);}
  throw new Error('Native SAF selection did not reach state');
}
(async()=>{
  fs.mkdirSync(fixtures,{recursive:true});const fixture=path.join(fixtures,'source.bin');const sample=randomBytes(4194304+931);fs.writeFileSync(fixture,sample);
  adbCall('shell','mkdir','-p','/sdcard/LinkWaveSAF');adbCall('push',fixture,sourcePath);
  const boot=await ok('/api/bootstrap?deviceId='+randomUUID(),undefined,undefined,null);token=boot.token;
  assert.equal(boot.server.version,'1.4.0');assert.equal(boot.admin,true);
  const picked=await pickFixture();assert.match(picked.path,/^content:\/\//);assert.equal(picked.size,sample.length);assert.ok(picked.selectionId);
  for(const old of (await ok('/api/file-links')).links.filter(l=>l.name==='linkwave-1.1-source.bin'))await ok('/api/file-links/'+old.id,'DELETE');
  const before=await waitState();console.log('PASS real ACTION_OPEN_DOCUMENT, transient native state, 1.4.0 bootstrap');
  const permanent=await ok('/api/file-links','POST',{path:picked.path,expiresIn:0});
  const day=await ok('/api/file-links','POST',{path:picked.path});
  const hour=await ok('/api/file-links','POST',{path:picked.path,expiresIn:3600});
  const week=await ok('/api/file-links','POST',{path:picked.path,expiresIn:604800});
  assert.match(permanent.id,/^[a-f0-9]{32}$/);assert.equal(permanent.expiresAt,null);assert.equal(permanent.status,'active');assert.equal(permanent.downloads,0);
  assert.equal(permanent.url,new URL('/d/'+permanent.id+'/'+encodeURIComponent(permanent.name),boot.urls[0]).href);assert.ok(!permanent.url.includes(token));
  for(const [link,seconds] of [[day,86400],[hour,3600],[week,604800]])assert.ok(Math.abs(Date.parse(link.expiresAt)-Date.parse(link.createdAt)-seconds*1000)<2000);
  await status('/api/file-links',400,'POST',{path:picked.path,expiresIn:2});await status('/api/file-links',400,'POST',{path:picked.path,expiresIn:'3600'});
  await status('/api/file-links',400,'POST',{path:'/sdcard/LinkWaveSAF'});await status('/api/file-links',400,'POST',{path:'content://com.android.externalstorage.documents/tree/primary%3ALinkWaveSAF'});
  const after=await waitState();assert.equal(after.inbox.length,before.inbox.length);assert.equal(after.transfers.length,before.transfers.length);
  console.log('PASS random scoped URL, default/all expiries, directory and unauthorised filesystem rejection, no upload/copy');
  const remote=await ok('/api/bootstrap?deviceId='+randomUUID()+'&name=Remote%20link%20inventory%20test',undefined,undefined,null,{Host:'10.0.2.2:'+new URL(base).port});
  await status('/api/file-links',401,'GET',undefined,null);await status('/api/file-links',403,'GET',undefined,remote.token);await status('/api/pick-file',403,'POST',{},remote.token);
  await status('/api/file-links',403,'POST',{path:picked.path},remote.token);await status('/api/file-links/'+permanent.id,403,'DELETE',undefined,remote.token);
  const remoteState=await ok('/api/state',undefined,undefined,remote.token);assert.equal(remoteState.fileLinks,undefined);assert.equal(remoteState.pickedFile,undefined);
  console.log('PASS automatically connected LAN clients cannot inventory, select, create, revoke or see source metadata');
  const route='/d/'+permanent.id+'/'+encodeURIComponent(permanent.name);
  let r=await fetch(base+route,{signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(sample));
  assert.match(r.headers.get('content-disposition'),/^attachment;/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.match(r.headers.get('content-security-policy'),/sandbox/);assert.equal(r.headers.get('content-length'),String(sample.length));
  r=await fetch(base+route,{method:'HEAD'});assert.equal(r.status,200);assert.equal(r.headers.get('content-length'),String(sample.length));assert.equal((await r.arrayBuffer()).byteLength,0);
  for(const [range,expected] of [['bytes=4096-5119',sample.subarray(4096,5120)],['bytes=-31',sample.subarray(-31)],['bytes=4194304-',sample.subarray(4194304)]]){
    r=await fetch(base+route,{headers:{Range:range}});assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),expected);
  }
  r=await fetch(base+route,{headers:{Range:'bytes=99999999-'}});assert.equal(r.status,416);assert.equal(r.headers.get('content-range'),'bytes */'+sample.length);await r.text();
  assert.equal((await ok('/api/file-links')).links.find(l=>l.id===permanent.id).downloads,1);
  r=await fetch(base+'/d/'+permanent.id+'/another-file.html?path=%2Fsdcard%2Fsecret.txt');assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(sample));
  await status('/d/'+'a'.repeat(32),404,'GET',undefined,null);await status('/d/not-a-link',404,'GET',undefined,null);
  assert.equal((await ok('/api/file-links')).links.find(l=>l.id===permanent.id).downloads,2);
  console.log('PASS anonymous SHA256 download, attachment/security headers, HEAD, three Range variants, 416, query/name cannot redirect, accurate full-GET counts');
  restart();let restored=await waitState();assert.equal(restored.pickedFile,undefined);assert.equal(restored.fileLinks.find(l=>l.id===permanent.id).downloads,2);
  r=await fetch(base+route);assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(sample));
  console.log('PASS process restart preserves link, SAF permission, download count; pickedFile remains transient');
  // APK has no test-only expiry override. Inject a past expiry into this one
  // emulator's stored metadata while stopped, then exercise the real loader.
  adbCall('shell','am','force-stop','com.linkwave.app');const statePath='/data/user/0/com.linkwave.app/files/state.json';const state=JSON.parse(adbCall('shell','cat',statePath));state.fileLinks.find(l=>l.id===hour.id).expiresAt=Date.now()-1000;
  const edited=path.join(fixtures,'state.json');fs.writeFileSync(edited,JSON.stringify(state));adbCall('push',edited,statePath);adbCall('shell','am','start','-n','com.linkwave.app/.MainActivity');await waitState();
  await status('/d/'+hour.id,410,'GET',undefined,null);assert.equal((await ok('/api/file-links')).links.find(l=>l.id===hour.id).status,'expired');restart();await waitState();await status('/d/'+hour.id,410,'GET',undefined,null);
  console.log('PASS past expiry returns 410 and persists across two restarts (fixture expiry injected while stopped)');
  await ok('/api/file-links/'+permanent.id,'DELETE');await status(route,404,'GET',undefined,null);assert.equal(adbCall('shell','sha256sum',sourcePath).split(' ')[0],hash(sample));
  restart();await waitState();await status(route,404,'GET',undefined,null);console.log('PASS revoke immediately returns 404, original file remains intact, revocation persists');
  const replacement=path.join(fixtures,'replacement.bin');fs.writeFileSync(replacement,randomBytes(491));adbCall('push',replacement,sourcePath+'.replacement');adbCall('shell','mv',sourcePath+'.replacement',sourcePath);
  await status('/d/'+day.id,404,'GET',undefined,null);assert.equal((await ok('/api/file-links')).links.find(l=>l.id===day.id).status,'missing');console.log('PASS replaced file at same document path is rejected by bound device/inode');
  for(const link of [day,hour,week])await ok('/api/file-links/'+link.id,'DELETE');
  const fixtureHash=adbCall('shell','sha256sum',sourcePath).split(' ')[0];assert.equal(fixtureHash,hash(fs.readFileSync(replacement)));
  console.log('ALL ANDROID 1.1 FILE LINK CHECKS PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});

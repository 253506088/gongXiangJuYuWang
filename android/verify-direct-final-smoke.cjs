'use strict';
const assert=require('node:assert/strict'),child=require('node:child_process'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');
const devices=[{serial:'emulator-5580',base:'http://127.0.0.1:55817'},{serial:'emulator-5582',base:'http://127.0.0.1:55819'}].filter(d=>!process.env.ANDROID_SMOKE_SERIALS||process.env.ANDROID_SMOKE_SERIALS.split(',').includes(d.serial));assert.ok(devices.length);
const call=(d,...args)=>{assert.match(d.serial,/^emulator-\d+$/);return child.execFileSync(adb,['-s',d.serial,...args],{encoding:'utf8'});};
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const state=async d=>(await fetch(d.base+'/api/state')).json();
async function alive(d){for(let n=0;n<40;n++){try{const boot=await(await fetch(d.base+'/api/bootstrap?deviceId=final-release-smoke')).json();assert.equal(boot.server.version,'1.4.0');return boot;}catch{await sleep(200);}}throw Error('service did not resume');}
(async()=>{
  const a=devices[0];call(a,'shell','am','start','-n','com.linkwave.app/.MainActivity');await alive(a);const before=await state(a),ids=before.inbox.map(f=>f.id).sort();
  call(a,'shell','input','keyevent','3');const stopped=child.spawnSync(adb,['-s',a.serial,'shell','am','stopservice','-n','com.linkwave.app/.HostService'],{encoding:'utf8'});assert.match(stopped.stdout+stopped.stderr,/Service stopped/); // API30 am returns 255 even when it reports success.
  let offline=false;for(let n=0;n<30&&!offline;n++){try{await fetch(a.base+'/api/health',{signal:AbortSignal.timeout(300)});await sleep(100);}catch{offline=true;}}assert.equal(offline,true);
  call(a,'shell','am','start','-n','com.linkwave.app/.MainActivity');const resumed=await alive(a);assert.equal(resumed.server.id,before.server.id);assert.deepEqual((await state(a)).inbox.map(f=>f.id).sort(),ids);
  console.log('PASS final release: background → stop HostService → resume existing Activity restarted same serverId and preserved inbox');
  for(const d of devices){
    await alive(d);const name='最终版自动收件-'+Date.now()+'.bin',data=crypto.randomBytes(9731);const response=await fetch(d.base+'/api/peer/receive?name='+encodeURIComponent(name)+'&size='+data.length+'&relativePath='+encodeURIComponent(name),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-LinkWave-Name':encodeURIComponent('Windows 最终验证')},body:data});assert.equal(response.status,200);const reply=await response.json();assert.equal(reply.status,'complete');assert.ok((await state(d)).inbox.some(f=>f.id===reply.id));
    for(let n=0;n<120;n++){const item=(await state(d)).inbox.find(f=>f.id===reply.id);if(item&&!item.saving)break;assert.ok(n<119,'public Downloads copy finished');await sleep(250);}const saved=call(d,'shell',"sha256sum '/sdcard/Download/邻波/"+name+"'");assert.equal(saved.trim().split(/\s+/)[0],hash(data));assert.ok(call(d,'shell','dumpsys','notification','--noredact').includes(name));await sleep(1200);
    call(d,'shell','screencap','-p','/sdcard/linkwave-direct-release-inbox.png');call(d,'pull','/sdcard/linkwave-direct-release-inbox.png',path.join(__dirname,'preview-direct-release-inbox-'+d.serial+'.png'));
    const css=await(await fetch(d.base+'/styles.css')).arrayBuffer();assert.equal(hash(Buffer.from(css)),hash(fs.readFileSync(path.join(__dirname,'../public/styles.css'))));const packageFlags=call(d,'shell','dumpsys','package','com.linkwave.app').match(/^\s*flags=([^\n]+)/m)?.[1];assert.ok(packageFlags&&!packageFlags.includes('DEBUGGABLE'),'final release package is not debuggable');
    console.log('PASS '+d.serial+' final release: auto receipt, system notification, public Downloads SHA256, served final CSS hash, package without DEBUGGABLE');
  }
  console.log('ALL FINAL ANDROID RELEASE SMOKE CHECKS PASSED');
})().catch(error=>{console.error(error);process.exitCode=1;});

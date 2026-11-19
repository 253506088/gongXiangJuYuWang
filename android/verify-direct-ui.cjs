'use strict';
// Instrument a debug APK, or the release on a ro.debuggable API30 system image
// that exposes WebView CDP despite non-debuggable app flags. Normal release
// builds explicitly call setWebContentsDebuggingEnabled(false).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),child=require('node:child_process');
const {randomUUID,randomBytes,createHash}=require('node:crypto');
const adb=path.join(process.env.LOCALAPPDATA,'Android/Sdk/platform-tools/adb.exe');
const a={serial:'emulator-5580',base:'http://127.0.0.1:55817'},b={serial:'emulator-5582',base:'http://127.0.0.1:55819'};
const mediaName=process.env.ANDROID_UI_MEDIA_FILE||'direct-playable.mp4';
const publicUrl=value=>{const u=new URL(value);u.searchParams.delete('token');return u.href;};
const adbCall=(d,...args)=>{assert.match(d.serial,/^emulator-\d+$/);return child.execFileSync(adb,['-s',d.serial,...args],{encoding:'utf8'});};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function api(d,route,method='GET',body){const headers={};if(d.token)headers.Authorization='Bearer '+d.token;if(body!==undefined){headers['Content-Type']=Buffer.isBuffer(body)?'application/octet-stream':'application/json';if(!Buffer.isBuffer(body))body=JSON.stringify(body);}const r=await fetch(d.base+route,{method,body,headers,signal:AbortSignal.timeout(60000)});const j=await r.json();assert.ok(r.ok,JSON.stringify(j));return j;}
async function until(probe,label,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){const value=await probe();if(value)return value;await sleep(250);}throw Error('Timed out: '+label);}
(async()=>{
  let ws;
  try{
    for(const d of [a,b]){d.boot=await api(d,'/api/bootstrap?deviceId='+randomUUID());d.token=d.boot.token;assert.equal(d.boot.server.version,'1.2.0');}
    adbCall(a,'reverse','tcp:55819','tcp:55819');adbCall(b,'reverse','tcp:55817','tcp:55817');await api(a,'/api/peers/connect','POST',{url:'http://127.0.0.1:55819'});await api(b,'/api/peers/connect','POST',{url:'http://127.0.0.1:55817'});
    const pid=adbCall(b,'shell','pidof','com.linkwave.app').trim();assert.match(pid,/^\d+$/);adbCall(b,'forward','tcp:55823','localabstract:webview_devtools_remote_'+pid);
    const pages=await(await fetch('http://127.0.0.1:55823/json/list')).json(),page=pages.find(p=>p.type==='page'&&p.url.startsWith('http://127.0.0.1:'));assert.ok(page);
    ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    let serial=0;const pending=new Map(),network=[],pageEvents=[];ws.addEventListener('message',event=>{const msg=JSON.parse(event.data);if(msg.id){const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(Error(JSON.stringify(msg.error))):p.resolve(msg.result);}}else if(msg.method?.startsWith('Network.'))network.push(msg);else if(msg.method?.startsWith('Page.'))pageEvents.push(msg);});
    const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async(expression,awaitPromise=false)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise,userGesture:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
    await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Page.enable');await cdp('Page.reload',{ignoreCache:true});await until(()=>pageEvents.some(e=>e.method==='Page.loadEventFired'),'WebView page load');await until(()=>evaluate('!!document.head&&!!document.querySelector("#view-transfer")'),'UI reloaded');
    if(process.env.ANDROID_UI_CSS_OVERLAY==='1'){const css=fs.readFileSync(path.join(__dirname,'../public/styles.css'),'utf8');await evaluate(`(()=>{const style=document.createElement('style');style.id='direct-qa-final-css';style.textContent=${JSON.stringify(css)};document.head.append(style)})()`);}
    await evaluate('document.querySelector("#player-modal")?.close();document.querySelector("[data-view=transfer]")?.click()');await until(()=>evaluate('document.querySelector("#view-transfer")?.classList.contains("active")'),'UI bootstrap');
    await evaluate('window.__inboxEvents=0;window.addEventListener("linkwave-inbox",()=>window.__inboxEvents++);document.querySelector("[data-view=media]").click()');
    assert.equal(await evaluate('location.hash'),'#media');
    const data=randomBytes(200171),name='直接收到-界面验证-'+Date.now()+'.bin';const upload=await api(a,'/api/uploads','POST',{name,size:data.length,targetId:'host:'+b.boot.server.id});await api(a,`/api/uploads/${upload.id}?offset=0`,'PUT',data);await api(a,`/api/uploads/${upload.id}/complete`,'POST',{});
    const receipt=await until(()=>evaluate(`(()=>{const title=document.querySelector('#inbox-notice-title').textContent;return window.__inboxEvents>0&&location.hash==='#transfer'&&!document.querySelector('#inbox-notice').hidden&&title.includes(${JSON.stringify(name)})&&document.querySelector('#inbox-list').textContent.includes(${JSON.stringify(name)})&&document.querySelector('#inbox-save-help').textContent.includes('文件已保存到手机')&&({events:window.__inboxEvents,title,location:document.querySelector('#inbox-location').textContent,help:document.querySelector('#inbox-save-help').textContent,nav:document.querySelector('#inbox-nav-count').textContent})})()`),'native inbox event and visible notice');
    assert.ok(Number(receipt.nav)>0);assert.match(receipt.location,/系统下载\/邻波/);assert.match(receipt.help,/文件已保存到手机/);await sleep(600);
    adbCall(b,'shell','screencap','-p','/sdcard/linkwave-direct-inbox.png');adbCall(b,'pull','/sdcard/linkwave-direct-inbox.png',path.join(__dirname,'preview-direct-inbox.png'));
    const notices=adbCall(b,'shell','dumpsys','notification','--noredact');assert.ok(notices.includes(name));const saved=adbCall(b,'shell',"sha256sum '/sdcard/Download/邻波/"+name+"'");assert.equal(saved.trim().split(/\s+/)[0],createHash('sha256').update(data).digest('hex'));
    console.log('PASS real Android WebView: peer host sent file, linkwave-inbox fired '+receipt.events+' time(s), switched media → transfer, visible receipt banner/list/unread badge, public Downloads SHA256, system notification');
    await evaluate('document.querySelector("[data-view=media]").click()');await until(()=>evaluate(`Array.from(document.querySelectorAll('.share-card')).some(n=>n.textContent.includes('LinkWaveSAF')&&n.textContent.includes('来自另一台设备'))`),'automatic remote SAF share in UI');
    await evaluate(`Array.from(document.querySelectorAll('.share-card')).find(n=>n.textContent.includes('LinkWaveSAF')&&n.textContent.includes('来自另一台设备')).click()`);await until(()=>evaluate(`!!document.querySelector(${JSON.stringify('[aria-label="打开文件 '+mediaName+'"]')})`),'remote folder rendered');
    await evaluate(`document.querySelector(${JSON.stringify('[aria-label="打开文件 '+mediaName+'"]')}).click()`);
    const loaded=await until(()=>evaluate(`(()=>{const v=document.querySelector('#player-content video');return v&&!v.error&&v.readyState>=2&&v.videoWidth>0&&v.duration>0&&({time:v.currentTime,duration:v.duration,width:v.videoWidth,height:v.videoHeight,src:v.currentSrc,ready:v.readyState})})()`),'MP4 decoded in native WebView',20000);assert.match(loaded.src,/\/api\/peers\//);
    await evaluate('document.querySelector("#player-content video").play()',true);await sleep(1200);const progressed=await evaluate('document.querySelector("#player-content video").currentTime');assert.ok(progressed>loaded.time+0.5,`video did not advance: ${loaded.time}→${progressed}`);
    const seek=Math.max(0.5,Math.min(loaded.duration-1,loaded.duration*0.7));await evaluate(`document.querySelector('#player-content video').currentTime=${seek}`);await until(()=>evaluate(`(()=>{const v=document.querySelector('#player-content video');return !v.seeking&&v.currentTime>=${seek}-0.3&&v.readyState>=2})()`),'seek playback');await sleep(500);
    const final=await evaluate(`(()=>{const v=document.querySelector('#player-content video');return {time:v.currentTime,duration:v.duration,ready:v.readyState,paused:v.paused,error:v.error?.code||null}})()`);assert.equal(final.error,null);assert.equal(final.paused,false);
    const mediaResponses=network.filter(e=>e.method==='Network.responseReceived'&&e.params.response.url.includes('/api/peers/')&&e.params.response.url.includes('/file?'));assert.ok(mediaResponses.some(e=>e.params.response.status===206),'native player should receive byte range 206');
    const layout=await evaluate(`(()=>{const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,width:r.width}};return {viewport:innerHeight,header:rect('.player-header'),close:rect('#player-close'),video:rect('#player-content video'),footer:rect('.player-footer')}})()`);assert.ok(layout.header.top>=0&&layout.close.top>=0&&layout.close.bottom<=layout.viewport,'player title and close button inside viewport');assert.ok(layout.video.bottom<=layout.viewport&&layout.footer.bottom<=layout.viewport,'video and download/subtitle controls inside viewport');
    await evaluate('document.querySelector("#player-content video").pause()');
    await sleep(300);
    adbCall(b,'shell','screencap','-p','/sdcard/linkwave-direct-video.png');adbCall(b,'pull','/sdcard/linkwave-direct-video.png',path.join(__dirname,'preview-direct-video.png'));
    console.log('PASS real Android WebView: remote SAF MP4 rendered '+loaded.width+'x'+loaded.height+', currentTime '+loaded.time.toFixed(2)+'→'+progressed.toFixed(2)+'s, seek '+seek.toFixed(2)+'→'+final.time.toFixed(2)+'s, readyState '+final.ready+', peer proxy response206');
    fs.writeFileSync(path.join(__dirname,'verify-direct-ui-result.json'),JSON.stringify({receipt,loaded:{...loaded,src:publicUrl(loaded.src)},progressed,seek,final,layout,mediaResponses:mediaResponses.map(e=>({url:publicUrl(e.params.response.url),status:e.params.response.status,mimeType:e.params.response.mimeType}))},null,2));
    console.log('PASS portrait player title/close/video/footer fit viewport '+layout.viewport.toFixed(1)+'px');
    console.log('ALL ANDROID 1.2 NATIVE WEBVIEW CHECKS PASSED');
  }finally{if(ws)ws.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

'use strict';
// Validate the actual EXE from an isolated directory without Node on PATH.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(read,accept,message,timeout=10000){
  const deadline=Date.now()+timeout;let value;
  do{value=await read();if(accept(value))return value;await pause(100);}while(Date.now()<deadline);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}
async function request(base,token,endpoint,body,method='POST'){
  const response=await fetch(base+endpoint,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':Buffer.isBuffer(body)?'application/octet-stream':'application/json'},body:Buffer.isBuffer(body)?body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;
}
const state=(base,token)=>request(base,token,'/api/state',undefined,'GET');

(async()=>{
  const original=path.resolve(process.argv[2]||'dist/LinkWave.exe');
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'linkwave-portable-'));
  const executable=path.join(folder,'LinkWave.exe');
  let child,peerChild;
  try{
    await fs.copyFile(original,executable);
    const launcher=path.join(folder,'启动Windows.bat');await fs.copyFile(path.resolve('启动Windows.bat'),launcher);
    child=spawn(process.env.ComSpec||'cmd.exe',['/d','/c','启动Windows.bat','--port','0','--no-open','--name','便携程序验证'],{cwd:folder,windowsHide:true,env:{...process.env,PATH:path.join(process.env.SystemRoot||'C:\\Windows','System32'),NODE_PATH:'',LINKWAVE_DATA_DIR:path.join(folder,'data')}});
    let log='';let failure;
    child.stdout.on('data',d=>{log+=d.toString();});child.stderr.on('data',d=>{log+=d.toString();});child.on('error',e=>{failure=e;});child.on('exit',code=>{if(code)failure=new Error(`EXE exited ${code}: ${log}`);});
    let base;
    for(let i=0;i<100;i++){if(failure)throw failure;const found=log.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(found){base=found[0];break;}await new Promise(r=>setTimeout(r,100));}
    assert.ok(base,`独立EXE未启动：${log}`);
    const health=await(await fetch(base+'/api/health')).json();assert.equal(health.ok,true);
    const page=await(await fetch(base)).text();assert.match(page,/邻波 LinkWave/);
    for(const asset of ['/app.js','/styles.css','/icon.svg'])assert.equal((await fetch(base+asset)).status,200);
    const boot=await(await fetch(base+'/api/bootstrap?deviceId='+crypto.randomUUID())).json();assert.equal(boot.admin,true);assert.equal(boot.capabilities.localFiles,true);
    const token=boot.token;
    const api=(endpoint,body,method='POST')=>request(base,token,endpoint,body,method);
    const data=crypto.randomBytes(1024*1024+23);
    const upload=await api('/api/uploads',{name:'便携 中文.bin',size:data.length,targetId:'server'});
    await api(`/api/uploads/${upload.id}?offset=0`,data,'PUT');await api(`/api/uploads/${upload.id}/complete`,{});
    const downloaded=Buffer.from(await(await fetch(base+`/api/inbox/${upload.id}/download?token=${token}`)).arrayBuffer());assert.deepEqual(downloaded,data);
    const qr=await fetch(base+'/api/qr?token='+token);assert.equal(qr.status,200);assert.equal(qr.headers.get('content-type'),'image/png');assert.ok((await qr.arrayBuffer()).byteLength>1000);
    const library=path.join(folder,'影片');await fs.mkdir(library);await fs.writeFile(path.join(library,'片段.mp4'),data);
    const subtitleFolder=path.join(library,'字幕'),fontFolder=path.join(subtitleFolder,'Fonts');await fs.mkdir(fontFolder,{recursive:true});
    const ass='[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.25,0:00:02.50,Default,,0,0,0,,{\\an8\\pos(960,90)}便携字幕, 中文\\N第二行\\h<&>\n';
    const assVtt='WEBVTT\n\n00:00:01.250 --> 00:00:02.500\n便携字幕, 中文\n第二行 &lt;&amp;&gt;\n';
    await fs.writeFile(path.join(subtitleFolder,'片段.ass'),Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(ass,'utf16le')]));
    await fs.writeFile(path.join(fontFolder,'测试字体.ttf'),'dummy-font-metadata');
    const share=await api('/api/shares',{path:library});
    const subtitleQuery=(filename,format)=>'?'+new URLSearchParams({path:filename,...(format?{format}:{})});
    const subtitles=await fetch(base+`/api/shares/${share.id}/subtitles`+subtitleQuery('片段.mp4'));assert.equal(subtitles.status,200);
    const subtitleMetadata=await subtitles.json();assert.equal(subtitleMetadata.tracks.length,1);assert.equal(subtitleMetadata.tracks[0].path,'字幕/片段.ass');assert.equal(subtitleMetadata.tracks[0].match,'exact');assert.deepEqual(subtitleMetadata.fonts,[{name:'测试字体.ttf',path:'字幕/Fonts/测试字体.ttf'}]);
    for(const [format,expected,type] of [['raw',ass,'plain'],['vtt',assVtt,'vtt']]){
      const response=await fetch(base+`/api/shares/${share.id}/subtitle`+subtitleQuery('字幕/片段.ass',format));assert.equal(response.status,200);assert.match(response.headers.get('content-type'),new RegExp('^text/'+type+'; charset=utf-8'));assert.match(response.headers.get('content-security-policy'),/sandbox/);assert.equal(await response.text(),expected);
    }
    const range=await fetch(base+`/api/shares/${share.id}/file?path=${encodeURIComponent('片段.mp4')}&token=${token}`,{headers:{Range:'bytes=4096-8191'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),data.subarray(4096,8192));
    const zip=await fetch(base+`/api/shares/${share.id}/download?token=${token}`);assert.equal(zip.status,200);assert.equal(Buffer.from(await zip.arrayBuffer()).readUInt32LE(0),0x04034b50);
    const link=await api('/api/file-links',{path:path.join(library,'片段.mp4'),expiresIn:0});assert.match(link.id,/^[a-f0-9]{32}$/);assert.ok(!link.url.includes(token));
    const publicPath=new URL(link.url).pathname;
    const publicDownload=await fetch(base+publicPath);assert.equal(publicDownload.status,200);assert.match(publicDownload.headers.get('content-disposition'),/^attachment;/);assert.deepEqual(Buffer.from(await publicDownload.arrayBuffer()),data);
    const publicRange=await fetch(base+publicPath,{headers:{Range:'bytes=17-123'}});assert.equal(publicRange.status,206);assert.deepEqual(Buffer.from(await publicRange.arrayBuffer()),data.subarray(17,124));
    await api(`/api/file-links/${link.id}`,undefined,'DELETE');assert.equal((await fetch(base+publicPath)).status,404);assert.deepEqual(await fs.readFile(path.join(library,'片段.mp4')),data);
    peerChild=spawn(process.env.ComSpec||'cmd.exe',['/d','/c','启动Windows.bat','--port','0','--no-open','--name','另一台 Windows'],{cwd:folder,windowsHide:true,env:{...process.env,PATH:path.join(process.env.SystemRoot||'C:\\Windows','System32'),NODE_PATH:'',LINKWAVE_DATA_DIR:path.join(folder,'peer-data')}});
    let peerLog='';peerChild.stdout.on('data',chunk=>peerLog+=chunk.toString());peerChild.stderr.on('data',chunk=>peerLog+=chunk.toString());let peerBase;
    for(let i=0;i<100;i++){peerBase=peerLog.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0];if(peerBase)break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(peerBase,'第二个 BAT 实例未成功启动');
    const peerBoot=await(await fetch(peerBase+'/api/bootstrap?deviceId='+crypto.randomUUID())).json();let discovered;
    for(let i=0;i<60;i++){const state=await(await fetch(base+'/api/state',{headers:{Authorization:`Bearer ${token}`}})).json();discovered=state.devices.find(d=>d.id===`host:${peerBoot.server.id}`&&d.online);if(discovered)break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(discovered,'两个完整EXE未能通过真实UDP自动发现');
    assert.equal(discovered.paired,true);
    let remoteShare;
    for(let i=0;i<50;i++){const state=await(await fetch(peerBase+'/api/state')).json();remoteShare=state.shares.find(s=>s.id===share.id&&s.hostId===boot.server.id&&s.remote);if(remoteShare)break;await new Promise(r=>setTimeout(r,100));}
    assert.ok(remoteShare,'共享影音未在五秒内自动出现在第二个 EXE');assert.equal(remoteShare.sourceName,boot.server.name);assert.equal(remoteShare.path,undefined);
    const peerLibrary=await(await fetch(peerBase+'/api/shared-library')).json();assert.ok(!peerLibrary.shares.some(s=>s.id===share.id),'远端影音被再次发布造成循环');
    const proxy=peerBase+`/api/peers/${boot.server.id}/shares/${share.id}/file?path=${encodeURIComponent('片段.mp4')}`;
    const proxyRange=await fetch(proxy,{headers:{Range:'bytes=4096-8191'}});assert.equal(proxyRange.status,206);assert.equal(proxyRange.headers.get('content-range'),`bytes 4096-8191/${data.length}`);assert.deepEqual(Buffer.from(await proxyRange.arrayBuffer()),data.subarray(4096,8192));
    const proxyHead=await fetch(proxy,{method:'HEAD',headers:{Range:'bytes=4096-8191'}});assert.equal(proxyHead.status,206);assert.equal(proxyHead.headers.get('content-length'),'4096');assert.equal((await proxyHead.arrayBuffer()).byteLength,0);
    const proxySubtitlePrefix=peerBase+`/api/peers/${boot.server.id}/shares/${share.id}`;
    const proxySubtitles=await fetch(proxySubtitlePrefix+'/subtitles'+subtitleQuery('片段.mp4'));assert.equal(proxySubtitles.status,200);assert.deepEqual(await proxySubtitles.json(),subtitleMetadata);
    for(const [format,expected,type] of [['raw',ass,'plain'],['vtt',assVtt,'vtt']]){
      const response=await fetch(proxySubtitlePrefix+'/subtitle'+subtitleQuery('字幕/片段.ass',format));assert.equal(response.status,200);assert.match(response.headers.get('content-type'),new RegExp('^text/'+type+'; charset=utf-8'));assert.match(response.headers.get('content-security-policy'),/sandbox/);assert.equal(await response.text(),expected);
    }
    const subtitleDefault=await fetch(proxySubtitlePrefix+'/subtitle'+subtitleQuery('字幕/片段.ass'));assert.equal(subtitleDefault.status,200);assert.equal(await subtitleDefault.text(),assVtt);
    const subtitleHead=await fetch(proxySubtitlePrefix+'/subtitle'+subtitleQuery('字幕/片段.ass','raw'),{method:'HEAD'});assert.equal(subtitleHead.status,200);assert.equal(Number(subtitleHead.headers.get('content-length')),Buffer.byteLength(ass));assert.equal((await subtitleHead.arrayBuffer()).byteLength,0);
    assert.equal((await fetch(proxySubtitlePrefix+'/subtitle'+subtitleQuery('../逃逸.ass','raw'))).status,400);assert.equal((await fetch(proxySubtitlePrefix+'/subtitle'+subtitleQuery('片段.mp4','raw'))).status,400);
    for(const [source,dest,sourceBoot,destBoot,sourceDataDir,label] of [
      [base,peerBase,boot,peerBoot,path.join(folder,'data'),'电脑到平板'],
      [peerBase,base,peerBoot,boot,path.join(folder,'peer-data'),'平板到电脑']
    ]){
      const visible=await waitFor(()=>state(source,sourceBoot.token),s=>s.devices.some(d=>d.id===`host:${destBoot.server.id}`&&d.online&&d.paired),'双向真实 UDP 发现未就绪');
      const target=visible.devices.find(d=>d.id===`host:${destBoot.server.id}`);
      const sourceBefore=visible.stats,destBefore=(await state(dest,destBoot.token)).stats;
      const bytes=crypto.randomBytes(4*1024*1024+239),name=`Windows分块互传-${label}.bin`;
      const hostUpload=await request(source,sourceBoot.token,'/api/uploads',{name,size:bytes.length,targetId:target.id});
      assert.equal(hostUpload.chunkSize,4*1024*1024);
      let chunks=0;
      for(let offset=0;offset<bytes.length;offset+=hostUpload.chunkSize){
        const chunk=bytes.subarray(offset,offset+hostUpload.chunkSize);
        assert.equal((await request(source,sourceBoot.token,`/api/uploads/${hostUpload.id}?offset=${offset}`,chunk,'PUT')).offset,offset+chunk.length);chunks++;
      }
      assert.equal(chunks,2);
      assert.equal((await request(source,sourceBoot.token,`/api/uploads/${hostUpload.id}/complete`,{})).status,'sending');
      const sourceComplete=await waitFor(()=>state(source,sourceBoot.token),s=>{
        const task=s.transfers.find(f=>f.id===hostUpload.id);assert.notEqual(task?.status,'error',JSON.stringify(task));return task?.status==='complete';
      },'发送主机未显示远端接收完成');
      const completed=sourceComplete.transfers.find(task=>task.id===hostUpload.id);
      assert.equal(completed.received,bytes.length);assert.equal(completed.deliveredBytes,bytes.length);assert.equal(completed.canRetry,false);
      const destComplete=await waitFor(()=>state(dest,destBoot.token),s=>s.inbox.some(file=>file.name===name),'自动发现主机互传未送达');
      const received=destComplete.inbox.find(file=>file.name===name);
      assert.equal(destComplete.inbox.filter(file=>file.name===name).length,1);assert.equal(received.size,bytes.length);
      assert.equal(sha256(Buffer.from(await(await fetch(dest+received.url)).arrayBuffer())),sha256(bytes));
      assert.equal(sha256(await fs.readFile(path.join(destBoot.downloadDir,received.id,...received.relativePath.split('/')))),sha256(bytes));
      await assert.rejects(fs.access(path.join(sourceDataDir,'uploads',hostUpload.id+'.part')),{code:'ENOENT'});
      assert.equal(sourceComplete.stats.sentBytes-sourceBefore.sentBytes,bytes.length);
      assert.equal(sourceComplete.stats.receivedBytes,sourceBefore.receivedBytes);
      assert.equal(destComplete.stats.receivedBytes-destBefore.receivedBytes,bytes.length);
      assert.equal((await request(source,sourceBoot.token,`/api/uploads/${hostUpload.id}/complete`,{})).status,'complete');
      assert.deepEqual((await state(source,sourceBoot.token)).stats,sourceComplete.stats,'重复完成重复记账发送字节');
      assert.deepEqual((await state(dest,destBoot.token)).stats,destComplete.stats,'重复完成重复记账接收字节');
      const nativeBefore=(await state(source,sourceBoot.token)).stats,nativeDestBefore=(await state(dest,destBoot.token)).stats;
      const nativeBytes=crypto.randomBytes(4*1024*1024+193),nativeName=`Windows原文件直接发送-${label}.bin`,nativeSource=path.join(folder,nativeName);
      await fs.writeFile(nativeSource,nativeBytes);const nativeStat=await fs.stat(nativeSource);
      const nativeCreated=await request(source,sourceBoot.token,'/api/local-transfers',{paths:[nativeSource],targetId:target.id});
      assert.deepEqual(nativeCreated.skipped,[]);assert.equal(nativeCreated.transfers.length,1);
      const nativeTask=nativeCreated.transfers[0];assert.equal(nativeTask.status,'queued');assert.equal(nativeTask.localSource,true);assert.equal(nativeTask.size,nativeBytes.length);
      const nativeComplete=await waitFor(()=>state(source,sourceBoot.token),s=>{
        const task=s.transfers.find(file=>file.id===nativeTask.id);assert.notEqual(task?.status,'error',JSON.stringify(task));return task?.status==='complete';
      },'真实 EXE 原路径任务未自动发送完成');
      const nativeDelivered=nativeComplete.transfers.find(file=>file.id===nativeTask.id);
      assert.equal(nativeDelivered.localSource,true);assert.equal(nativeDelivered.received,nativeBytes.length);assert.equal(nativeDelivered.deliveredBytes,nativeBytes.length);assert.equal(nativeDelivered.canRetry,false);
      const nativeDest=await waitFor(()=>state(dest,destBoot.token),s=>s.inbox.some(file=>file.name===nativeName),'真实 EXE 未收到直接发送的原文件');
      const nativeReceived=nativeDest.inbox.find(file=>file.name===nativeName);assert.equal(nativeDest.inbox.filter(file=>file.name===nativeName).length,1);
      assert.equal(sha256(Buffer.from(await(await fetch(dest+nativeReceived.url)).arrayBuffer())),sha256(nativeBytes));
      assert.equal(sha256(await fs.readFile(path.join(destBoot.downloadDir,nativeReceived.id,...nativeReceived.relativePath.split('/')))),sha256(nativeBytes));
      const nativeAfter=await fs.stat(nativeSource);assert.equal(nativeAfter.ino,nativeStat.ino);assert.equal(nativeAfter.size,nativeStat.size);assert.equal(nativeAfter.mtimeMs,nativeStat.mtimeMs);assert.equal(sha256(await fs.readFile(nativeSource)),sha256(nativeBytes));
      assert.deepEqual((await fs.readdir(path.join(sourceDataDir,'uploads'))).filter(name=>name.endsWith('.part')),[],'真实 EXE 原文件发送生成了临时副本');
      const nativeMetadata=JSON.parse(await fs.readFile(path.join(sourceDataDir,'state.json'),'utf8')).uploads.find(file=>file.id===nativeTask.id);assert.equal(nativeMetadata.file,nativeSource);assert.equal(nativeMetadata.localSource,true);
      assert.equal(nativeComplete.stats.sentBytes-nativeBefore.sentBytes,nativeBytes.length);assert.equal(nativeComplete.stats.receivedBytes,nativeBefore.receivedBytes);assert.equal(nativeDest.stats.receivedBytes-nativeDestBefore.receivedBytes,nativeBytes.length);
      assert.equal((await request(source,sourceBoot.token,`/api/uploads/${nativeTask.id}/complete`,{})).status,'complete');
      assert.deepEqual((await state(source,sourceBoot.token)).stats,nativeComplete.stats);assert.deepEqual((await state(dest,destBoot.token)).stats,nativeDest.stats);
      assert.equal((await request(source,sourceBoot.token,`/api/uploads/${nativeTask.id}`,undefined,'DELETE')).ok,true);assert.equal(sha256(await fs.readFile(nativeSource)),sha256(nativeBytes));
    }
    console.log('PASS 单个 Windows BAT：两台无 Node 环境的独立 EXE、真实 UDP 双向发现及 4 MB 分块互传、原路径任务自动发送与原文件保留及无临时副本、接收下载与落盘 SHA-256、发送完成及一次记账、跨主机影音 Range/HEAD 代理、匿名字幕/字体清单及 UTF-16 ASS/raw/VTT/HEAD 代理与路径拒绝、完整界面、二维码、ZIP、单文件链接与撤销。');
  }finally{
    for(const running of [peerChild,child])if(running&&running.exitCode===null){await new Promise(resolve=>{const stopper=spawn('taskkill.exe',['/PID',String(running.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stopper.on('exit',resolve);stopper.on('error',resolve);});await new Promise(resolve=>{if(running.exitCode!==null)return resolve();running.once('exit',resolve);setTimeout(resolve,3000);});}
    await fs.rm(folder,{recursive:true,force:true,maxRetries:6,retryDelay:500});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

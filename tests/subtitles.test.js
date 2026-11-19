'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const http=require('node:http');
const iconv=require('iconv-lite');
const {createApp}=require('../server/index');

function request(url,token,method='GET',body){
  const payload=body===undefined?undefined:JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(payload===undefined?{}:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{
        const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');
        try{resolve({status:res.statusCode,headers:res.headers,bytes,text,data:String(res.headers['content-type']).includes('json')&&text?JSON.parse(text):undefined});}catch(error){reject(error);}
      });
    });req.on('error',reject);req.end(payload);
  });
}
const query=(filename,format)=>'?'+new URLSearchParams({path:filename,...(format?{format}:{})});
const video='[Shiniori] Sousou no Frieren S2-01 [1080p HEVC].mkv';
const assName='[SubsPlease] Sousou no Frieren S2 - 01 (1080p) [AABBCCDD].chs.ass';
const ass=[
  '[Script Info]',
  'ScriptType: v4.00+',
  'PlayResX: 1920',
  'PlayResY: 1080',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour',
  'Style: Default,测试字体,48,&H00FFFFFF',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.23,0:00:02.50,Default,,0,0,0,,{\\an8\\pos(960,90)\\k20}你好{\\i1}, world\\N{\\i0}第二行\\h<&>',
  'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}',
  'Comment: 0,0:00:01.00,0:00:05.00,Default,,0,0,0,,不要显示注释',
  ''
].join('\r\n');
const assVtt='WEBVTT\n\n00:00:01.230 --> 00:00:02.500\n你好, world\n第二行 &lt;&amp;&gt;\n';

test('字幕 API：同集跨组匹配、编码、ASS 回退、安全边界与跨主机代理',{timeout:30000},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'linkwave-subtitles-'));
  const library=path.join(temp,'影音'),folder=path.join(library,'节目');
  const subs=path.join(folder,'Subs'),fonts=path.join(subs,'Fonts');
  await fs.mkdir(fonts,{recursive:true});
  const fixtures=new Map([
    [`节目/${video}`,Buffer.from('temporary-video-fixture')],
    [`节目/Subs/${assName}`,Buffer.from('\uFEFF'+ass)],
    ['节目/Subs/[SubsPlease] Sousou no Frieren S2 - 02 (1080p).ass',Buffer.from(ass)],
    ['节目/Subs/[SubsPlease] Another Show S2 - 01 (1080p).srt',Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nother series\n')],
    ['节目/Subs/笔记.txt',Buffer.from('not a subtitle')],
    ['节目/Subs/Fonts/测试字体.ttf',Buffer.from('dummy-ttf-metadata')],
    ['节目/Subs/Fonts/测试字体.otf',Buffer.from('dummy-otf-metadata')],
    ['节目/Subs/Fonts/测试字体.ttc',Buffer.from('dummy-ttc-metadata')]
  ]);
  for(const [name,bytes] of fixtures)await fs.writeFile(path.join(library,...name.split('/')),bytes);
  const instances=[];
  t.after(async()=>{
    for(const instance of instances.reverse())await instance.close();
    const resolved=path.resolve(temp),tmpRoot=path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(tmpRoot+path.sep),'只删除测试创建的临时目录');
    await fs.rm(resolved,{recursive:true,force:true});
  });
  const a=await createApp({port:0,host:'127.0.0.1',dataDir:path.join(temp,'a'),discovery:false,name:'字幕源主机'});instances.push(a);await a.start();
  const base=`http://127.0.0.1:${a.config.port}`;
  const boot=await request(base+'/api/bootstrap?deviceId='+crypto.randomUUID());assert.equal(boot.status,200);
  const created=await request(base+'/api/shares',boot.data.token,'POST',{path:library});assert.equal(created.status,201);
  const prefix=base+`/api/shares/${created.data.id}`;
  const subtitle=(name,format)=>request(prefix+'/subtitle'+query(name,format));
  const metadata=name=>request(prefix+'/subtitles'+query(name));

  await t.test('同集跨组字幕排前，下一集和其它剧集不成为默认候选；字幕字体只返回相对路径',async()=>{
    const response=await metadata('节目/'+video);assert.equal(response.status,200);
    const {tracks,fonts:foundFonts}=response.data;
    assert.equal(tracks.length,3);assert.equal(tracks[0].name,assName);assert.equal(tracks[0].match,'episode');
    assert.deepEqual(tracks.filter(track=>track.match!=='directory').map(track=>track.name),[assName]);
    assert.equal(tracks.find(track=>track.name.includes(' - 02 ')).match,'directory');
    assert.equal(tracks.find(track=>track.name.includes('Another Show')).match,'directory');
    assert.match(tracks[0].label,/简体中文/);assert.equal(tracks[0].format,'ass');
    assert.deepEqual(foundFonts.map(font=>font.name).sort(),['测试字体.otf','测试字体.ttc','测试字体.ttf']);
    for(const item of [...tracks,...foundFonts]){assert.ok(!path.isAbsolute(item.path));assert.ok(item.path.startsWith('节目/Subs/'));assert.ok(!JSON.stringify(item).includes(library));}
    const font=await request(prefix+'/file'+query(foundFonts.find(font=>font.name.endsWith('.ttf')).path));assert.equal(font.status,200);assert.equal(font.text,'dummy-ttf-metadata');
  });

  await t.test('中文第01话识别同集且不会把第02话或其它剧集误选',async()=>{
    const chinese=path.join(library,'中文');await fs.mkdir(chinese);
    for(const name of ['葬送的芙莉莲 第01话.mkv','[字幕组] 葬送的芙莉莲 第01集.ass','[字幕组] 葬送的芙莉莲 第02集.ass','其它动画 第01话.ass'])await fs.writeFile(path.join(chinese,name),name.endsWith('.mkv')?'video':ass);
    const response=await metadata('中文/葬送的芙莉莲 第01话.mkv');assert.equal(response.status,200);
    assert.deepEqual(response.data.tracks.filter(track=>track.match!=='directory').map(track=>track.name),['[字幕组] 葬送的芙莉莲 第01集.ass']);
    assert.equal(response.data.tracks.find(track=>track.name.includes('第02')).match,'directory');
    assert.equal(response.data.tracks.find(track=>track.name.includes('其它动画')).match,'directory');
  });

  await t.test('相同剧集按季隔离，S02E01 与 S2-01 可匹配而 S1-01 不成为默认候选',async()=>{
    const seasonFolder=path.join(library,'分季');await fs.mkdir(seasonFolder);
    const names=['[Shiniori] Sousou no Frieren S2-01.mkv','[SubsPlease] Sousou no Frieren S1-01.ass','[SubsPlease] Sousou no Frieren S02E01.ass'];
    for(const name of names)await fs.writeFile(path.join(seasonFolder,name),name.endsWith('.mkv')?'video':ass);
    const response=await metadata('分季/'+names[0]);assert.equal(response.status,200);
    assert.deepEqual(response.data.tracks.filter(track=>track.match!=='directory').map(track=>track.name),[names[2]]);
    assert.equal(response.data.tracks.find(track=>track.name===names[1]).match,'directory');
    assert.equal(response.data.tracks.find(track=>track.name===names[2]).match,'episode');
  });

  await t.test('原始 ASS 保留样式与逗号；VTT 回退剥离样式、换行、硬空格与绘图并转义 HTML',async()=>{
    const filename=`节目/Subs/${assName}`;
    const raw=await subtitle(filename,'raw');assert.equal(raw.status,200);assert.equal(raw.text,ass);
    assert.match(raw.headers['content-type'],/^text\/plain; charset=utf-8/);assert.match(raw.headers['content-security-policy'],/sandbox/);assert.equal(raw.headers['x-content-type-options'],'nosniff');
    const fallback=await subtitle(filename);assert.equal(fallback.status,200);assert.equal(fallback.text,assVtt);
    assert.match(fallback.headers['content-type'],/^text\/vtt; charset=utf-8/);
    const explicit=await subtitle(filename,'vtt');assert.equal(explicit.text,assVtt);
    const head=await request(prefix+'/subtitle'+query(filename,'raw'),undefined,'HEAD');assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(Number(head.headers['content-length']),Buffer.byteLength(ass));
  });

  await t.test('SSA v4 使用自己的字段顺序，Text 最后时保留文本里的逗号',async()=>{
    const filename='节目/Subs/旧格式.ssa';
    const source='[Script Info]\nScriptType: v4.00\n[Events]\nFormat: Marked, Style, End, Start, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,Default,0:00:04.50,0:00:03.00,,0,0,0,,{\\i1}旧格式, 带逗号\\n下一行\n';
    await fs.writeFile(path.join(library,...filename.split('/')),source);
    assert.equal((await subtitle(filename,'raw')).text,source);
    const response=await subtitle(filename,'vtt');assert.equal(response.status,200);assert.equal(response.text,'WEBVTT\n\n00:00:03.000 --> 00:00:04.500\n旧格式, 带逗号\n下一行\n');
  });

  await t.test('UTF-8 BOM、UTF-16 LE/BE 与 GB18030 字幕均返回 UTF-8；SRT 和原生 VTT 可播放',async()=>{
    const source='1\r\n00:00:01,250 --> 00:00:02,500\r\n<b>中文字幕</b> & 𠀀\r\n';
    const encodings=[['utf8',Buffer.from(source)],['utf8-bom',Buffer.from('\uFEFF'+source)],['utf16le',Buffer.concat([Buffer.from([0xff,0xfe]),iconv.encode(source,'utf16le')])],['utf16be',Buffer.concat([Buffer.from([0xfe,0xff]),iconv.encode(source,'utf16be')])],['gb18030',iconv.encode(source,'gb18030')]];
    for(const [encoding,bytes] of encodings){
      const filename=`节目/Subs/编码-${encoding}.srt`;await fs.writeFile(path.join(library,...filename.split('/')),bytes);
      const raw=await subtitle(filename,'raw');assert.equal(raw.status,200,encoding);assert.equal(raw.text,source,encoding);
      const vtt=await subtitle(filename,'vtt');assert.equal(vtt.status,200,encoding);assert.equal(vtt.text,'WEBVTT\n\n00:00:01.250 --> 00:00:02.500\n中文字幕 &amp; 𠀀\n',encoding);
    }
    const vtt='WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000 align:start\r\n原生字幕\r\n';
    await fs.writeFile(path.join(subs,'原生.vtt'),vtt);
    assert.equal((await subtitle('节目/Subs/原生.vtt','raw')).text,vtt);
    assert.equal((await subtitle('节目/Subs/原生.vtt')).text,vtt.replace(/\r\n/g,'\n'));
  });

  await t.test('目录穿越、绝对路径、目录与非字幕被拒绝，超过 8 MB 不读取也不进入目录字幕清单',async()=>{
    for(const filename of ['../outside.srt','节目/../../outside.srt','节目\\..\\..\\outside.srt','/outside.srt',path.join(temp,'outside.srt'),'节目/\u0000.ass'])assert.equal((await subtitle(filename,'raw')).status,400,filename);
    for(const filename of ['节目/Subs','节目/Subs/笔记.txt','节目/Subs/Fonts/测试字体.ttf','节目/'+video])assert.equal((await subtitle(filename,'raw')).status,400,filename);
    assert.equal((await subtitle('节目/Subs/不存在.ass','raw')).status,404);
    assert.equal((await subtitle(`节目/Subs/${assName}`,'html')).status,400);
    assert.equal((await metadata('节目/Subs')).status,400);
    assert.equal((await request(base+'/api/shares/not-existing/subtitles'+query('节目/'+video))).status,404);
    const oversized=path.join(subs,'过大.ass'),handle=await fs.open(oversized,'w');try{await handle.truncate(8*1024*1024+1);}finally{await handle.close();}
    assert.equal((await subtitle('节目/Subs/过大.ass','raw')).status,413);assert.equal((await subtitle('节目/Subs/过大.ass','vtt')).status,413);
    assert.ok(!(await metadata('节目/'+video)).data.tracks.some(track=>track.name==='过大.ass'));
    const outside=path.join(temp,'未共享');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'秘密.srt'),'unshared-secret');
    await fs.symlink(outside,path.join(folder,'字幕'),process.platform==='win32'?'junction':'dir');
    assert.equal((await subtitle('节目/字幕/秘密.srt','raw')).status,403);
    assert.ok(!(await metadata('节目/'+video)).data.tracks.some(track=>track.name==='秘密.srt'));
  });

  await t.test('另一台 Node 主机匿名代理字幕清单、原始 ASS 与 VTT，并保留响应格式及安全边界',async()=>{
    const b=await createApp({port:0,host:'127.0.0.1',dataDir:path.join(temp,'b'),discovery:false,name:'字幕播放主机'});instances.push(b);await b.start();
    const other=`http://127.0.0.1:${b.config.port}`;
    const connected=await request(other+'/api/peers/connect',undefined,'POST',{url:base});assert.equal(connected.status,200);assert.equal(connected.data.device.id,'host:'+a.config.id);
    const proxy=other+`/api/peers/${a.config.id}/shares/${created.data.id}`;
    const local=await metadata('节目/'+video),remote=await request(proxy+'/subtitles'+query('节目/'+video));assert.equal(remote.status,200);assert.deepEqual(remote.data,local.data);
    for(const [format,expected,type] of [['raw',ass,'plain'],['vtt',assVtt,'vtt']]){
      const response=await request(proxy+'/subtitle'+query(`节目/Subs/${assName}`,format));assert.equal(response.status,200);assert.equal(response.text,expected);assert.match(response.headers['content-type'],new RegExp('^text/'+type+'; charset=utf-8'));assert.equal(response.headers['x-content-type-options'],'nosniff');assert.match(response.headers['content-security-policy'],/sandbox/);
    }
    assert.equal((await request(proxy+'/subtitle'+query(`节目/Subs/${assName}`))).text,assVtt);
    assert.equal((await request(proxy+'/subtitle'+query(`节目/Subs/${assName}`,'raw'),undefined,'HEAD')).bytes.length,0);
    for(const [filename,status] of [['../未共享/秘密.srt',400],['节目/字幕/秘密.srt',403],['节目/Subs/笔记.txt',400],['节目/Subs/过大.ass',413]])assert.equal((await request(proxy+'/subtitle'+query(filename,'raw'))).status,status,filename);
    assert.equal((await request(proxy+'/subtitle'+query(`节目/Subs/${assName}`,'html'))).status,400);
    const missing=other+`/api/peers/not-existing/shares/${created.data.id}/subtitles`+query('节目/'+video);assert.equal((await request(missing)).status,404);
    for(const [filename,bytes] of fixtures)assert.deepEqual(await fs.readFile(path.join(library,...filename.split('/'))),bytes,'读取字幕及字体不得修改源文件');
  });
});

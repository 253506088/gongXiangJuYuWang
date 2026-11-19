'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const http=require('node:http');
const {createApp}=require('../server/index');

function request(url,token,method='GET',body,extra={}) {
  const headers={...(token?{Authorization:`Bearer ${token}`} : {}),...extra};
  if(body!==undefined){body=JSON.stringify(body);headers['Content-Type']='application/json';headers['Content-Length']=Buffer.byteLength(body);}
  return new Promise((resolve,reject)=>{
    const req=http.request(url,{method,headers},response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
      response.on('end',()=>{
        const buffer=Buffer.concat(chunks);
        const result={status:response.statusCode,headers:response.headers,buffer};
        try{if(String(response.headers['content-type']).includes('json')&&buffer.length)result.data=JSON.parse(buffer.toString());resolve(result);}catch(e){reject(e);}
      });
    });req.on('error',reject);req.end(body);
  });
}

test('单文件链接：匿名下载、权限隔离、有效期、撤销与持久化', {timeout:30000},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'linkwave-file-links-'));
  const dataDir=path.join(temp,'state');
  const files=path.join(temp,'当前机器的文件');await fs.mkdir(files);
  let instance=await createApp({dataDir,port:0,host:'127.0.0.1',discovery:false,name:'链接分享主机'});await instance.start();
  let base=`http://127.0.0.1:${instance.config.port}`;
  t.after(async()=>{await instance.close();await fs.rm(temp,{recursive:true,force:true});});
  const bootstrap=(await request(`${base}/api/bootstrap?deviceId=${crypto.randomUUID()}`)).data;
  assert.equal(bootstrap.admin,true);
  const admin=bootstrap.token;
  const remote=(await request(`${base}/api/bootstrap?deviceId=${crypto.randomUUID()}&name=同网手机`,null,'GET',undefined,{Host:`192.168.44.2:${instance.config.port}`})).data.token;
  const name='会议资料 中文 & 空格.bin';
  const source=path.join(files,name),bytes=crypto.randomBytes(1024*1024+321);
  await fs.writeFile(source,bytes);
  let link;
  const publicUrl=value=>{const url=new URL(value.url);return base+url.pathname+url.search;};
  const list=async()=>{const response=await request(base+'/api/file-links',admin);assert.equal(response.status,200);return response.data.links;};
  const create=async(file,expiresIn)=>{
    const response=await request(base+'/api/file-links',admin,'POST',{path:file,...(expiresIn!==undefined?{expiresIn}:{})});
    assert.ok(response.status===200||response.status===201,JSON.stringify(response.data));return response.data;
  };

  await t.test('生成独立随机局域网URL，不复制或预先上传源文件',async()=>{
    link=await create(source);
    assert.match(link.id,/^[a-f0-9]{32}$/);assert.equal(link.name,name);assert.equal(link.size,bytes.length);assert.equal(link.status,'active');assert.equal(link.downloads,0);
    const url=new URL(link.url);
    assert.equal(url.protocol,'http:');assert.equal(url.username,'');assert.equal(url.password,'');
    assert.match(url.pathname,new RegExp(`^/d/${link.id}/`));assert.equal(decodeURIComponent(url.pathname.split('/').at(-1)),name);
    assert.ok(!link.url.includes(admin));assert.ok(!link.url.includes(remote));assert.equal(url.searchParams.get('token'),null);assert.equal(url.searchParams.get('path'),null);
    const expires=new Date(link.expiresAt).getTime();assert.ok(expires-Date.now()>86390*1000&&expires-Date.now()<=86400*1000);
    assert.equal((await fs.stat(source)).size,bytes.length);
    const state=(await request(base+'/api/state',admin)).data;assert.equal(state.inbox.length,0);assert.equal(state.fileLinks.find(item=>item.id===link.id).path,source);
    const stored=await list();assert.equal(stored.find(item=>item.id===link.id).name,name);
  });

  await t.test('持链接者可直接下载，中文附件名和完整文件哈希正确',async()=>{
    const response=await request(publicUrl(link));assert.equal(response.status,200);
    assert.equal(crypto.createHash('sha256').update(response.buffer).digest('hex'),crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.match(response.headers['content-disposition'],/^attachment;/);assert.match(response.headers['content-disposition'],/filename\*=UTF-8''/);
    assert.ok(response.headers['content-disposition'].includes(encodeURIComponent(name).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`)));
    assert.equal(response.headers['x-content-type-options'],'nosniff');
    assert.equal((await list()).find(item=>item.id===link.id).downloads,1);
    const state=await request(base+'/api/state');assert.equal(state.status,200);assert.equal(state.data.fileLinks,undefined);assert.ok(!JSON.stringify(state.data).includes(source));
  });

  await t.test('匿名断点下载、HEAD和非法Range；仅完整GET统计下载次数',async()=>{
    const head=await request(publicUrl(link),null,'HEAD');assert.equal(head.status,200);assert.equal(Number(head.headers['content-length']),bytes.length);assert.equal(head.buffer.length,0);
    const range=await request(publicUrl(link),null,'GET',undefined,{Range:'bytes=4096-8191'});assert.equal(range.status,206);assert.equal(range.headers['content-range'],`bytes 4096-8191/${bytes.length}`);assert.deepEqual(range.buffer,bytes.subarray(4096,8192));
    const suffix=await request(publicUrl(link),null,'GET',undefined,{Range:'bytes=-13'});assert.equal(suffix.status,206);assert.deepEqual(suffix.buffer,bytes.subarray(bytes.length-13));
    const invalid=await request(publicUrl(link),null,'GET',undefined,{Range:`bytes=${bytes.length}-`});assert.equal(invalid.status,416);assert.equal(invalid.headers['content-range'],`bytes */${bytes.length}`);
    assert.equal((await list()).find(item=>item.id===link.id).downloads,1);
  });

  await t.test('下载链接只指向所选文件，查询参数与伪造尾部名字不能扩大共享范围',async()=>{
    const secret=path.join(temp,'未共享的文件.txt');await fs.writeFile(secret,'private-unshared-content');
    const query=await request(publicUrl(link)+`?path=${encodeURIComponent(secret)}&token=invalid`);assert.equal(query.status,200);assert.deepEqual(query.buffer,bytes);
    const renamed=await request(base+`/d/${link.id}/${encodeURIComponent('未共享的文件.txt')}`);assert.equal(renamed.status,200);assert.deepEqual(renamed.buffer,bytes);assert.ok(!renamed.buffer.includes(Buffer.from('private-unshared-content')));
    assert.equal((await request(base+'/d/'+crypto.randomBytes(16).toString('hex')+'/不存在.bin')).status,404);
    assert.equal((await request(base+'/d/not-a-valid-id/file.bin')).status,404);
  });

  await t.test('远程自动连接客户端无创建、列举、选择或撤销权限',async()=>{
    assert.equal((await request(base+'/api/file-links')).status,401);
    assert.equal((await request(base+'/api/file-links',remote)).status,403);
    assert.equal((await request(base+'/api/file-links',remote,'POST',{path:source})).status,403);
    assert.equal((await request(base+`/api/file-links/${link.id}`,remote,'DELETE')).status,403);
    assert.equal((await request(base+'/api/pick-file',remote,'POST',{})).status,403);
    assert.equal((await request(base+'/api/file-links',admin,'POST',{path:source},{Origin:'https://untrusted.invalid'})).status,403);
    assert.equal((await request(base+'/api/file-links',admin,'GET',undefined,{Host:`192.168.44.2:${instance.config.port}`})).status,403);
    const state=(await request(base+'/api/state',remote)).data;
    assert.ok(!state.fileLinks||state.fileLinks.length===0);assert.equal(state.pickedFile,undefined);assert.ok(!JSON.stringify(state).includes(source));assert.ok(!JSON.stringify(state).includes(link.id));
  });

  await t.test('目录、相对路径、缺失文件及不支持有效期被拒绝',async()=>{
    for(const filename of [files,'relative.txt'])assert.equal((await request(base+'/api/file-links',admin,'POST',{path:filename})).status,400);
    assert.equal((await request(base+'/api/file-links',admin,'POST',{path:path.join(files,'没有这个文件.txt')})).status,404);
    for(const expiresIn of [-1,1,'invalid'])assert.equal((await request(base+'/api/file-links',admin,'POST',{path:source,expiresIn})).status,400);
  });

  await t.test('HTML与SVG强制附件下载，并提供sandbox防止在应用源执行',async()=>{
    for(const [filename,text] of [['页面.html','<script>document.title="unsafe"</script>'],['图形.svg','<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>']]){
      const file=path.join(files,filename);await fs.writeFile(file,text);const active=await create(file,3600);const response=await request(publicUrl(active));
      assert.equal(response.status,200);assert.match(response.headers['content-disposition'],/^attachment;/);assert.equal(response.headers['x-content-type-options'],'nosniff');assert.match(response.headers['content-security-policy'],/sandbox/);assert.equal(response.buffer.toString(),text);
    }
  });

  await t.test('空文件链接可直接下载，文件名不影响HTTP响应头安全',async()=>{
    const emptyPath=path.join(files,'空白 中文.txt');await fs.writeFile(emptyPath,'');const empty=await create(emptyPath,604800);
    const response=await request(publicUrl(empty));assert.equal(response.status,200);assert.equal(response.buffer.length,0);assert.equal(Number(response.headers['content-length']),0);
    const head=await request(publicUrl(empty),null,'HEAD');assert.equal(head.status,200);assert.equal(head.buffer.length,0);
    assert.equal((await request(publicUrl(empty),null,'GET',undefined,{Range:'bytes=0-0'})).status,416);
  });

  await t.test('源文件被移动、删除或替换时不意外共享新文件',async()=>{
    const original=path.join(files,'源身份.bin');await fs.writeFile(original,'original-source-identity');const active=await create(original,0);assert.equal(active.expiresAt,null);
    await fs.rename(original,path.join(files,'源身份-原文件.bin'));await fs.writeFile(original,'replacement-must-never-be-served');
    assert.equal((await request(publicUrl(active))).status,404);
    assert.equal((await list()).find(item=>item.id===active.id).status,'missing');
    const missingFile=path.join(files,'将被删除.bin');await fs.writeFile(missingFile,'delete me');const missing=await create(missingFile,0);await fs.unlink(missingFile);assert.equal((await request(publicUrl(missing))).status,404);
  });

  await t.test('链接、下载统计和过期时间在服务重启后保持，过期链接返回410',async()=>{
    const permanent=await create(source,0),expired=await create(source,3600);
    await request(publicUrl(permanent));
    const port=instance.config.port;await instance.close();
    const configFile=path.join(dataDir,'config.json');const config=JSON.parse(await fs.readFile(configFile,'utf8'));
    assert.ok(Array.isArray(config.fileLinks),'链接元数据应保存在主机config.json');
    const saved=config.fileLinks.find(item=>item.id===expired.id);assert.ok(saved);saved.expiresAt=new Date(Date.now()-1000).toISOString();
    await fs.writeFile(configFile,JSON.stringify(config,null,2));
    instance=await createApp({dataDir,port,host:'127.0.0.1',discovery:false});await instance.start();base=`http://127.0.0.1:${instance.config.port}`;
    assert.equal((await request(publicUrl(expired))).status,410);
    assert.equal((await list()).find(item=>item.id===expired.id).status,'expired');
    const persisted=(await list()).find(item=>item.id===permanent.id);assert.equal(persisted.expiresAt,null);assert.equal(persisted.downloads,1);
    assert.equal((await request(publicUrl(permanent))).status,200);assert.equal((await list()).find(item=>item.id===permanent.id).downloads,2);
    assert.equal((await request(publicUrl(link))).status,200);
  });

  await t.test('撤销立即阻断公开下载，并保留原文件',async()=>{
    const response=await request(base+`/api/file-links/${link.id}`,admin,'DELETE');assert.equal(response.status,200);
    assert.equal((await request(publicUrl(link))).status,404);assert.ok(!(await list()).some(item=>item.id===link.id));assert.deepEqual(await fs.readFile(source),bytes);
  });
});

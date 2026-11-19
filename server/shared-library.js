'use strict';
const http=require('node:http');
const {pipeline}=require('node:stream/promises');
const {fail,asyncRoute,cleanName,safeRelative}=require('./util');
function lanUrl(value){
  let url;try{url=new URL(String(value));}catch{throw fail('请输入局域网地址，例如 http://192.168.1.10:53317');}
  if(url.protocol!=='http:'||url.username||url.password)throw fail('请使用局域网 HTTP 地址');
  const host=url.hostname.replace(/^\[|\]$/g,''),o=host.split('.').map(Number);
  const ipv4=/^\d{1,3}(\.\d{1,3}){3}$/.test(host)&&o.every(n=>n>=0&&n<256);
  const local=host==='localhost'||host==='::1'||/^(fc|fd)[a-f0-9:]+$/i.test(host);
  const private4=ipv4&&(o[0]===10||o[0]===127||o[0]===192&&o[1]===168||o[0]===172&&o[1]>=16&&o[1]<=31);
  if(!local&&!private4)throw fail('请输入同一局域网设备的 IP 地址');return url.origin;
}
function createSharedLibrary(config,discovery,serverInfo,saveConfig,notify){
  const cache=new Map();let timer,refreshing,lastRefresh=0,closed=false;
  async function refresh(force=false){
    if(closed)return;if(refreshing)return refreshing;if(!force&&Date.now()-lastRefresh<2000)return;lastRefresh=Date.now();
    refreshing=(async()=>{
      const peers=[...discovery.peers.values()],known=new Set(peers.map(p=>p.id));let changed=false;
      for(const id of cache.keys())if(!known.has(id)){cache.delete(id);changed=true;}
      for(let i=0;i<peers.length;i+=8)await Promise.all(peers.slice(i,i+8).map(async peer=>{
        try{
          const response=await fetch(lanUrl(peer.url)+'/api/shared-library',{signal:AbortSignal.timeout(2500),redirect:'error'});if(!response.ok)throw new Error();
          const data=await response.json();if(data.server?.id!==peer.id||!Array.isArray(data.shares))throw new Error();
          const shares=data.shares.filter(s=>typeof s.id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(s.id)&&typeof s.name==='string').slice(0,1000).map(s=>({id:s.id,name:cleanName(s.name),type:'folder',hostId:peer.id,sourceName:cleanName(data.server.name||peer.name),remote:true}));
          if(JSON.stringify(cache.get(peer.id))!==JSON.stringify(shares)){cache.set(peer.id,shares);changed=true;}
          peer.lastSeen=Date.now();
        }catch{if(cache.has(peer.id)){cache.delete(peer.id);changed=true;}}
      }));if(changed)notify();
    })().finally(()=>refreshing=null);return refreshing;
  }
  async function connect(value){
    const origin=lanUrl(value);let response,data;try{response=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(5000),redirect:'error'});data=await response.json();}catch{throw fail('连接不上这台设备，请确认邻波正在运行且处于同一局域网',502);}
    if(!response.ok||!data.ok||!/^[a-f0-9-]{16,64}$/i.test(data.serverId||''))throw fail('此地址不是邻波设备');if(data.serverId===config.id)throw fail('这是当前设备，请输入另一台的地址');
    let name='局域网设备',platform='Unknown';try{const l=await(await fetch(origin+'/api/shared-library',{signal:AbortSignal.timeout(2500),redirect:'error'})).json();name=l.server?.name||name;platform=l.server?.platform||platform;}catch{}
    const peer={id:data.serverId,url:origin,port:Number(new URL(origin).port)||80,ip:new URL(origin).hostname,name:cleanName(name),platform,lastSeen:Date.now(),manual:true};
    discovery.peers.set(peer.id,peer);config.manualPeers=(config.manualPeers||[]).filter(p=>p.id!==peer.id);config.manualPeers.push(peer);await saveConfig();notify();await refresh(true);
    return {id:'host:'+peer.id,name:peer.name,url:peer.url,platform:peer.platform,online:true,paired:true};
  }
  function attach(app){
    app.get('/api/shared-library',(req,res)=>res.json({server:serverInfo(),shares:config.shares.map(s=>({id:s.id,name:s.name,type:'folder'}))}));
    app.post('/api/peers/connect',asyncRoute(async(req,res)=>res.json({device:await connect(req.body.url)})));
    app.get('/api/peers/:hostId/shares/:shareId/:action',asyncRoute(async(req,res)=>{
      const peer=discovery.peers.get(req.params.hostId);if(!peer)throw fail('这台共享设备已离线',404);if(!['browse','file','download'].includes(req.params.action))throw fail('接口不存在',404);
      const remote=new URL(`/api/shares/${encodeURIComponent(req.params.shareId)}/${req.params.action}`,lanUrl(peer.url));remote.searchParams.set('path',safeRelative(req.query.path||''));
      const headers={};for(const n of ['range','if-range','if-none-match','if-modified-since'])if(req.headers[n])headers[n]=req.headers[n];
      await new Promise((resolve,reject)=>{
        const upstream=http.request(remote,{method:req.method,headers},async response=>{
          res.status(response.statusCode);for(const n of ['content-type','content-length','content-disposition','content-range','accept-ranges','etag','last-modified','cache-control','content-security-policy','x-content-type-options'])if(response.headers[n])res.set(n,response.headers[n]);
          try{await pipeline(response,res);resolve();}catch(e){if(res.destroyed)resolve();else reject(e);}
        });upstream.setTimeout(30000,()=>upstream.destroy(new Error('共享主机响应超时')));upstream.on('error',()=>reject(fail('共享设备连接中断，请确认它正在运行',502)));res.once('close',()=>upstream.destroy());upstream.end();
      });
    }));
  }
  function start(){timer=setInterval(()=>refresh(),3000);timer.unref();refresh();}
  function close(){closed=true;clearInterval(timer);cache.clear();}
  return {attach,start,close,refresh,remoteShares:()=>[...cache.values()].flat(),connect};
}
module.exports={createSharedLibrary,lanUrl};

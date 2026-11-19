'use strict';
const dgram = require('node:dgram');
const {ips} = require('./util');
const GROUP='239.255.42.99';
const PORT=53318;
const PEER_TTL=20000;
function createDiscovery(info, onChange, options={}) {
  const peers=new Map(), addresses=new Map(), memberships=new Set(), pendingSends=new Set();
  const getNets=options.nets||ips;
  let socket, announceTimer, expiryTimer, announcePromise, announceAgain=false, ready=false, closed=false;
  function nets(){return [...new Map(getNets().map(net=>[net.ip,net])).values()];}
  function addressRank(address, networks) {
    const octets=address.split('.').map(Number);
    // ips() puts physical LAN interfaces ahead of VPNs and virtual adapters.
    const index=networks.findIndex(net=>{
      const local=net.ip.split('.').map(Number), mask=net.netmask.split('.').map(Number);
      return octets.every((value,i)=>(value&mask[i])===(local[i]&mask[i]));
    });
    return index<0?networks.length:index;
  }
  function preferredAddress(id, previous, networks, now) {
    const seen=addresses.get(id);
    let best, rank=Infinity;
    for(const [address,time] of seen||[]) {
      if(now-time>PEER_TTL){seen.delete(address);continue;}
      const nextRank=addressRank(address,networks);
      if(nextRank<rank || nextRank===rank && address===previous){best=address;rank=nextRank;}
    }
    return best;
  }
  function refreshPeers(networks) {
    const now=Date.now();let changed=false;
    for(const [id,peer] of peers) {
      if(now-peer.lastSeen>PEER_TTL){peers.delete(id);addresses.delete(id);changed=true;continue;}
      const ip=preferredAddress(id,peer.ip,networks,now);
      if(ip && ip!==peer.ip){peers.set(id,{...peer,ip,url:`http://${ip}:${peer.port}`});changed=true;}
    }
    if(changed)onChange();
  }
  function accept(raw, rinfo) {
    if(closed)return;
    try {
      if(raw.length>2048) return;
      const p=JSON.parse(raw.toString());
      if(p.app!=='linkwave' || p.version!==1 || p.id===info().id || typeof p.id!=='string' || !/^[a-f0-9-]{16,64}$/i.test(p.id) || typeof p.name!=='string' || !Number.isInteger(p.port) || p.port<1 || p.port>65535) return;
      const old=peers.get(p.id), now=Date.now();
      if(!addresses.has(p.id))addresses.set(p.id,new Map());
      addresses.get(p.id).set(rinfo.address,now);
      const ip=preferredAddress(p.id,old?.ip,nets(),now);
      const next={id:p.id,name:p.name.slice(0,120),port:p.port,platform:String(p.platform||'Unknown').slice(0,30),ip,url:`http://${ip}:${p.port}`,lastSeen:now};
      peers.set(p.id,next);
      if(!old || old.name!==next.name || old.ip!==next.ip || old.port!==next.port) onChange();
      if(!old) announce();
    }catch{}
  }
  function syncMemberships(networks) {
    const wanted=new Set(networks.length?networks.map(net=>net.ip):['']);
    for(const address of memberships)if(!wanted.has(address)){
      try{socket.dropMembership(GROUP,address||undefined);}catch{}
      memberships.delete(address);
    }
    for(const address of wanted)if(!memberships.has(address)){
      try{socket.addMembership(GROUP,address||undefined);memberships.add(address);}catch{}
    }
  }
  function send(packet,address) {
    if(closed)return Promise.resolve();
    return new Promise(resolve=>{
      const finish=()=>{pendingSends.delete(finish);resolve();};pendingSends.add(finish);
      try{socket.send(packet,PORT,address,finish);}catch{finish();}
    });
  }
  async function announceOnce() {
    const networks=nets();syncMemberships(networks);refreshPeers(networks);
    const packet=Buffer.from(JSON.stringify({app:'linkwave',version:1,...info()}));
    // send() resolves its address asynchronously. Wait for each callback before
    // switching the shared socket's interface, so every adapter gets its packet.
    for(const address of networks.length?networks.map(net=>net.ip):['0.0.0.0']) {
      if(closed)return;
      try{socket.setMulticastInterface(address);}catch{continue;}
      await send(packet,GROUP);
    }
    const broadcasts=new Set(['255.255.255.255']);
    for(const net of networks) {
      const ip=net.ip.split('.').map(Number), mask=net.netmask.split('.').map(Number);
      broadcasts.add(ip.map((value,i)=>(value | ((~mask[i])&255))).join('.'));
    }
    for(const address of broadcasts){if(closed)return;await send(packet,address);}
  }
  function announce() {
    if(!socket || !ready || closed)return Promise.resolve();
    if(announcePromise){announceAgain=true;return announcePromise;}
    announcePromise=(async()=>{
      do{announceAgain=false;await announceOnce();}while(announceAgain&&!closed);
    })().catch(e=>options.onWarning?.(`设备发现暂不可用：${e.message}`)).finally(()=>{announcePromise=undefined;});
    return announcePromise;
  }
  function start() {
    if(options.disabled || socket || closed)return;
    socket=dgram.createSocket({type:'udp4',reuseAddr:true});
    socket.on('error',e=>{ if(e.code!=='EADDRINUSE') options.onWarning?.(`设备发现暂不可用：${e.message}`); });
    socket.on('message',accept);
    socket.on('close',()=>{ready=false;});
    socket.bind(PORT,()=>{
      if(closed) return;
      ready=true;
      try{socket.setBroadcast(true);socket.setMulticastTTL(1);socket.setMulticastLoopback(true);}catch{}
      announce();
    });
    announceTimer=setInterval(announce,5000);announceTimer.unref();
    expiryTimer=setInterval(()=>refreshPeers(nets()),5000);expiryTimer.unref();
  }
  function close(){
    closed=true;ready=false;clearInterval(announceTimer);clearInterval(expiryTimer);
    if(socket)try{socket.close();}catch{}
    for(const finish of pendingSends)finish();
    memberships.clear();addresses.clear();peers.clear();
  }
  return {peers,start,close,announce};
}
module.exports={createDiscovery,GROUP,PORT};

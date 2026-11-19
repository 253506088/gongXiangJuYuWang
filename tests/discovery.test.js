'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const dgram=require('node:dgram');
const {EventEmitter}=require('node:events');
const {createDiscovery,GROUP}=require('../server/discovery');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const host=(name,port)=>({id:crypto.randomUUID(),name,port,platform:'Windows'});
const packet=info=>Buffer.from(JSON.stringify({app:'linkwave',version:1,...info}));

test('真实 UDP 组播双向发现及关闭', {timeout:10000},async t=>{
  // Loopback keeps this socket test independent of Windows firewall settings.
  const nets=()=>[{name:'Loopback',ip:'127.0.0.1',netmask:'255.0.0.0'}];
  const first=host('UDP 电脑甲',55317), second=host('UDP 电脑乙',55319), warnings=[];
  const a=createDiscovery(()=>first,()=>{},{nets,onWarning:message=>warnings.push(message)});
  const b=createDiscovery(()=>second,()=>{},{nets,onWarning:message=>warnings.push(message)});
  t.after(()=>{a.close();b.close();});a.start();b.start();
  const deadline=Date.now()+6000;
  while(Date.now()<deadline && (!a.peers.has(second.id)||!b.peers.has(first.id))){
    await Promise.all([a.announce(),b.announce()]);await pause(50);
  }
  assert.ok(a.peers.has(second.id),`甲未通过 UDP 发现乙：${warnings.join('; ')}`);
  assert.ok(b.peers.has(first.id),`乙未通过 UDP 发现甲：${warnings.join('; ')}`);
  assert.equal(a.peers.get(second.id).url,'http://127.0.0.1:55319');
  assert.equal(b.peers.get(first.id).url,'http://127.0.0.1:55317');
  a.close();await b.announce();await pause(50);
  assert.equal(a.peers.size,0);
  b.close();await Promise.all([a.announce(),b.announce()]);assert.equal(b.peers.size,0);
});

test('逐网卡异步发送、网络变化、稳定 LAN 地址和离线过期',async t=>{
  class Socket extends EventEmitter {
    constructor(){super();this.members=[];this.sent=[];this.active='';this.closed=false;}
    bind(port,callback){setImmediate(callback);}
    setBroadcast(){} setMulticastTTL(){} setMulticastLoopback(){}
    setMulticastInterface(address){this.active=address;}
    addMembership(group,address){this.members.push({action:'add',address:address||''});}
    dropMembership(group,address){this.members.push({action:'drop',address:address||''});}
    send(data,port,address,callback){
      const requested=this.active;
      setImmediate(()=>{this.sent.push({address,requested,actual:this.active});callback();});
    }
    close(){this.closed=true;this.emit('close');}
  }
  const socket=new Socket();t.mock.method(dgram,'createSocket',()=>socket);
  let networks=[{name:'Wi-Fi',ip:'192.168.1.10',netmask:'255.255.255.0'},{name:'VPN',ip:'100.100.1.2',netmask:'255.255.255.0'}];
  const self=host('本机',55317), other=host('远端',55319);
  const discovery=createDiscovery(()=>self,()=>{},{nets:()=>networks});
  t.after(()=>discovery.close());discovery.start();await pause(10);await discovery.announce();
  assert.deepEqual(socket.members,[{action:'add',address:'192.168.1.10'},{action:'add',address:'100.100.1.2'}]);
  const multicast=socket.sent.filter(item=>item.address===GROUP);
  assert.ok(multicast.length>=2);
  assert.deepEqual(multicast.slice(0,2).map(item=>item.actual),['192.168.1.10','100.100.1.2']);
  assert.ok(multicast.every(item=>item.requested===item.actual),'接口在 UDP 回调前被切换');
  assert.ok(socket.sent.some(item=>item.address==='255.255.255.255'));
  assert.ok(socket.sent.some(item=>item.address==='192.168.1.255'));
  const receive=address=>socket.emit('message',packet(other),{address});
  receive('100.100.1.8');receive('192.168.1.8');receive('100.100.1.8');receive('192.168.1.9');
  assert.equal(discovery.peers.get(other.id).ip,'192.168.1.8','VPN 或同等级地址覆盖了有效 LAN 地址');
  networks=[{name:'Wi-Fi',ip:'192.168.2.10',netmask:'255.255.255.0'},networks[1]];
  await discovery.announce();
  assert.ok(socket.members.some(item=>item.action==='drop'&&item.address==='192.168.1.10'));
  assert.ok(socket.members.some(item=>item.action==='add'&&item.address==='192.168.2.10'));
  assert.equal(socket.members.filter(item=>item.action==='add'&&item.address==='100.100.1.2').length,1);
  receive('192.168.2.8');receive('100.100.1.8');
  assert.equal(discovery.peers.get(other.id).ip,'192.168.2.8');
  networks=[];await discovery.announce();
  assert.ok(socket.members.some(item=>item.action==='add'&&item.address===''));
  assert.equal(socket.sent.filter(item=>item.address===GROUP).at(-1).actual,'0.0.0.0');
  const later=Date.now()+20001;t.mock.method(Date,'now',()=>later);
  await discovery.announce();assert.equal(discovery.peers.size,0,'离线设备仍保留在发现列表');
  discovery.close();const sent=socket.sent.length;receive('192.168.2.8');await discovery.announce();
  assert.equal(discovery.peers.size,0);assert.equal(socket.sent.length,sent);assert.equal(socket.closed,true);
});

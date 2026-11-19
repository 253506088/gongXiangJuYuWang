package com.linkwave.app;

import android.net.wifi.WifiManager;
import org.json.JSONObject;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

final class Discovery implements AutoCloseable {
    private final HostState state;
    private volatile boolean running=true;
    private MulticastSocket multicast;
    private DatagramSocket broadcast;
    private WifiManager.MulticastLock lock;
    private final ScheduledExecutorService timer=Executors.newSingleThreadScheduledExecutor();
    Discovery(HostState s){state=s;state.workers.execute(this::start);}
    private void start(){
        try{WifiManager wifi=(WifiManager)state.context.getApplicationContext().getSystemService(android.content.Context.WIFI_SERVICE);if(wifi!=null){lock=wifi.createMulticastLock("linkwave-discovery");lock.setReferenceCounted(false);lock.acquire();}}catch(Exception ignored){}
        try{multicast=new MulticastSocket(null);multicast.setReuseAddress(true);multicast.bind(new InetSocketAddress(53318));multicast.setTimeToLive(1);multicast.setSoTimeout(2000);InetAddress group=InetAddress.getByName("239.255.42.99");Enumeration<NetworkInterface> nets=NetworkInterface.getNetworkInterfaces();boolean joined=false;while(nets.hasMoreElements()){NetworkInterface n=nets.nextElement();if(n.isUp()&&!n.isLoopback()){try{multicast.joinGroup(new InetSocketAddress(group,53318),n);joined=true;}catch(Exception ignored){}}}if(!joined)multicast.joinGroup(group);state.workers.execute(this::listen);}catch(Exception e){android.util.Log.w("LinkWave","Multicast discovery unavailable",e);}
        try{broadcast=new DatagramSocket();broadcast.setBroadcast(true);}catch(Exception ignored){}
        timer.scheduleAtFixedRate(this::announce,0,3,TimeUnit.SECONDS);
        timer.scheduleAtFixedRate(state::refreshLibraries,0,5,TimeUnit.SECONDS);
    }
    private void listen(){byte[]buffer=new byte[8192];while(running){try{DatagramPacket p=new DatagramPacket(buffer,buffer.length);multicast.receive(p);JSONObject j=new JSONObject(new String(p.getData(),0,p.getLength(),StandardCharsets.UTF_8));if(!j.optString("app").equals("linkwave")||j.optInt("version")!=1||j.optString("id").equals(state.id))continue;String id=j.optString("id");int port=j.optInt("port");if(!id.matches("[a-zA-Z0-9-]{1,100}")||port<1||port>65535)continue;HostState.Peer peer=state.peers.computeIfAbsent(id,k->new HostState.Peer());peer.id=id;peer.name=HostState.limit(j.optString("name","局域网设备"),80);peer.platform=j.optString("platform","unknown");peer.ip=p.getAddress().getHostAddress();peer.url="http://"+peer.ip+":"+port;peer.seen=System.currentTimeMillis();}catch(SocketTimeoutException ignored){}catch(Exception e){if(!running)return;}}}
    private void announce(){if(!running)return;try{byte[]bytes=HostState.obj("app","linkwave","version",1,"id",state.id,"name",state.name,"port",state.port,"platform","android").toString().getBytes(StandardCharsets.UTF_8);if(multicast!=null){InetAddress group=InetAddress.getByName("239.255.42.99");Enumeration<NetworkInterface> all=NetworkInterface.getNetworkInterfaces();while(all.hasMoreElements()){NetworkInterface n=all.nextElement();if(n.isUp()&&!n.isLoopback()){try{multicast.setNetworkInterface(n);multicast.send(new DatagramPacket(bytes,bytes.length,group,53318));}catch(Exception ignored){}}}}if(broadcast!=null){broadcast.send(new DatagramPacket(bytes,bytes.length,InetAddress.getByName("255.255.255.255"),53318));Enumeration<NetworkInterface> all=NetworkInterface.getNetworkInterfaces();while(all.hasMoreElements()){NetworkInterface n=all.nextElement();if(n.isUp()&&!n.isLoopback())for(InterfaceAddress a:n.getInterfaceAddresses())if(a.getBroadcast()!=null)try{broadcast.send(new DatagramPacket(bytes,bytes.length,a.getBroadcast(),53318));}catch(Exception ignored){}}}}catch(Exception ignored){}}
    public void close(){running=false;timer.shutdownNow();if(multicast!=null)multicast.close();if(broadcast!=null)broadcast.close();if(lock!=null&&lock.isHeld())lock.release();}
}

package com.linkwave.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;
import android.database.Cursor;
import android.webkit.MimeTypeMap;
import org.json.*;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;

final class HostState {
    static final String VERSION = "1.4.0";
    final Context context;
    final SharedPreferences prefs;
    final String id;
    volatile String name;
    volatile int port = 53317;
    final File inboxDir, tempDir, metadata;
    final Map<String,Device> sessions = new ConcurrentHashMap<>();
    final Map<String,Upload> uploads = new ConcurrentHashMap<>();
    final Map<String,Peer> peers = new ConcurrentHashMap<>();
    final List<JSONObject> inbox = new CopyOnWriteArrayList<>();
    final List<JSONObject> shares = new CopyOnWriteArrayList<>();
    final Map<String,FileLink> fileLinks = new ConcurrentHashMap<>();
    volatile JSONObject pickedFile;
    final ExecutorService workers = Executors.newCachedThreadPool();
    volatile long sentBytes, receivedBytes;
    volatile MainActivity activity;
    volatile boolean closed;

    HostState(Context c) throws Exception {
        context = c.getApplicationContext(); prefs = context.getSharedPreferences("linkwave",Context.MODE_PRIVATE);
        id = prefs.getString("id",UUID.randomUUID().toString());
        name = prefs.getString("name",Build.MODEL + " · 邻波");
        prefs.edit().putString("id",id).putString("name",name).remove("code").apply();
        File external = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        inboxDir = external == null ? new File(context.getFilesDir(),"received") : external;
        // Keep confirmed chunks beside the inbox so completion can rename a
        // multi-gigabyte file instead of copying it across storage volumes.
        tempDir = new File(inboxDir,".uploads");
        metadata = new File(context.getFilesDir(),"state.json");
        if(!inboxDir.exists()) inboxDir.mkdirs(); if(!tempDir.exists()) tempDir.mkdirs();
        load();
        for(JSONObject item:inbox)if(item.optBoolean("saving"))savePublicAsync(item,uploads.get(item.optString("uploadId")));
    }

    static JSONObject obj(Object... pairs) {
        JSONObject j=new JSONObject(); try {for(int i=0;i<pairs.length;i+=2) j.put((String)pairs[i],pairs[i+1]);}catch(JSONException ignored){} return j;
    }
    static String now() { return java.time.Instant.now().toString(); }
    static String newToken() { return UUID.randomUUID().toString().replace("-","")+UUID.randomUUID().toString().replace("-",""); }
    JSONObject server() {return obj("id",id,"name",name,"platform","android","version",VERSION,"port",port);}
    JSONArray urls() {
        JSONArray a = new JSONArray();List<Map.Entry<Integer,String>> addresses=new ArrayList<>();
        try {Enumeration<NetworkInterface> all=NetworkInterface.getNetworkInterfaces(); while(all.hasMoreElements()) {
            NetworkInterface n=all.nextElement();if(!n.isUp()||n.isLoopback())continue;
            String interfaceName=n.getName().toLowerCase(Locale.ROOT);
            int priority=interfaceName.matches("^(wlan|wifi|eth|ap|swlan|p2p).*")?0:interfaceName.matches("^(rmnet|ccmni|tun|vpn).*")?2:1;
            for(InterfaceAddress ia:n.getInterfaceAddresses()) {InetAddress addr=ia.getAddress();if(addr instanceof Inet4Address&&!addr.isLoopbackAddress()&&!addr.isLinkLocalAddress())addresses.add(new AbstractMap.SimpleEntry<>(priority,"http://"+addr.getHostAddress()+":"+port));}
        }}catch(Exception ignored){}
        // A public link should advertise the directly reachable LAN interface.
        // Retain cellular/VPN IPv4 addresses as alternatives, after Wi-Fi/Ethernet.
        addresses.sort(Comparator.comparingInt(Map.Entry::getKey));for(Map.Entry<Integer,String> address:addresses)a.put(address.getValue());
        return a;
    }
    String primaryUrl(){JSONArray a=urls();return a.length()>0?a.optString(0):"http://127.0.0.1:"+port;}
    Device register(String deviceId,String deviceName,String ip,boolean admin) {
        for(Device d:sessions.values())if(d.id.equals(deviceId)) {if(d.admin==admin&&Objects.equals(d.ip,ip)){d.seen=System.currentTimeMillis();if(deviceName!=null&&!deviceName.trim().isEmpty())d.name=limit(deviceName,80);return d;}deviceId=UUID.randomUUID().toString();break;}
        Device d=new Device();d.id=deviceId;d.name=limit(deviceName==null||deviceName.trim().isEmpty()?"新设备":deviceName,80);d.token=newToken();d.admin=admin;d.ip=ip;d.seen=System.currentTimeMillis();sessions.put(d.token,d);save();return d;
    }
    static String limit(String s,int n){return s.length()>n?s.substring(0,n):s;}
    static class Device {String id,name,token,ip;boolean admin;long seen;}
    static class Peer {String id,name,platform,url,ip;volatile long seen;volatile JSONArray shares=new JSONArray();volatile boolean refreshing;}
    static class Upload {String id,name,relativePath,target,owner,from,createdAt,inboxId,peerUploadId,sourceTransferId;volatile String status="uploading",phase="receiving",error;volatile long size,offset,deliveredBytes,lastProgressAt;volatile boolean stopRequested,forwarding;volatile HttpURLConnection connection;File file;boolean busy;}

    String downloadDirectory(){return Build.VERSION.SDK_INT>=29||context.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)==PackageManager.PERMISSION_GRANTED?"系统下载/邻波（同时保存在 "+inboxDir.getAbsolutePath()+"）":inboxDir.getAbsolutePath();}
    JSONObject bootstrap(Device d) {JSONObject b=obj("server",server(),"paired",true,"admin",d!=null&&d.admin,"urls",urls(),"downloadDir",downloadDirectory(),"capabilities",obj("folderPicker",true,"native",true,"directoryZip",false,"directConnect",true));if(d!=null){put(b,"token",d.token);put(b,"device",obj("id",d.id,"name",d.name));}return b;}
    JSONArray localShares(){JSONArray a=new JSONArray();for(JSONObject s:shares)a.put(obj("id",s.optString("id"),"name",s.optString("name"),"type","folder"));return a;}
    JSONObject state(Device caller) {
        JSONArray dev=new JSONArray();long now=System.currentTimeMillis();
        boolean admin=caller!=null&&caller.admin;String callerId=caller==null?"":caller.id;
        for(Device d:sessions.values())if(now-d.seen<60000)dev.put(obj("id",d.id,"name",d.name,"platform",d.admin?"android":"browser","type","browser","online",now-d.seen<20000,"self",d.id.equals(callerId),"ip",d.ip));
        for(Peer p:peers.values())if(now-p.seen<15000)dev.put(obj("id","host:"+p.id,"name",p.name,"platform",p.platform,"type","host","online",true,"url",p.url,"ip",p.ip,"paired",true));
        JSONArray tx=new JSONArray();for(Upload u:uploads.values())if(admin||u.owner.equals(callerId)||u.target.equals(callerId)||u.target.equals("server"))tx.put(transferView(u,u.owner.equals(callerId)?"outgoing":"incoming"));
        JSONArray received=new JSONArray();for(JSONObject f:inbox){String target=f.optString("target","server");if(admin||target.equals("server")||target.equals(callerId)){JSONObject clean=new JSONObject();try{clean=new JSONObject(f.toString());clean.remove("file");clean.remove("target");clean.remove("owner");clean.remove("savedUri");clean.remove("pendingSavedUri");clean.put("url","/api/inbox/"+f.optString("id")+"/download"+(caller==null?"":"?token="+caller.token));}catch(Exception ignored){}received.put(clean);}}
        JSONArray shared=new JSONArray();for(JSONObject s:shares){JSONObject v=obj("id",s.optString("id"),"name",s.optString("name"),"type","folder");if(admin)put(v,"path",s.optString("uri"));shared.put(v);}for(Peer p:peers.values())if(now-p.seen<15000)for(int i=0;i<p.shares.length();i++){JSONObject s=p.shares.optJSONObject(i);if(s!=null)shared.put(obj("id",s.optString("id"),"name",s.optString("name"),"type","folder","hostId",p.id,"sourceName",p.name,"remote",true));}
        JSONObject result=obj("server",server(),"devices",dev,"transfers",tx,"inbox",received,"shares",shared,"downloadDir",downloadDirectory(),"stats",obj("sentBytes",sentBytes,"receivedBytes",receivedBytes),"urls",urls());if(admin){put(result,"fileLinks",fileLinkViews());if(pickedFile!=null)put(result,"pickedFile",pickedFile);}return result;
    }
    String targetName(String target){if(target.equals("server"))return name;if(target.startsWith("host:")){Peer p=peers.get(target.substring(5));return p==null?"局域网设备":p.name;}for(Device d:sessions.values())if(d.id.equals(target))return d.name;return "设备";}
    JSONObject transferView(Upload u,String direction){return obj("id",u.id,"name",u.name,"relativePath",u.relativePath,"targetId",u.target,"size",u.size,"received",u.offset,"deliveredBytes",u.deliveredBytes,"status",u.status,"phase",u.phase,"sourceBuffered",u.target.startsWith("host:")&&u.offset==u.size,"direction",direction,"from",u.from,"to",targetName(u.target),"createdAt",u.createdAt,"error",u.error==null?JSONObject.NULL:u.error);}
    void transferProgress(Upload u,boolean force){if(closed)return;long now=System.currentTimeMillis();if(!force&&now-u.lastProgressAt<1000)return;u.lastProgressAt=now;JSONObject event=transferView(u,u.target.startsWith("host:")?"outgoing":"incoming");HostService host=HostService.instance;if(host!=null)host.notifyTransfer(event);MainActivity active=activity;if(active!=null)active.transferChanged(event);}
    static void put(JSONObject o,String k,Object v){try{o.put(k,v);}catch(JSONException ignored){}}
    synchronized void save(){if(closed)return;try{
        JSONArray i=new JSONArray();for(JSONObject v:inbox)i.put(v);JSONArray s=new JSONArray();for(JSONObject v:shares)s.put(v);
        JSONArray devices=new JSONArray();for(Device d:sessions.values())devices.put(obj("id",d.id,"name",d.name,"token",d.token,"ip",d.ip,"admin",d.admin,"seen",d.seen));
        JSONArray transfers=new JSONArray();for(Upload u:uploads.values())transfers.put(obj("id",u.id,"name",u.name,"relativePath",u.relativePath,"target",u.target,"owner",u.owner,"from",u.from,"status",u.status,"phase",u.phase,"deliveredBytes",u.deliveredBytes,"inboxId",u.inboxId,"peerUploadId",u.peerUploadId,"sourceTransferId",u.sourceTransferId,"error",u.error==null?JSONObject.NULL:u.error,"createdAt",u.createdAt,"size",u.size,"offset",u.offset,"file",u.file.getAbsolutePath()));
        JSONArray links=new JSONArray();for(FileLink link:fileLinks.values())links.put(link.metadata());
        JSONObject data=obj("inbox",i,"shares",s,"fileLinks",links,"devices",devices,"uploads",transfers,"sentBytes",sentBytes,"receivedBytes",receivedBytes);File tmp=new File(metadata.getParentFile(),"state.tmp");
        try(FileOutputStream o=new FileOutputStream(tmp)){o.write(data.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));o.getFD().sync();}
        if(!tmp.renameTo(metadata)){try(FileOutputStream o=new FileOutputStream(metadata)){o.write(data.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}tmp.delete();}
    }catch(Exception e){android.util.Log.w("LinkWave","Could not save transfer state",e);}}
    void load(){try{
        if(!metadata.exists())return;ByteArrayOutputStream b=new ByteArrayOutputStream();try(InputStream in=new FileInputStream(metadata)){copy(in,b,16L*1024*1024);}JSONObject j=new JSONObject(b.toString("UTF-8"));
        JSONArray a=j.optJSONArray("inbox");if(a!=null)for(int i=0;i<a.length();i++){JSONObject f=a.getJSONObject(i);if(new File(f.optString("file")).isFile()){if(!f.has("savedPath"))put(f,"savedPath",f.optString("file"));inbox.add(f);}}
        a=j.optJSONArray("shares");if(a!=null)for(int i=0;i<a.length();i++)shares.add(a.getJSONObject(i));
        a=j.optJSONArray("fileLinks");if(a!=null)for(int i=0;i<a.length();i++){try{FileLink link=FileLink.restore(a.getJSONObject(i));if(link.id.matches("[a-f0-9]{32}"))fileLinks.put(link.id,link);}catch(Exception ignored){}}
        a=j.optJSONArray("devices");if(a!=null)for(int i=0;i<a.length();i++){JSONObject v=a.getJSONObject(i);Device d=new Device();d.id=v.getString("id");d.name=v.getString("name");d.token=v.getString("token");d.ip=v.optString("ip");d.admin=v.optBoolean("admin");d.seen=v.optLong("seen");if(d.token.matches("[a-f0-9]{64}"))sessions.put(d.token,d);}
        a=j.optJSONArray("uploads");if(a!=null)for(int i=0;i<a.length();i++){JSONObject v=a.getJSONObject(i);Upload u=new Upload();u.id=v.getString("id");u.name=v.getString("name");u.relativePath=v.getString("relativePath");u.target=v.getString("target");u.owner=v.getString("owner");u.from=v.optString("from");u.status=v.optString("status","uploading");u.phase=v.optString("phase",u.status.equals("complete")?"complete":"receiving");u.deliveredBytes=v.optLong("deliveredBytes",u.status.equals("complete")?v.optLong("size"):0);u.inboxId=v.optString("inboxId",null);u.peerUploadId=v.optString("peerUploadId",null);u.sourceTransferId=v.optString("sourceTransferId",null);u.createdAt=v.optString("createdAt",now());u.error=v.isNull("error")?null:v.optString("error");u.size=v.getLong("size");u.offset=v.getLong("offset");u.file=new File(v.getString("file"));String uploadPath=u.file.getCanonicalPath(),legacyPath=new File(context.getCacheDir(),"uploads").getCanonicalPath()+File.separator;if(!uploadPath.startsWith(tempDir.getCanonicalPath()+File.separator)&&!uploadPath.startsWith(legacyPath))continue;if(!u.file.isFile()&&!u.status.equals("complete"))continue;if(u.status.equals("sending")){u.status="error";u.phase="error";u.error="服务重启导致发送中断，请重试";}if(u.status.equals("uploading")){u.offset=Math.min(u.offset,u.file.length());try(RandomAccessFile file=new RandomAccessFile(u.file,"rw")){file.setLength(u.offset);}if(!u.target.startsWith("host:"))u.deliveredBytes=u.offset;}uploads.put(u.id,u);}
        sentBytes=j.optLong("sentBytes");receivedBytes=j.optLong("receivedBytes");
    }catch(Exception e){android.util.Log.w("LinkWave","Could not restore transfer state",e);}}
    void close(){closed=true;for(Upload upload:uploads.values()){HttpURLConnection connection=upload.connection;if(connection!=null)connection.disconnect();}workers.shutdownNow();}
    static long copy(InputStream in,OutputStream out,long max)throws IOException{byte[]buf=new byte[65536];long count=0;while(count<max){if(Thread.currentThread().isInterrupted())throw new InterruptedIOException("服务停止，保存将在重新打开后继续");int n=in.read(buf,0,(int)Math.min(buf.length,max-count));if(n<0)break;out.write(buf,0,n);count+=n;}return count;}
    JSONObject receiveFile(File file,String name,String relative,String from,String target,String owner,long size)throws Exception{return receiveFile(file,name,relative,from,target,owner,size,null);}
    JSONObject receiveFile(File file,String name,String relative,String from,String target,String owner,long size,Upload upload)throws Exception{
        if(file.length()!=size)throw new IOException("接收文件长度不完整");
        if(upload!=null){upload.phase="saving";transferProgress(upload,true);}
        String fid=UUID.randomUUID().toString();File dest=new File(inboxDir,fid+"_"+safeName(name));if(!file.renameTo(dest)){try(InputStream in=new FileInputStream(file);FileOutputStream out=new FileOutputStream(dest)){if(copy(in,out,size)!=size)throw new IOException("接收文件未完整保存");out.getFD().sync();}file.delete();}
        JSONObject f=obj("id",fid,"name",name,"size",size,"relativePath",relative,"from",from,"target",target,"owner",owner,"createdAt",now(),"file",dest.getAbsolutePath(),"savedPath",dest.getAbsolutePath(),"saving",true);
        synchronized(this){if(upload!=null){upload.inboxId=fid;upload.status="complete";upload.deliveredBytes=size;put(f,"uploadId",upload.id);}inbox.add(f);receivedBytes+=size;save();}
        HostService host=HostService.instance;if(host!=null)host.notifyReceived(f);MainActivity active=activity;if(active!=null)active.inboxReceived(f);if(upload!=null)transferProgress(upload,true);savePublicAsync(f,upload);return f;
    }
    private void savePublicAsync(JSONObject item,Upload upload){workers.execute(()->{String error=null;JSONObject published=null;try{String pending=item.optString("pendingSavedUri");if(!pending.isEmpty()&&Build.VERSION.SDK_INT>=29){Uri uri=Uri.parse(pending);try(Cursor existing=context.getContentResolver().query(uri,new String[]{MediaStore.Downloads.DISPLAY_NAME,MediaStore.Downloads.IS_PENDING},null,null,null)){if(existing!=null&&existing.moveToFirst()&&existing.getInt(1)==0)published=obj("savedUri",pending,"savedPath","系统下载/邻波/"+existing.getString(0));}if(published==null)context.getContentResolver().delete(uri,null,null);}if(published==null)published=savePublicDownload(new File(item.optString("file")),item);}catch(Exception e){error=e.getMessage()==null?"系统下载副本保存失败，文件仍在收件箱":e.getMessage();android.util.Log.w("LinkWave","Public download copy unavailable; inbox file retained",e);}if(closed||Thread.currentThread().isInterrupted())return;synchronized(this){if(published!=null)for(Iterator<String> keys=published.keys();keys.hasNext();){String key=keys.next();put(item,key,published.opt(key));}item.remove("pendingSavedUri");put(item,"saving",false);if(error!=null)put(item,"saveError",error);if(upload!=null)upload.phase="complete";save();}HostService host=HostService.instance;if(host!=null)host.notifyReceived(item);MainActivity active=activity;if(active!=null)active.inboxSaved(item);if(upload!=null)transferProgress(upload,true);});}
    private JSONObject savePublicDownload(File source,JSONObject item)throws Exception{
        JSONObject result=new JSONObject();
        String filename=safeName(item.optString("name"));
        if(Build.VERSION.SDK_INT>=29){ContentValues values=new ContentValues();values.put(MediaStore.Downloads.DISPLAY_NAME,filename);values.put(MediaStore.Downloads.MIME_TYPE,mime(filename));values.put(MediaStore.Downloads.RELATIVE_PATH,Environment.DIRECTORY_DOWNLOADS+"/邻波");values.put(MediaStore.Downloads.IS_PENDING,1);Uri uri=context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI,values);if(uri==null)throw new IOException("无法创建系统下载文件");synchronized(this){put(item,"pendingSavedUri",uri.toString());save();}try{try(InputStream in=new FileInputStream(source);OutputStream out=context.getContentResolver().openOutputStream(uri)){if(out==null||copy(in,out,source.length())!=source.length())throw new IOException("系统下载文件未完整写入");}values.clear();values.put(MediaStore.Downloads.IS_PENDING,0);context.getContentResolver().update(uri,values,null,null);String publishedName=filename;try(Cursor published=context.getContentResolver().query(uri,new String[]{MediaStore.Downloads.DISPLAY_NAME},null,null,null)){if(published!=null&&published.moveToFirst())publishedName=published.getString(0);}put(result,"savedUri",uri.toString());put(result,"savedPath","系统下载/邻波/"+publishedName);}catch(Exception e){context.getContentResolver().delete(uri,null,null);throw e;}}
        else if(context.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)==PackageManager.PERMISSION_GRANTED){File folder=new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),"邻波");if(!folder.exists()&&!folder.mkdirs())throw new IOException("无法创建下载目录");File dest=new File(folder,filename);if(dest.exists())dest=new File(folder,item.optString("id")+"_"+filename);try(InputStream in=new FileInputStream(source);OutputStream out=new FileOutputStream(dest)){if(copy(in,out,source.length())!=source.length())throw new IOException("系统下载文件未完整写入");}android.media.MediaScannerConnection.scanFile(context,new String[]{dest.getAbsolutePath()},new String[]{mime(filename)},null);put(result,"savedPath",dest.getAbsolutePath());}
        return result;
    }
    Peer connectPeer(String address)throws Exception{
        URI uri=new URI(address.trim());if(!"http".equalsIgnoreCase(uri.getScheme())||uri.getHost()==null||uri.getUserInfo()!=null||uri.getQuery()!=null||uri.getFragment()!=null||(uri.getPath()!=null&&!uri.getPath().isEmpty()&&!uri.getPath().equals("/")))throw new IllegalArgumentException("请输入局域网 HTTP 地址，例如 http://192.168.1.20:53317");
        InetAddress resolved=InetAddress.getByName(uri.getHost());byte[] bytes=resolved.getAddress();boolean private6=bytes.length==16&&(bytes[0]&0xfe)==0xfc;if(!resolved.isSiteLocalAddress()&&!resolved.isLoopbackAddress()&&!resolved.isLinkLocalAddress()&&!private6)throw new IllegalArgumentException("只能连接本机或局域网地址");int remotePort=uri.getPort()<0?80:uri.getPort();if(remotePort<1||remotePort>65535)throw new IllegalArgumentException("端口无效");String host=resolved.getHostAddress();String url="http://"+(host.contains(":")?"["+host+"]":host)+":"+remotePort;JSONObject health=getRemoteJson(url+"/api/health");String peerId=health.optString("serverId");if(!health.optBoolean("ok")||!peerId.matches("[a-zA-Z0-9-]{1,100}"))throw new IOException("此地址没有运行邻波服务");if(peerId.equals(id))throw new IllegalArgumentException("这是当前设备的地址");Peer peer=peers.computeIfAbsent(peerId,k->new Peer());peer.id=peerId;peer.url=url;peer.ip=host;peer.name="局域网设备";peer.platform="unknown";refreshLibrary(peer);return peer;
    }
    void refreshLibraries(){for(Peer peer:peers.values()){if(peer.refreshing)continue;peer.refreshing=true;workers.execute(()->{try{refreshLibrary(peer);}catch(Exception ignored){}finally{peer.refreshing=false;}});}}
    void refreshLibrary(Peer peer)throws Exception{JSONObject data=getRemoteJson(peer.url+"/api/shared-library");JSONObject server=data.optJSONObject("server");if(server==null||!peer.id.equals(server.optString("id")))throw new IOException("目标设备身份发生变化");JSONArray raw=data.optJSONArray("shares"),clean=new JSONArray();if(raw!=null)for(int i=0;i<raw.length();i++){JSONObject share=raw.optJSONObject(i);if(share!=null&&!share.optBoolean("remote")&&share.optString("id").matches("[a-zA-Z0-9-]{1,100}"))clean.put(obj("id",share.optString("id"),"name",limit(share.optString("name","共享文件夹"),160),"type","folder"));}peer.name=limit(server.optString("name","局域网设备"),80);peer.platform=server.optString("platform","unknown");peer.shares=clean;peer.seen=System.currentTimeMillis();}
    static JSONObject getRemoteJson(String url)throws Exception{HttpURLConnection conn=(HttpURLConnection)new URL(url).openConnection();try{conn.setConnectTimeout(2500);conn.setReadTimeout(3500);conn.setInstanceFollowRedirects(false);int status=conn.getResponseCode();if(status!=200)throw new IOException("目标设备返回 "+status);try(InputStream in=conn.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){copy(in,out,1024*1024);return new JSONObject(out.toString("UTF-8"));}}finally{conn.disconnect();}}
    static String safeName(String name){String clean=name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]","_");return limit(clean.isEmpty()?"file":clean,160);}
    static String cleanPath(String path){if(path==null||path.isEmpty())return "";path=path.replace('\\','/');if(path.startsWith("/")||path.indexOf('\0')>=0)throw new IllegalArgumentException("无效文件路径");for(String p:path.split("/"))if(p.equals("..")||p.equals("."))throw new IllegalArgumentException("无效文件路径");return path;}
    static final class FileLink {
        String id,path,name,documentId,authority,createdAt;long size,expiresAt,downloads,device,inode;
        JSONObject metadata(){return obj("id",id,"path",path,"name",name,"size",size,"documentId",documentId,"authority",authority,"createdAt",createdAt,"expiresAt",expiresAt,"downloads",downloads,"device",device,"inode",inode);}
        static FileLink restore(JSONObject j)throws Exception{FileLink l=new FileLink();l.id=j.getString("id");l.path=j.getString("path");l.name=j.getString("name");l.documentId=j.getString("documentId");l.authority=j.getString("authority");l.createdAt=j.getString("createdAt");l.size=j.getLong("size");l.expiresAt=j.optLong("expiresAt");l.downloads=j.optLong("downloads");l.device=j.optLong("device");l.inode=j.optLong("inode");return l;}
        boolean expired(){return expiresAt>0&&System.currentTimeMillis()>=expiresAt;}
    }
    static final class Source implements Closeable {
        final Doc doc;final ParcelFileDescriptor descriptor;final long device,inode;
        Source(Doc d,ParcelFileDescriptor p,long dev,long ino){doc=d;descriptor=p;device=dev;inode=ino;}
        public void close()throws IOException{descriptor.close();}
        InputStream stream(){return new ParcelFileDescriptor.AutoCloseInputStream(descriptor);}
    }
    private Source openDocument(Uri uri,FileLink link)throws Exception{
        if(!"content".equals(uri.getScheme())||!DocumentsContract.isDocumentUri(context,uri)||DocumentsContract.isTreeUri(uri)||uri.getQuery()!=null||uri.getFragment()!=null)throw new IllegalArgumentException("请通过手机文件选择器授权单个文件");
        boolean granted=false;for(UriPermission p:context.getContentResolver().getPersistedUriPermissions())if(p.isReadPermission()&&p.getUri().equals(uri)){granted=true;break;}
        if(!granted)throw new IllegalArgumentException("请重新选择文件以保留只读访问权限");
        String documentId=DocumentsContract.getDocumentId(uri);
        if(link!=null&&(!documentId.equals(link.documentId)||!Objects.equals(uri.getAuthority(),link.authority)))throw new FileNotFoundException("来源文件身份已改变");
        Doc d=new Doc();d.uri=uri;
        try(Cursor c=context.getContentResolver().query(uri,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE,DocumentsContract.Document.COLUMN_LAST_MODIFIED},null,null,null)){
            if(c==null||!c.moveToFirst())throw new FileNotFoundException("来源文件已被移动或无法读取");
            d.id=c.getString(0);d.name=c.getString(1);d.mime=c.getString(2);d.size=c.isNull(3)?-1:c.getLong(3);d.modified=c.isNull(4)?0:c.getLong(4);d.directory=DocumentsContract.Document.MIME_TYPE_DIR.equals(d.mime);
        }
        if(!documentId.equals(d.id))throw new FileNotFoundException("来源文件身份已改变");
        if(d.directory)throw new IllegalArgumentException("链接分享只支持单个文件，不能选择文件夹");
        if(d.name==null||d.name.isEmpty())d.name="file";if(d.mime==null)d.mime=mime(d.name);
        ParcelFileDescriptor descriptor=context.getContentResolver().openFileDescriptor(uri,"r");if(descriptor==null)throw new FileNotFoundException("来源文件无法读取");
        try{
            long device=0,inode=0;StructStat stat=Os.fstat(descriptor.getFileDescriptor());
            if(OsConstants.S_ISREG(stat.st_mode)){device=stat.st_dev;inode=stat.st_ino;d.size=stat.st_size;}
            else if(d.size<0)d.size=descriptor.getStatSize();
            if(link!=null&&link.inode!=0&&(link.device!=device||link.inode!=inode))throw new FileNotFoundException("来源文件已被替换，请重新创建链接");
            return new Source(d,descriptor,device,inode);
        }catch(Exception e){descriptor.close();throw e;}
    }
    void selectFile(Uri uri)throws Exception{
        context.getContentResolver().takePersistableUriPermission(uri,android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try(Source source=openDocument(uri,null)){pickedFile=obj("path",uri.toString(),"name",source.doc.name,"size",Math.max(0,source.doc.size),"selectionId",UUID.randomUUID().toString());}
    }
    synchronized JSONObject createFileLink(String path,long expiresIn)throws Exception{
        if(expiresIn!=0&&expiresIn!=3600&&expiresIn!=86400&&expiresIn!=604800)throw new IllegalArgumentException("有效期应为 1 小时、24 小时、7 天或手动撤销");
        Uri uri=Uri.parse(path);FileLink link=new FileLink();
        try(Source source=openDocument(uri,null)){
            byte[] random=new byte[16];new java.security.SecureRandom().nextBytes(random);StringBuilder id=new StringBuilder(32);for(byte b:random)id.append(String.format(Locale.US,"%02x",b&255));
            link.id=id.toString();link.path=uri.toString();link.name=source.doc.name;link.size=Math.max(0,source.doc.size);link.documentId=source.doc.id;link.authority=uri.getAuthority();link.device=source.device;link.inode=source.inode;link.createdAt=now();link.expiresAt=expiresIn==0?0:System.currentTimeMillis()+expiresIn*1000;
        }
        fileLinks.put(link.id,link);save();return fileLinkView(link);
    }
    Source openFileLink(FileLink link)throws Exception{return openDocument(Uri.parse(link.path),link);}
    JSONObject fileLinkView(FileLink link){
        String status=link.expired()?"expired":"active";long size=link.size;
        if(!link.expired())try(Source source=openFileLink(link)){size=Math.max(0,source.doc.size);link.size=size;}catch(Exception e){status="missing";}
        return obj("id",link.id,"name",link.name,"size",size,"path",link.path,"url",primaryUrl()+"/d/"+link.id+"/"+Uri.encode(link.name),"createdAt",link.createdAt,"expiresAt",link.expiresAt==0?JSONObject.NULL:java.time.Instant.ofEpochMilli(link.expiresAt).toString(),"downloads",link.downloads,"status",status);
    }
    JSONArray fileLinkViews(){List<FileLink> links=new ArrayList<>(fileLinks.values());links.sort((a,b)->b.createdAt.compareTo(a.createdAt));JSONArray a=new JSONArray();for(FileLink l:links)a.put(fileLinkView(l));return a;}
    synchronized boolean revokeFileLink(String id){if(fileLinks.remove(id)==null)return false;save();return true;}
    synchronized void completedFileDownload(FileLink link,long bytes){if(fileLinks.get(link.id)==link){link.downloads++;sentBytes+=Math.max(0,bytes);save();}}
    JSONObject addShare(Uri tree)throws Exception{context.getContentResolver().takePersistableUriPermission(tree,android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);Doc root=document(tree,DocumentsContract.getTreeDocumentId(tree));for(JSONObject s:shares)if(s.optString("uri").equals(tree.toString()))return s;JSONObject s=obj("id",UUID.randomUUID().toString(),"name",root.name,"uri",tree.toString(),"type","folder");shares.add(s);save();return s;}
    JSONObject findShare(String id){for(JSONObject s:shares)if(s.optString("id").equals(id))return s;return null;}
    static final class Doc {Uri uri;String id,name,mime;long size,modified;boolean directory;}
    Doc document(Uri tree,String docId)throws Exception{Uri uri=DocumentsContract.buildDocumentUriUsingTree(tree,docId);try(Cursor c=context.getContentResolver().query(uri,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE,DocumentsContract.Document.COLUMN_LAST_MODIFIED},null,null,null)){if(c==null||!c.moveToFirst())throw new FileNotFoundException("文件已被移动或没有访问权限");return readDoc(c,tree);}}
    Doc readDoc(Cursor c,Uri tree){Doc d=new Doc();d.id=c.getString(0);d.name=c.getString(1);d.mime=c.getString(2);d.size=c.isNull(3)?-1:c.getLong(3);d.modified=c.isNull(4)?0:c.getLong(4);d.directory=DocumentsContract.Document.MIME_TYPE_DIR.equals(d.mime);d.uri=DocumentsContract.buildDocumentUriUsingTree(tree,d.id);return d;}
    List<Doc> children(Uri tree,Doc parent)throws Exception{List<Doc>a=new ArrayList<>();Uri u=DocumentsContract.buildChildDocumentsUriUsingTree(tree,parent.id);try(Cursor c=context.getContentResolver().query(u,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE,DocumentsContract.Document.COLUMN_LAST_MODIFIED},null,null,null)){if(c==null)throw new IOException("无法读取此共享文件夹");while(c.moveToNext())a.add(readDoc(c,tree));}a.sort((x,y)->x.directory!=y.directory?(x.directory?-1:1):x.name.compareToIgnoreCase(y.name));return a;}
    Doc resolve(JSONObject share,String path)throws Exception{Uri tree=Uri.parse(share.getString("uri"));Doc d=document(tree,DocumentsContract.getTreeDocumentId(tree));String p=cleanPath(path);if(p.isEmpty())return d;for(String segment:p.split("/")){if(segment.isEmpty())continue;if(!d.directory)throw new FileNotFoundException("目录不存在");Doc found=null;for(Doc candidate:children(tree,d))if(candidate.name.equals(segment)){found=candidate;break;}if(found==null)throw new FileNotFoundException("文件不存在");d=found;}return d;}
    JSONObject browse(JSONObject share,String path)throws Exception{String p=cleanPath(path);Doc d=resolve(share,p);if(!d.directory)throw new IllegalArgumentException("这不是文件夹");JSONArray entries=new JSONArray();for(Doc child:children(Uri.parse(share.getString("uri")),d)){String childPath=p.isEmpty()?child.name:p+"/"+child.name;entries.put(obj("name",child.name,"path",childPath,"type",child.directory?"folder":"file","size",Math.max(0,child.size),"modifiedAt",java.time.Instant.ofEpochMilli(child.modified).toString(),"mime",child.mime));}String parent=p.isEmpty()?null:(p.contains("/")?p.substring(0,p.lastIndexOf('/')):"");return obj("share",obj("id",share.optString("id"),"name",share.optString("name")),"path",p,"parent",parent==null?JSONObject.NULL:parent,"entries",entries,"total",entries.length());}
    JSONObject subtitles(JSONObject share,String path)throws Exception {
        String videoPath=cleanPath(path);Doc video=resolve(share,videoPath);if(video.directory)throw new IllegalArgumentException("请指定共享视频文件");
        String parent=videoPath.contains("/")?videoPath.substring(0,videoPath.lastIndexOf('/')):"";
        Uri tree=Uri.parse(share.getString("uri"));Doc directory=resolve(share,parent);
        List<JSONObject> tracks=new ArrayList<>(),fonts=new ArrayList<>();Set<String> visited=new HashSet<>();
        scanSubtitles(tree,directory,parent,video.name,0,false,false,tracks,fonts,visited);
        tracks.sort((a,b)->{int order=matchRank(a.optString("match"))-matchRank(b.optString("match"));if(order==0)order=SubtitleSupport.languageRank(a.optString("name"))-SubtitleSupport.languageRank(b.optString("name"));return order==0?a.optString("path").compareToIgnoreCase(b.optString("path")):order;});
        fonts.sort((a,b)->a.optString("path").compareToIgnoreCase(b.optString("path")));
        JSONArray trackArray=new JSONArray(),fontArray=new JSONArray();for(JSONObject track:tracks)trackArray.put(track);for(JSONObject font:fonts)fontArray.put(font);
        return obj("tracks",trackArray,"fonts",fontArray);
    }
    private static int matchRank(String match){return match.equals("exact")?0:match.equals("episode")?1:2;}
    private void scanSubtitles(Uri tree,Doc directory,String path,String videoName,int depth,boolean subtitleTree,boolean fontTree,List<JSONObject> tracks,List<JSONObject> fonts,Set<String> visited)throws Exception {
        if(!visited.add(directory.id))return;
        for(Doc child:children(tree,directory)){
            String relative=path.isEmpty()?child.name:path+"/"+child.name;
            if(child.directory){
                boolean subs=SubtitleSupport.subtitleDirectory(child.name),font=SubtitleSupport.fontDirectory(child.name);
                // Root: named directories only. Inside Subs, accept one extra
                // language/release folder; never walk the shared collection.
                if(depth<2&&(subs||font||subtitleTree||fontTree))scanSubtitles(tree,child,relative,videoName,depth+1,subtitleTree||subs,fontTree||font,tracks,fonts,visited);
                continue;
            }
            if(!fontTree&&SubtitleSupport.isSubtitle(child.name)){
                if(child.size>SubtitleSupport.MAX_BYTES)continue;
                if(tracks.size()>=2048)throw new IllegalArgumentException("此目录字幕过多，请将字幕按视频分目录");
                tracks.add(obj("name",child.name,"path",relative,"format",SubtitleSupport.extension(child.name),"label",SubtitleSupport.label(child.name),"match",SubtitleSupport.match(videoName,child.name)));
            }
            if(SubtitleSupport.isFont(child.name)){
                if(child.size>SubtitleSupport.MAX_FONT_BYTES)continue;
                if(fonts.size()>=64)continue;
                fonts.add(obj("name",child.name,"path",relative));
            }
        }
    }
    String subtitleText(JSONObject share,String path,String format)throws Exception {
        String relative=cleanPath(path);Doc subtitle=resolve(share,relative);
        if(subtitle.directory||!SubtitleSupport.isSubtitle(subtitle.name))throw new IllegalArgumentException("请选择 ASS、SSA、SRT 或 VTT 字幕文件");
        if(!format.equals("raw")&&!format.equals("vtt"))throw new IllegalArgumentException("字幕格式只能是 raw 或 vtt");
        if(subtitle.size>SubtitleSupport.MAX_BYTES)throw new IllegalArgumentException("字幕文件超过 8MB 限制");
        InputStream input=context.getContentResolver().openInputStream(subtitle.uri);if(input==null)throw new FileNotFoundException("字幕文件无法读取");
        String text;try{text=SubtitleSupport.decode(SubtitleSupport.read(input,subtitle.size));}catch(java.nio.charset.CharacterCodingException e){throw new IllegalArgumentException("无法识别字幕编码，请使用 UTF-8、UTF-16 或 GB18030");}return format.equals("raw")?text:SubtitleSupport.toVtt(text,SubtitleSupport.extension(subtitle.name));
    }
    static String mime(String name){String ext=SubtitleSupport.extension(name);if(ext.equals("wasm"))return "application/wasm";if(ext.equals("ttf"))return "font/ttf";if(ext.equals("otf"))return "font/otf";if(ext.equals("ttc"))return "font/collection";String mime=MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);if(mime==null){if(name.endsWith(".mjs")||name.endsWith(".js"))return "application/javascript";if(name.endsWith(".webmanifest"))return "application/manifest+json";if(name.endsWith(".vtt"))return "text/vtt";if(name.endsWith(".svg"))return "image/svg+xml";return "application/octet-stream";}return mime;}
}

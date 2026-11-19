package com.linkwave.app;

import fi.iki.elonen.NanoHTTPD;
import org.json.*;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import com.google.zxing.*;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

final class LanServer extends NanoHTTPD {
    private final HostState state;
    LanServer(HostState s){super(s.port);state=s;}
    public Response serve(IHTTPSession session){
        try{
            Response result=route(session);
            result.addHeader("X-Content-Type-Options","nosniff");
            result.addHeader("Referrer-Policy","no-referrer");
            result.addHeader("X-Frame-Options","SAMEORIGIN");
            // Each request owns its input stream. Closing prevents an ignored or
            // rejected request body from being parsed as the next HTTP verb.
            result.closeConnection(true);
            return result;
        }catch(ApiException e){return error(e.status,e.getMessage());}
        catch(FileNotFoundException e){return error(Response.Status.NOT_FOUND,e.getMessage());}
        catch(SecurityException e){return error(Response.Status.FORBIDDEN,"没有访问此文件夹的权限，请在手机上重新添加共享");}
        catch(IllegalArgumentException e){return error(Response.Status.BAD_REQUEST,e.getMessage());}
        catch(Exception e){android.util.Log.e("LinkWave","HTTP request failed "+session.getUri(),e);return error(Response.Status.INTERNAL_ERROR,"操作失败："+(e.getMessage()==null?"请重试":e.getMessage()));}
    }
    private Response route(IHTTPSession req)throws Exception{
        String path=req.getUri();Method method=req.getMethod();Map<String,String> q=req.getParms();
        String ip=req.getRemoteIpAddress();boolean local=isLocalRequest(req);
        if(path.equals("/d")||path.startsWith("/d/"))return publicFileLink(req);
        if(path.startsWith("/api/"))validateOrigin(req);
        if(path.equals("/api/health"))return json(HostState.obj("ok",true,"version",HostState.VERSION,"serverId",state.id));
        if(path.equals("/api/bootstrap")&&method==Method.GET){HostState.Device d=authenticateOptional(req);if(d==null){String id=q.get("deviceId");if(id==null||!id.matches("[a-zA-Z0-9-]{1,100}"))id=UUID.randomUUID().toString();d=state.register(id,q.get("name"),ip,local);}return json(state.bootstrap(d));}
        if(path.equals("/api/pair")&&method==Method.POST){JSONObject b=body(req);String id=b.optString("deviceId",UUID.randomUUID().toString());if(!id.matches("[a-zA-Z0-9-]{1,100}"))throw new IllegalArgumentException("无效设备标识");HostState.Device d=state.register(id,b.optString("name","新设备"),ip,false);return json(state.bootstrap(d));}
        if(path.equals("/api/peer/pair")&&method==Method.POST){body(req);return json(HostState.obj("token",HostState.newToken(),"server",state.server(),"paired",true));}
        if(path.equals("/api/shared-library")&&method==Method.GET)return json(HostState.obj("server",state.server(),"shares",state.localShares()));
        if(path.startsWith("/api/peers/")&&path.contains("/shares/")&&(method==Method.GET||method==Method.HEAD))return peerShare(req);
        if(path.equals("/api/peer/receive")&&method==Method.POST)return receiveLegacy(req);
        if(!path.startsWith("/api/")){if(method!=Method.GET&&method!=Method.HEAD)throw new ApiException(Response.Status.METHOD_NOT_ALLOWED,"不支持此请求方式");return asset(path,method);}
        HostState.Device d=authenticateOptional(req);boolean publicRead=(method==Method.GET||method==Method.HEAD)&&(path.equals("/api/state")||path.matches("/api/shares/[^/]+/(browse|file|download|subtitles|subtitle)")||path.matches("/api/inbox/[^/]+/download"));if(d==null&&!publicRead)throw new ApiException(Response.Status.UNAUTHORIZED,"连接已断开，请刷新自动重连");if(d!=null)d.seen=System.currentTimeMillis();
        if(path.equals("/api/state")&&method==Method.GET)return json(state.state(d));
        if(path.equals("/api/heartbeat")&&method==Method.POST)return json(HostState.obj("ok",true));
        if(path.equals("/api/device")&&method==Method.POST){d.name=HostState.limit(body(req).optString("name",d.name),80);return json(HostState.obj("id",d.id,"name",d.name));}
        if(path.equals("/api/qr")&&method==Method.GET){admin(d);return qr();}
        if(path.equals("/api/open-inbox")&&method==Method.POST){admin(d);if(state.activity!=null)state.activity.openDownloads();return json(HostState.obj("ok",true,"downloadDir",state.downloadDirectory()));}
        if(path.equals("/api/peers/connect")&&method==Method.POST){HostState.Peer peer=state.connectPeer(body(req).optString("url"));return json(HostState.obj("ok",true,"device",HostState.obj("id","host:"+peer.id,"name",peer.name,"platform",peer.platform,"type","host","online",true,"paired",true,"url",peer.url)));}
        if(path.equals("/api/pick-folder")&&method==Method.POST){admin(d);if(state.activity==null)throw new ApiException(Response.Status.CONFLICT,"请先打开手机上的邻波应用");state.activity.pickFolder();return json(HostState.obj("pending",true));}
        if(path.equals("/api/pick-file")&&method==Method.POST){admin(d);if(state.activity==null)throw new ApiException(Response.Status.CONFLICT,"请先打开手机上的邻波应用");state.activity.pickFile();return json(HostState.obj("pending",true));}
        if(path.equals("/api/file-links")&&method==Method.GET){admin(d);return json(HostState.obj("links",state.fileLinkViews()));}
        if(path.equals("/api/file-links")&&method==Method.POST){admin(d);JSONObject b=body(req);long expiry=86400;if(b.has("expiresIn")){Object raw=b.get("expiresIn");if(!(raw instanceof Number)||((Number)raw).doubleValue()!=((Number)raw).longValue())throw new IllegalArgumentException("无效的链接有效期");expiry=((Number)raw).longValue();}return json(state.createFileLink(b.optString("path"),expiry));}
        if(path.startsWith("/api/file-links/")&&method==Method.DELETE){admin(d);String id=path.substring(16);if(!id.matches("[a-f0-9]{32}")||!state.revokeFileLink(id))throw new FileNotFoundException("链接不存在或已撤销");return json(HostState.obj("ok",true));}
        if(path.equals("/api/peers/pair")&&method==Method.POST){JSONObject b=body(req);String id=b.optString("id");if(id.startsWith("host:"))id=id.substring(5);HostState.Peer peer=state.peers.get(id);if(peer==null)throw new ApiException(Response.Status.NOT_FOUND,"此设备已离线");state.refreshLibrary(peer);return json(HostState.obj("ok",true,"paired",true,"server",HostState.obj("id",peer.id,"name",peer.name)));}
        if(path.equals("/api/settings")&&method==Method.PATCH){
            admin(d);JSONObject b=body(req);String nextName=state.name;
            if(b.has("name")){String name=b.optString("name").trim();if(name.isEmpty())throw new IllegalArgumentException("设备名称不能为空");nextName=HostState.limit(name,80);}
            if(b.has("downloadDir")&&!b.optString("downloadDir").equals(state.inboxDir.getAbsolutePath())&&!b.optString("downloadDir").equals(state.downloadDirectory()))throw new IllegalArgumentException("Android 接收文件自动保存到系统下载/邻波，接收目录由系统管理");
            state.name=nextName;state.prefs.edit().putString("name",state.name).apply();state.save();return json(state.bootstrap(d));
        }
        if(path.equals("/api/shares")&&method==Method.POST){admin(d);JSONObject b=body(req);String p=b.optString("path");if(!p.startsWith("content://"))throw new IllegalArgumentException("Android 请使用选择文件夹按钮授权共享目录");JSONObject shared=state.addShare(Uri.parse(p));if(!b.optString("name").trim().isEmpty()){HostState.put(shared,"name",HostState.limit(b.optString("name"),80));state.save();}return json(shared);}
        if(path.matches("/api/shares/[^/]+/(subtitles|subtitle)")&&(method==Method.GET||method==Method.HEAD)){
            String[] parts=path.substring(12).split("/",2);JSONObject share=state.findShare(parts[0]);if(share==null)throw new FileNotFoundException("共享目录不存在");
            if(parts[1].equals("subtitles"))return json(state.subtitles(share,q.get("path")));
            String format=q.get("format");if(format==null)format="vtt";String text=state.subtitleText(share,q.get("path"),format);
            byte[] data=text.getBytes(StandardCharsets.UTF_8);Response response=newFixedLengthResponse(Response.Status.OK,format.equals("raw")?"text/plain; charset=utf-8":"text/vtt; charset=utf-8",new ByteArrayInputStream(method==Method.HEAD?new byte[0]:data),data.length);
            response.addHeader("Cache-Control","no-store");return response;
        }
        if(path.startsWith("/api/shares/")){String rest=path.substring(12);String[]parts=rest.split("/",2);JSONObject share=state.findShare(parts[0]);if(share==null)throw new FileNotFoundException("共享目录不存在");if(parts.length==1&&method==Method.DELETE){admin(d);state.shares.remove(share);state.save();return json(HostState.obj("ok",true));}if(parts.length==2&&parts[1].equals("browse")&&method==Method.GET)return json(state.browse(share,q.get("path")));if(parts.length==2&&(parts[1].equals("file")||parts[1].equals("download"))&&(method==Method.GET||method==Method.HEAD)){HostState.Doc doc=state.resolve(share,q.get("path"));if(doc.directory)throw new ApiException(Response.Status.NOT_IMPLEMENTED,"Android 暂不支持文件夹 ZIP 下载，请进入目录选择文件下载");InputStream stream;long size=doc.size;ParcelFileDescriptor pfd=state.context.getContentResolver().openFileDescriptor(doc.uri,"r");if(pfd==null)throw new FileNotFoundException("文件无法读取");if(size<0)size=pfd.getStatSize();stream=new ParcelFileDescriptor.AutoCloseInputStream(pfd);return fileResponse(req,stream,size,doc.mime,doc.name,parts[1].equals("download"));}}
        if(path.equals("/api/uploads")&&method==Method.POST)return createUpload(req,d);
        if(path.startsWith("/api/uploads/"))return uploadRequest(req,d);
        if(path.startsWith("/api/inbox/")){String rest=path.substring(11);String[]parts=rest.split("/",2);JSONObject f=null;for(JSONObject candidate:state.inbox)if(candidate.optString("id").equals(parts[0])){f=candidate;break;}if(f==null)throw new FileNotFoundException("文件不存在");String target=f.optString("target","server");if((d==null||!d.admin)&&!target.equals("server")&&(d==null||!target.equals(d.id)))throw new ApiException(Response.Status.FORBIDDEN,"这不是发给此设备的文件");if(parts.length==1&&method==Method.DELETE){if(!d.admin&&!f.optString("owner").equals(d.id)&&(target.equals("server")||!target.equals(d.id)))throw new ApiException(Response.Status.FORBIDDEN,"仅发送者、接收者或本机管理员可以删除此文件");new File(f.getString("file")).delete();state.inbox.remove(f);state.save();return json(HostState.obj("ok",true));}if(parts.length==2&&parts[1].equals("download")&&(method==Method.GET||method==Method.HEAD)){File file=new File(f.getString("file"));return fileResponse(req,new FileInputStream(file),file.length(),HostState.mime(f.getString("name")),f.getString("name"),true);}}
        throw new ApiException(Response.Status.NOT_FOUND,"接口不存在");
    }

    private Response createUpload(IHTTPSession req,HostState.Device d)throws Exception{
        JSONObject b=body(req);String name=b.optString("name");long size=b.optLong("size",-1);validateFile(name,size);
        String relative=HostState.cleanPath(b.optString("relativePath",name)),target=b.optString("targetId","server"),transferId=b.optString("transferId");
        if(!transferId.isEmpty()&&!transferId.matches("[a-zA-Z0-9-]{1,100}"))throw new IllegalArgumentException("无效传输标识");
        if(target.startsWith("host:")){if(!state.peers.containsKey(target.substring(5)))throw new ApiException(Response.Status.CONFLICT,"目标设备已离线，请刷新或输入地址连接");}
        else if(!target.equals("server")){boolean exists=false;for(HostState.Device device:state.sessions.values())if(device.id.equals(target))exists=true;if(!exists)throw new IllegalArgumentException("目标设备不存在");}
        synchronized(state){for(HostState.Upload u:state.uploads.values())if(u.owner.equals(d.id)&&u.name.equals(name)&&u.size==size&&u.relativePath.equals(relative)&&u.target.equals(target)&&(!transferId.isEmpty()?transferId.equals(u.sourceTransferId):u.status.equals("uploading"))){state.transferProgress(u,true);return json(uploadReply(u));}
            HostState.Upload u=new HostState.Upload();u.id=UUID.randomUUID().toString();u.name=name;u.size=size;u.relativePath=relative;u.target=target;u.owner=d.id;u.from=d.name;u.createdAt=HostState.now();u.sourceTransferId=transferId.isEmpty()?null:transferId;u.file=new File(state.tempDir,u.id+".part");if(!u.file.createNewFile())throw new IOException("无法创建临时文件");state.uploads.put(u.id,u);state.save();state.transferProgress(u,true);return json(uploadReply(u));}
    }
    private JSONObject uploadReply(HostState.Upload u){JSONObject reply=HostState.obj("id",u.id,"offset",u.offset,"size",u.size,"chunkSize",4194304,"status",u.status,"phase",u.phase,"deliveredBytes",u.deliveredBytes);if(u.inboxId!=null)HostState.put(reply,"inboxId",u.inboxId);return reply;}
    private Response uploadRequest(IHTTPSession req,HostState.Device d)throws Exception{
        String[] parts=req.getUri().substring(13).split("/",2);Method method=req.getMethod();HostState.Upload u=state.uploads.get(parts[0]);if(u==null)throw new FileNotFoundException("传输记录不存在");if(!u.owner.equals(d.id))throw new ApiException(Response.Status.FORBIDDEN,"无法访问其他设备的传输");
        if(parts.length==1&&method==Method.GET)return json(uploadReply(u));
        if(parts.length==2&&parts[1].equals("pause")&&method==Method.POST){if(!u.target.startsWith("host:"))throw new ApiException(Response.Status.CONFLICT,"接收上传请暂停发送端上传");synchronized(u){if(u.status.equals("complete"))return json(uploadReply(u));u.stopRequested=true;HttpURLConnection connection=u.connection;if(connection!=null)connection.disconnect();u.status="paused";u.phase="paused";u.error="已暂停，点击继续发送";state.save();state.transferProgress(u,true);}return json(uploadReply(u));}
        if(parts.length==1&&method==Method.DELETE){synchronized(u){if(u.busy||u.forwarding||u.status.equals("sending")||u.phase.equals("saving"))throw new ApiException(Response.Status.CONFLICT,"文件正在写入、保存或发送，请稍后再试");u.file.delete();state.uploads.remove(u.id);state.save();}return json(HostState.obj("ok",true));}
        if(parts.length==1&&method==Method.PUT){long offset=longValue(req.getParms().get("offset"),-1),length=contentLength(req);synchronized(u){if(u.busy||!u.status.equals("uploading"))throw new ApiException(Response.Status.CONFLICT,"文件已完成或正在写入");if(offset!=u.offset)return jsonStatus(Response.Status.CONFLICT,HostState.obj("error","断点位置不匹配","offset",u.offset));if(length<0||length>4194304||length>u.size-u.offset)throw new IllegalArgumentException("分块长度不正确");u.busy=true;try(RandomAccessFile file=new RandomAccessFile(u.file,"rw")){file.seek(offset);byte[] buffer=new byte[65536];long read=0;while(read<length){int n=req.getInputStream().read(buffer,0,(int)Math.min(buffer.length,length-read));if(n<0)throw new IOException("上传中断，请重试");file.write(buffer,0,n);read+=n;}file.getFD().sync();u.offset+=read;if(!u.target.startsWith("host:"))u.deliveredBytes=u.offset;u.error=null;state.save();state.transferProgress(u,u.offset==length||u.offset==u.size);}catch(Exception e){try(RandomAccessFile file=new RandomAccessFile(u.file,"rw")){file.setLength(u.offset);}u.error=e.getMessage();state.transferProgress(u,true);throw e;}finally{u.busy=false;}}return json(uploadReply(u));}
        if(parts.length==2&&parts[1].equals("complete")&&method==Method.POST){synchronized(u){if(u.status.equals("complete")||u.status.equals("sending"))return json(uploadReply(u));if(u.forwarding)throw new ApiException(Response.Status.CONFLICT,"正在暂停上一轮发送，请稍后继续");if(u.busy||u.offset!=u.size)throw new ApiException(Response.Status.CONFLICT,"文件尚未全部上传");if(u.target.startsWith("host:")){u.stopRequested=false;u.forwarding=true;u.status="sending";u.phase="connecting";u.error=null;state.save();state.transferProgress(u,true);state.workers.execute(()->forward(u));return json(uploadReply(u));}state.receiveFile(u.file,u.name,u.relativePath,u.from,u.target,u.owner,u.size,u);state.sentBytes+=u.size;state.save();}return json(uploadReply(u));}
        throw new ApiException(Response.Status.METHOD_NOT_ALLOWED,"不支持此传输请求");
    }
    private Response receiveLegacy(IHTTPSession req)throws Exception{
        long size=longValue(req.getParms().get("size"),-1);String name=req.getParms().get("name"),relative=HostState.cleanPath(req.getParms().get("relativePath"));validateFile(name,size);if(contentLength(req)!=size)throw new IllegalArgumentException("文件长度与声明不一致");String from=req.getHeaders().get("x-linkwave-name");try{if(from!=null)from=URLDecoder.decode(from,"UTF-8");}catch(Exception ignored){}
        HostState.Upload u=new HostState.Upload();u.id=UUID.randomUUID().toString();u.name=name;u.relativePath=relative;u.from=from==null?"局域网设备":HostState.limit(from,80);u.target="server";u.owner="peer";u.size=size;u.createdAt=HostState.now();u.file=new File(state.tempDir,u.id+".part");state.uploads.put(u.id,u);state.transferProgress(u,true);
        try{try(FileOutputStream out=new FileOutputStream(u.file)){byte[] buffer=new byte[65536];while(u.offset<size){int n=req.getInputStream().read(buffer,0,(int)Math.min(buffer.length,size-u.offset));if(n<0)throw new IOException("传输中断，请重新发送");out.write(buffer,0,n);u.offset+=n;u.deliveredBytes=u.offset;state.transferProgress(u,false);}out.getFD().sync();}JSONObject f=state.receiveFile(u.file,name,relative,u.from,"server","peer",size,u);return json(HostState.obj("id",f.optString("id"),"status","complete","received",size,"savedPath",f.optString("savedPath"),"saving",f.optBoolean("saving")));}catch(Exception e){u.status="error";u.phase="error";u.error=e.getMessage();u.file.delete();state.save();state.transferProgress(u,true);throw e;}
    }

    private Response publicFileLink(IHTTPSession req)throws Exception{
        if(req.getMethod()!=Method.GET&&req.getMethod()!=Method.HEAD)throw new ApiException(Response.Status.METHOD_NOT_ALLOWED,"下载链接只支持 GET 和 HEAD");
        String[] parts=req.getUri().split("/",-1);
        if(parts.length<3||parts.length>4||!parts[2].matches("[a-f0-9]{32}"))throw new FileNotFoundException("链接不存在或已撤销");
        HostState.FileLink link=state.fileLinks.get(parts[2]);if(link==null)throw new FileNotFoundException("链接不存在或已撤销");
        if(link.expired())throw new ApiException(Response.Status.GONE,"链接已过期，请联系分享者创建新链接");
        HostState.Source source;
        try{source=state.openFileLink(link);}catch(Exception e){throw new FileNotFoundException("来源文件不存在、已被替换或无法读取");}
        boolean count=req.getMethod()==Method.GET&&req.getHeaders().get("range")==null;
        Response response=fileResponse(req,source.stream(),source.doc.size,"application/octet-stream",link.name,true,count?link:null);
        response.addHeader("X-Content-Type-Options","nosniff");response.addHeader("Content-Security-Policy","sandbox; default-src 'none'");response.addHeader("Referrer-Policy","no-referrer");return response;
    }
    private void forward(HostState.Upload u){try{
        HostState.Peer peer=state.peers.get(u.target.substring(5));if(peer==null)throw new IOException("目标设备离线，请重新连接");
        JSONObject boot=remoteJson(u,peer.url+"/api/bootstrap?deviceId="+enc("host-"+state.id)+"&name="+enc(state.name)+"&platform=android","GET",null,null,0);JSONObject server=boot.optJSONObject("server");if(server==null||!peer.id.equals(server.optString("id")))throw new IOException("目标设备身份发生变化，请重新连接");String token=boot.optString("token");if(token.isEmpty())throw new IOException("接收端未建立会话，请更新接收端邻波");
        JSONObject remote=null;if(u.peerUploadId!=null)try{remote=remoteJson(u,peer.url+"/api/uploads/"+enc(u.peerUploadId),"GET",token,null,0);}catch(RemoteException e){if(e.status!=404)throw e;u.peerUploadId=null;}
        if(remote==null){byte[] metadata=HostState.obj("name",u.name,"size",u.size,"relativePath",u.relativePath,"targetId","server","transferId",u.id).toString().getBytes(StandardCharsets.UTF_8);remote=remoteJson(u,peer.url+"/api/uploads","POST",token,metadata,metadata.length);u.peerUploadId=remote.optString("id");if(!u.peerUploadId.matches("[a-zA-Z0-9-]{1,100}"))throw new IOException("接收端返回无效传输标识");state.save();}
        String uploadUrl=peer.url+"/api/uploads/"+enc(u.peerUploadId);long offset=remote.optLong("offset",-1);if(offset<0||offset>u.size)throw new IOException("接收端断点位置无效");u.deliveredBytes=offset;u.phase="sending";state.transferProgress(u,true);
        if(!remote.optString("status").equals("complete")){
            byte[] chunk=new byte[4194304];try(RandomAccessFile source=new RandomAccessFile(u.file,"r")){while(offset<u.size){if(u.stopRequested)throw new IOException("已暂停");int length=(int)Math.min(chunk.length,u.size-offset);source.seek(offset);source.readFully(chunk,0,length);JSONObject reply=null;Exception failure=null;for(int attempt=0;attempt<3;attempt++){try{reply=remoteJson(u,uploadUrl+"?offset="+offset,"PUT",token,chunk,length);break;}catch(Exception e){if(u.stopRequested)throw new IOException("已暂停");failure=e;try{JSONObject probe=remoteJson(u,uploadUrl,"GET",token,null,0);long confirmed=probe.optLong("offset",-1);if(confirmed>=offset+length&&confirmed<=u.size){reply=probe;break;}if(confirmed!=offset)throw new IOException("接收端断点改变，请重新发送");}catch(Exception probeError){failure=probeError;}if(attempt<2)Thread.sleep(350L*(attempt+1));}}
                if(reply==null)throw new IOException("接收端未确认分块，已保留断点，可重试："+(failure==null?"连接中断":failure.getMessage()),failure);long confirmed=reply.optLong("offset",-1);if(confirmed!=offset+length)throw new IOException("接收端确认的分块长度不一致");offset=confirmed;u.deliveredBytes=offset;state.save();state.transferProgress(u,offset==u.size);}}
            u.phase="saving";state.transferProgress(u,true);Exception failure=null;JSONObject completed=null;byte[] empty="{}".getBytes(StandardCharsets.UTF_8);for(int attempt=0;attempt<3;attempt++){try{completed=remoteJson(u,uploadUrl+"/complete","POST",token,empty,empty.length);if(completed.optString("status").equals("complete"))break;}catch(Exception e){if(u.stopRequested)throw new IOException("已暂停");failure=e;try{completed=remoteJson(u,uploadUrl,"GET",token,null,0);if(completed.optString("status").equals("complete"))break;}catch(Exception probeError){failure=probeError;}}if(attempt<2)Thread.sleep(350L*(attempt+1));}if(completed==null||!completed.optString("status").equals("complete"))throw new IOException("接收端未确认文件完成，断点已保留，可重试",failure);
        }
        u.status="complete";u.phase="complete";u.deliveredBytes=u.size;u.error=null;state.sentBytes+=u.size;u.file.delete();
    }catch(Exception e){u.status=u.stopRequested?"paused":"error";u.phase=u.stopRequested?"paused":"error";u.error=e.getMessage()==null?"发送失败，请重新连接后重试":e.getMessage();}finally{u.forwarding=false;state.save();state.transferProgress(u,true);}}
    private static final class RemoteException extends IOException {final int status;RemoteException(int code,String message){super(message);status=code;}}
    private JSONObject remoteJson(HostState.Upload upload,String url,String method,String token,byte[] data,int length)throws Exception{
        HttpURLConnection conn=(HttpURLConnection)new URL(url).openConnection();upload.connection=conn;try{if(upload.stopRequested)throw new IOException("已暂停");conn.setInstanceFollowRedirects(false);conn.setRequestMethod(method);conn.setConnectTimeout(10000);conn.setReadTimeout(45000);conn.setRequestProperty("User-Agent","LinkWaveAndroid/"+HostState.VERSION+" Host");conn.setRequestProperty("X-LinkWave-Name",enc(state.name).replace("+","%20"));if(token!=null)conn.setRequestProperty("Authorization","Bearer "+token);if(data!=null){conn.setDoOutput(true);conn.setFixedLengthStreamingMode(length);conn.setRequestProperty("Content-Type",method.equals("PUT")?"application/octet-stream":"application/json");try(OutputStream out=conn.getOutputStream()){out.write(data,0,length);}}int status=conn.getResponseCode();String text=readText(status<400?conn.getInputStream():conn.getErrorStream(),65536);JSONObject reply;try{reply=new JSONObject(text);}catch(Exception e){throw new IOException("接收端未返回有效确认 ("+status+")");}if(status<200||status>=300)throw new RemoteException(status,reply.optString("error","接收端返回 "+status));return reply;}finally{upload.connection=null;conn.disconnect();}
    }
    private Response peerShare(IHTTPSession req)throws Exception{
        String[] parts=req.getUri().split("/",-1);if(parts.length!=7||!parts[3].matches("[a-zA-Z0-9-]{1,100}")||!parts[5].matches("[a-zA-Z0-9-]{1,100}")||!Arrays.asList("browse","file","download","subtitles","subtitle").contains(parts[6]))throw new FileNotFoundException("共享接口不存在");HostState.Peer peer=state.peers.get(parts[3]);if(peer==null)throw new FileNotFoundException("此设备已离线，请重新连接");String relative=HostState.cleanPath(req.getParms().get("path")),format=req.getParms().get("format");if(format!=null&&!format.equals("raw")&&!format.equals("vtt"))throw new IllegalArgumentException("字幕格式只能是 raw 或 vtt");HttpURLConnection conn=(HttpURLConnection)new URL(peer.url+"/api/shares/"+enc(parts[5])+"/"+parts[6]+"?path="+enc(relative)+(format==null?"":"&format="+enc(format))).openConnection();
        try{conn.setInstanceFollowRedirects(false);conn.setRequestMethod(req.getMethod().name());conn.setRequestProperty("Accept-Encoding","identity");conn.setConnectTimeout(5000);conn.setReadTimeout(60000);String range=req.getHeaders().get("range");if(range!=null)conn.setRequestProperty("Range",range);int status=conn.getResponseCode();if(status>=300&&status<400)throw new IOException("目标共享返回重定向，请重新连接");Response.IStatus responseStatus=Response.Status.lookup(status);if(responseStatus==null)responseStatus=new Response.IStatus(){public int getRequestStatus(){return status;}public String getDescription(){return status+" Remote response";}};long length=conn.getContentLengthLong();InputStream in=req.getMethod()==Method.HEAD?new ByteArrayInputStream(new byte[0]):status>=400?conn.getErrorStream():conn.getInputStream();if(in==null)in=new ByteArrayInputStream(new byte[0]);final HttpURLConnection active=conn;final ReadCounter counter=new ReadCounter(in);InputStream stream=new FilterInputStream(counter){public void close()throws IOException{try{super.close();}finally{if(req.getMethod()!=Method.HEAD&&length>=0&&(counter.failed||counter.bytes!=length))android.util.Log.w("LinkWave","Shared stream interrupted: expected "+length+" bytes, read "+counter.bytes);active.disconnect();}}};String mime=conn.getContentType();if(mime==null)mime="application/octet-stream";Response result=length>=0?newFixedLengthResponse(responseStatus,mime,stream,length):newChunkedResponse(responseStatus,mime,stream);for(String header:Arrays.asList("Content-Range","Accept-Ranges","Content-Disposition","Cache-Control","Content-Security-Policy")){String value=conn.getHeaderField(header);if(value!=null)result.addHeader(header,value);}if(req.getMethod()==Method.HEAD)conn.disconnect();return result;}catch(Exception e){conn.disconnect();throw e;}
    }
    private static String readText(InputStream in,long max)throws Exception{if(in==null)return "";try(InputStream input=in;ByteArrayOutputStream out=new ByteArrayOutputStream()){HostState.copy(input,out,max);return out.toString("UTF-8");}}
    private static String enc(String s)throws Exception{return URLEncoder.encode(s,"UTF-8");}
    private static long contentLength(IHTTPSession req){return longValue(req.getHeaders().get("content-length"),-1);}
    private static long longValue(String s,long fallback){try{return Long.parseLong(s);}catch(Exception e){return fallback;}}
    private JSONObject body(IHTTPSession req)throws Exception{long length=contentLength(req);if(length<0||length>1048576)throw new IllegalArgumentException("请求内容过大或缺少长度");ByteArrayOutputStream out=new ByteArrayOutputStream();long copied=HostState.copy(req.getInputStream(),out,length);if(copied!=length)throw new IOException("请求内容不完整");String text=out.toString("UTF-8");return text.trim().isEmpty()?new JSONObject():new JSONObject(text);}
    private static void validateFile(String name,long size){if(name==null||name.trim().isEmpty()||name.equals(".")||name.equals("..")||name.indexOf('\0')>=0||name.contains("/")||name.contains("\\"))throw new IllegalArgumentException("无效文件名");if(size<0||size>50L*1024*1024*1024)throw new IllegalArgumentException("文件大小超过 50GB 或无效");}
    private static String token(IHTTPSession req){String auth=req.getHeaders().get("authorization");return auth!=null&&auth.startsWith("Bearer ")?auth.substring(7):req.getParms().get("token");}
    private HostState.Device authenticateOptional(IHTTPSession req){String token=token(req);HostState.Device d=token==null?null:state.sessions.get(token);if(d!=null&&d.admin&&!isLocalRequest(req))return null;return d;}
    private static boolean isLocalRequest(IHTTPSession req){String ip=req.getRemoteIpAddress();String host=req.getHeaders().get("host");if(host==null)return false;host=host.toLowerCase(Locale.ROOT);boolean localHost=host.equals("localhost")||host.startsWith("localhost:")||host.equals("127.0.0.1")||host.startsWith("127.0.0.1:")||host.equals("[::1]")||host.startsWith("[::1]:");return localHost&&(ip.equals("127.0.0.1")||ip.equals("::1")||ip.equals("0:0:0:0:0:0:0:1"));}
    private static void admin(HostState.Device d)throws ApiException{if(d==null||!d.admin)throw new ApiException(Response.Status.FORBIDDEN,"请在此手机上的邻波应用中管理共享和设置");}
    private static void validateOrigin(IHTTPSession req)throws ApiException{String origin=req.getHeaders().get("origin");if(origin==null)return;try{URI u=new URI(origin);String host=req.getHeaders().get("host");if(!"http".equals(u.getScheme())||host==null||!host.equalsIgnoreCase(u.getRawAuthority()))throw new Exception();}catch(Exception e){throw new ApiException(Response.Status.FORBIDDEN,"拒绝跨站请求");}}
    private Response asset(String raw,Method method)throws Exception{String path=raw.equals("/")?"index.html":raw.startsWith("/")?raw.substring(1):raw;HostState.cleanPath(path);if(path.indexOf('?')>=0)throw new FileNotFoundException("资源不存在");InputStream in;try{in=state.context.getAssets().open("www/"+path);}catch(FileNotFoundException e){throw new FileNotFoundException("页面资源不存在");}int size=in.available();Response r=newFixedLengthResponse(Response.Status.OK,HostState.mime(path),method==Method.HEAD?null:in,size);if(method==Method.HEAD)in.close();r.addHeader("Cache-Control","no-store");return r;}
    private Response qr()throws Exception{String url=state.primaryUrl()+"/";BitMatrix matrix=new QRCodeWriter().encode(url,BarcodeFormat.QR_CODE,320,320);Bitmap bitmap=Bitmap.createBitmap(320,320,Bitmap.Config.ARGB_8888);for(int y=0;y<320;y++)for(int x=0;x<320;x++)bitmap.setPixel(x,y,matrix.get(x,y)?0xff0d1019:0xffffffff);ByteArrayOutputStream out=new ByteArrayOutputStream();bitmap.compress(Bitmap.CompressFormat.PNG,100,out);bitmap.recycle();byte[]data=out.toByteArray();Response r=newFixedLengthResponse(Response.Status.OK,"image/png",new ByteArrayInputStream(data),data.length);r.addHeader("Cache-Control","no-store");return r;}
    private Response fileResponse(IHTTPSession req,InputStream input,long size,String mime,String name,boolean attachment)throws Exception{return fileResponse(req,input,size,mime,name,attachment,null);}
    private Response fileResponse(IHTTPSession req,InputStream input,long size,String mime,String name,boolean attachment,HostState.FileLink link)throws Exception{
        if(mime==null)mime="application/octet-stream";boolean activeContent=mime.contains("html")||mime.contains("svg")||mime.contains("javascript")||mime.contains("xml");attachment=attachment||activeContent;
        String range=req.getHeaders().get("range");long start=0,end=size-1;boolean partial=false;
        try{if(range!=null&&size>=0){if(!range.matches("bytes=\\d*-\\d*"))throw new ApiException(Response.Status.RANGE_NOT_SATISFIABLE,"不支持此范围请求");String[]p=range.substring(6).split("-",-1);if(p[0].isEmpty()){long suffix=Long.parseLong(p[1]);if(suffix<=0)throw new ApiException(Response.Status.RANGE_NOT_SATISFIABLE,"无效范围请求");start=Math.max(0,size-suffix);}else{start=Long.parseLong(p[0]);if(!p[1].isEmpty())end=Math.min(end,Long.parseLong(p[1]));}if(start>=size||start>end||start<0)throw new ApiException(Response.Status.RANGE_NOT_SATISFIABLE,"请求范围超出文件大小");partial=true;}long remaining=start;while(remaining>0){long n=input.skip(remaining);if(n<=0){if(input.read()<0)throw new IOException("无法定位文件位置");n=1;}remaining-=n;}long length=size<0?-1:Math.max(0,end-start+1);if(req.getMethod()==Method.HEAD){input.close();input=new ByteArrayInputStream(new byte[0]);}Response r=link!=null?new DownloadResponse(input,size,mime,link):size<0?newChunkedResponse(Response.Status.OK,mime,input):newFixedLengthResponse(partial?Response.Status.PARTIAL_CONTENT:Response.Status.OK,mime,input,length);r.addHeader("Accept-Ranges",size>=0?"bytes":"none");r.addHeader("Cache-Control","private, no-store");if(partial)r.addHeader("Content-Range","bytes "+start+"-"+end+"/"+size);if(attachment)r.addHeader("Content-Disposition","attachment; filename*=UTF-8''"+enc(name).replace("+","%20"));if(activeContent)r.addHeader("Content-Security-Policy","sandbox; default-src 'none'");return r;}catch(Exception e){if(input!=null)input.close();if(e instanceof ApiException){Response r=error(((ApiException)e).status,e.getMessage());r.addHeader("Content-Range","bytes */"+size);return r;}throw e;}
    }
    private static final class ReadCounter extends FilterInputStream {
        long bytes;boolean eof,failed;
        ReadCounter(InputStream in){super(in);}
        public int read()throws IOException{try{int n=in.read();if(n<0)eof=true;else bytes++;return n;}catch(IOException e){failed=true;throw e;}}
        public int read(byte[] b,int off,int len)throws IOException{try{int n=in.read(b,off,len);if(n<0)eof=true;else bytes+=n;return n;}catch(IOException e){failed=true;throw e;}}
    }
    private static final class WriteCounter extends FilterOutputStream {
        boolean failed;
        WriteCounter(OutputStream out){super(out);}
        public void write(int b)throws IOException{try{out.write(b);}catch(IOException e){failed=true;throw e;}}
        public void write(byte[] b,int off,int len)throws IOException{try{out.write(b,off,len);}catch(IOException e){failed=true;throw e;}}
        public void flush()throws IOException{try{out.flush();}catch(IOException e){failed=true;throw e;}}
    }
    private final class DownloadResponse extends Response {
        final ReadCounter input;final long size;final HostState.FileLink link;
        DownloadResponse(InputStream stream,long length,String mime,HostState.FileLink file){this(new ReadCounter(stream),length,mime,file);}
        DownloadResponse(ReadCounter stream,long length,String mime,HostState.FileLink file){super(Response.Status.OK,mime,stream,length);input=stream;size=length;link=file;setChunkedTransfer(length<0);setGzipEncoding(false);}
        protected void send(OutputStream out){
            // NanoHTTPD handles socket exceptions internally; observe both ends
            // so a disconnected client or truncated source never counts.
            WriteCounter output=new WriteCounter(out);super.send(output);
            if(getRequestMethod()==Method.GET&&!input.failed&&!output.failed&&(size<0?input.eof:input.bytes==size))state.completedFileDownload(link,input.bytes);
        }
    }
    private static Response json(JSONObject obj){return jsonStatus(Response.Status.OK,obj);}
    private static Response jsonStatus(Response.Status status,JSONObject obj){Response r=newFixedLengthResponse(status,"application/json; charset=utf-8",obj.toString());r.addHeader("Cache-Control","no-store");return r;}
    private static Response error(Response.Status status,String message){Response r=jsonStatus(status,HostState.obj("error",message==null?"操作失败":message));r.closeConnection(true);return r;}
    static final class ApiException extends Exception {final Response.Status status;ApiException(Response.Status s,String message){super(message);status=s;}}
}

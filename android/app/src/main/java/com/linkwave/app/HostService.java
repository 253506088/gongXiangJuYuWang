package com.linkwave.app;

import android.app.*;
import android.content.*;
import android.os.*;
import org.json.JSONObject;

public final class HostService extends Service {
    static volatile HostService instance;
    HostState state;
    LanServer server;
    Discovery discovery;
    private PowerManager.WakeLock wake;
    public void onCreate(){
        super.onCreate();instance=this;
        NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(new NotificationChannel("host","局域网服务",NotificationManager.IMPORTANCE_LOW));
        manager.createNotificationChannel(new NotificationChannel("inbox","收到文件",NotificationManager.IMPORTANCE_HIGH));
        manager.createNotificationChannel(new NotificationChannel("transfers","文件传输进度",NotificationManager.IMPORTANCE_LOW));
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop=new Intent(this,HostService.class).setAction("stop");
        PendingIntent close=PendingIntent.getService(this,1,stop,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification=new Notification.Builder(this,"host").setSmallIcon(R.drawable.ic_launcher).setContentTitle("邻波正在局域网内运行").setContentText("可接收文件、共享视频 · 点按返回，关闭服务可点击停止").setContentIntent(open).setOngoing(true).addAction(new Notification.Action.Builder(null,"停止",close).build()).build();
        startForeground(7317,notification);
        try{state=new HostState(this);for(int port=53317;port<53327;port++){try{state.port=port;server=new LanServer(state);server.start(30000,false);break;}catch(java.io.IOException e){server=null;}}if(server==null)throw new java.io.IOException("局域网服务端口已占用");discovery=new Discovery(state);PowerManager pm=(PowerManager)getSystemService(POWER_SERVICE);wake=pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"linkwave:host");wake.acquire();}catch(Exception e){android.util.Log.e("LinkWave","Host startup failed",e);stopSelf();}
    }
    public int onStartCommand(Intent intent,int flags,int startId){if(intent!=null&&"stop".equals(intent.getAction())){stopSelf();return START_NOT_STICKY;}return START_NOT_STICKY;}
    void notifyReceived(JSONObject file){try{Intent intent=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra("openInbox",true);int notificationId=8000+(file.optString("id").hashCode()&0x7fffffff)%100000;PendingIntent open=PendingIntent.getActivity(this,notificationId,intent,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);String saved=file.optBoolean("saving")?"已收到，正在保存到系统下载/邻波":file.has("saveError")?"已保存在收件箱": "已保存到 "+file.optString("savedPath");Notification notification=new Notification.Builder(this,"inbox").setSmallIcon(R.drawable.ic_launcher).setContentTitle("收到文件："+file.optString("name")).setContentText(file.optString("from","局域网设备")+" · "+saved).setStyle(new Notification.BigTextStyle().bigText("来自 "+file.optString("from","局域网设备")+"\n"+saved+"\n点按查看收件箱")).setContentIntent(open).setOnlyAlertOnce(true).setAutoCancel(true).setCategory(Notification.CATEGORY_MESSAGE).build();((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).notify(notificationId,notification);}catch(Exception e){android.util.Log.w("LinkWave","File notification unavailable",e);}}
    void notifyTransfer(JSONObject transfer){try{NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);int notificationId=180000+(transfer.optString("id").hashCode()&0x7fffffff)%100000;String status=transfer.optString("status"),phase=transfer.optString("phase");if(status.equals("complete")&&!phase.equals("saving")){manager.cancel(notificationId);return;}boolean incoming=transfer.optString("direction").equals("incoming");long size=transfer.optLong("size"),bytes=incoming?transfer.optLong("received"):transfer.optLong("deliveredBytes");int percent=size==0?0:(int)Math.min(100,100.0*bytes/size);String action=phase.equals("saving")?"正在保存":phase.equals("connecting")?"正在连接接收端":incoming?"正在接收":"正在发送";String progress=phase.equals("saving")?"文件已收到 · 正在保存到系统下载/邻波":formatBytes(bytes)+" / "+formatBytes(size)+" · "+percent+"%";if(status.equals("paused")){action="传输已暂停";progress="已保留断点 · "+progress;}if(status.equals("error")){action="传输中断，可重试";progress=transfer.optString("error","请重新连接后重试");}Intent intent=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra("openInbox",true);PendingIntent open=PendingIntent.getActivity(this,notificationId,intent,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);Notification notification=new Notification.Builder(this,"transfers").setSmallIcon(R.drawable.ic_launcher).setContentTitle(action+"："+transfer.optString("name")).setContentText(progress).setSubText(incoming?"来自 "+transfer.optString("from"):"发送到 "+transfer.optString("to")).setProgress(100,percent,phase.equals("saving")||phase.equals("connecting")).setContentIntent(open).setOnlyAlertOnce(true).setOngoing(!status.equals("error")&&!status.equals("paused")).setAutoCancel(status.equals("error")||status.equals("paused")).setCategory(Notification.CATEGORY_PROGRESS).build();manager.notify(notificationId,notification);}catch(Exception e){android.util.Log.w("LinkWave","Transfer notification unavailable",e);}}
    private static String formatBytes(long bytes){if(bytes>=1024L*1024*1024)return String.format(java.util.Locale.CHINA,"%.2f GB",bytes/(1024.0*1024*1024));if(bytes>=1024*1024)return String.format(java.util.Locale.CHINA,"%.1f MB",bytes/(1024.0*1024));return bytes>=1024?String.format(java.util.Locale.CHINA,"%.1f KB",bytes/1024.0):bytes+" B";}
    public IBinder onBind(Intent intent){return null;}
    public void onDestroy(){if(discovery!=null)discovery.close();if(server!=null)server.stop();if(state!=null){state.save();state.close();}if(wake!=null&&wake.isHeld())wake.release();instance=null;super.onDestroy();}
}

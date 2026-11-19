package com.linkwave.app;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.webkit.*;
import android.widget.*;
import android.graphics.Color;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private WebView web;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileCallback;
    private static final int CHOOSE_FILES=10,CHOOSE_FOLDER=11,CHOOSE_LINK_FILE=12;
    private long started;
    private JSONObject pendingInbox;
    private final java.util.Map<String,JSONObject> pendingTransfers=new java.util.LinkedHashMap<>();
    private boolean pageReady,showInbox;
    public void onCreate(Bundle saved){super.onCreate(saved);getWindow().setStatusBarColor(Color.rgb(13,16,25));getWindow().setNavigationBarColor(Color.rgb(13,16,25));WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags&android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0);web=new WebView(this);web.clearCache(true);web.setBackgroundColor(Color.rgb(13,16,25));setContentView(web);WebSettings s=web.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);s.setDatabaseEnabled(true);s.setAllowFileAccess(false);s.setAllowContentAccess(true);s.setMediaPlaybackRequiresUserGesture(false);s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);s.setSupportMultipleWindows(true);s.setUserAgentString(s.getUserAgentString()+" LinkWaveAndroid/1.2.0");if(Build.VERSION.SDK_INT>=26)s.setSafeBrowsingEnabled(true);web.addJavascriptInterface(new Bridge(),"Android");
        web.setWebViewClient(new WebViewClient(){public void onPageFinished(WebView view,String url){pageReady=true;deliverInbox();deliverTransfers();}public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){Uri uri=request.getUrl();String host=uri.getHost();if(("http".equals(uri.getScheme())||"https".equals(uri.getScheme()))&&("127.0.0.1".equals(host)||"localhost".equals(host)))return false;try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception e){toast("没有可以打开此链接的应用");}return true;}});
        web.setWebChromeClient(new WebChromeClient(){
            public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("*/*");intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);try{startActivityForResult(intent,CHOOSE_FILES);}catch(Exception e){fileCallback.onReceiveValue(null);fileCallback=null;toast("无法打开文件选择器");}return true;}
            public boolean onCreateWindow(WebView view,boolean dialog,boolean gesture,Message message){WebView popup=new WebView(MainActivity.this);popup.setWebViewClient(new WebViewClient(){public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){try{startActivity(new Intent(Intent.ACTION_VIEW,r.getUrl()));}catch(Exception ignored){}v.destroy();return true;}});WebView.WebViewTransport transport=(WebView.WebViewTransport)message.obj;transport.setWebView(popup);message.sendToTarget();return true;}
        });
        web.setDownloadListener((url,userAgent,disposition,mime,length)->download(url,disposition,mime));
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},20);
        if(Build.VERSION.SDK_INT<=28&&checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)!=PackageManager.PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE},21);
        showInbox=getIntent().getBooleanExtra("openInbox",false);
        startForegroundService(new Intent(this,HostService.class));started=System.currentTimeMillis();handler.post(this::connect);
    }
    private void connect(){HostService host=HostService.instance;if(host!=null&&host.server!=null&&host.state!=null){host.state.activity=this;web.loadUrl("http://127.0.0.1:"+host.state.port);return;}if(System.currentTimeMillis()-started>30000){new AlertDialog.Builder(this).setTitle("服务启动失败").setMessage("请重新打开邻波，或确认系统允许此应用运行局域网服务。").setPositiveButton("重试",(d,w)->{started=System.currentTimeMillis();startForegroundService(new Intent(this,HostService.class));handler.post(this::connect);}).show();return;}handler.postDelayed(this::connect,100);}
    public void pickFolder(){runOnUiThread(()->{try{Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);startActivityForResult(i,CHOOSE_FOLDER);}catch(Exception e){toast("无法打开共享文件夹选择器");}});}
    public void pickFile(){runOnUiThread(()->{try{Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("*/*");i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);startActivityForResult(i,CHOOSE_LINK_FILE);}catch(Exception e){toast("无法打开文件选择器");}});}
    protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==CHOOSE_FILES&&fileCallback!=null){
            Uri[] uris=null;
            if(result==RESULT_OK&&data!=null){
                if(data.getClipData()!=null){int n=data.getClipData().getItemCount();uris=new Uri[n];for(int i=0;i<n;i++)uris[i]=data.getClipData().getItemAt(i).getUri();}
                else if(data.getData()!=null)uris=new Uri[]{data.getData()};
            }
            fileCallback.onReceiveValue(uris);fileCallback=null;
        }
        if((request==CHOOSE_FOLDER||request==CHOOSE_LINK_FILE)&&result==RESULT_OK&&data!=null&&data.getData()!=null){
            HostService host=HostService.instance;
            if(host!=null&&host.state!=null){
                Uri uri=data.getData();
                host.state.workers.execute(()->{try{
                    if(request==CHOOSE_LINK_FILE)host.state.selectFile(uri);else host.state.addShare(uri);
                    runOnUiThread(()->{toast(request==CHOOSE_LINK_FILE?"文件已选择，创建链接后即可分享":"共享文件夹已添加，局域网设备现在可以浏览");
                        if(web!=null)web.evaluateJavascript("window.dispatchEvent(new Event('"+(request==CHOOSE_LINK_FILE?"linkwave-native-file":"linkwave-native-share")+"'))",null);
                    });
                }catch(Exception e){runOnUiThread(()->toast("选择失败："+e.getMessage()));}});
            }
        }
    }
    private void download(String url,String disposition,String mime){try{Uri uri=Uri.parse(url);if(!"http".equals(uri.getScheme())&&!"https".equals(uri.getScheme()))throw new Exception();String filename=URLUtil.guessFileName(url,disposition,mime);if(disposition!=null&&disposition.contains("filename*=")){String raw=disposition.substring(disposition.indexOf("filename*=")+10);if(raw.startsWith("UTF-8''"))raw=raw.substring(7);int end=raw.indexOf(';');if(end>=0)raw=raw.substring(0,end);filename=java.net.URLDecoder.decode(raw,"UTF-8");}filename=HostState.safeName(filename);DownloadManager.Request request=new DownloadManager.Request(uri).setTitle(filename).setDescription("邻波局域网文件").setMimeType(mime).setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED).setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,filename).setAllowedOverMetered(true);request.addRequestHeader("User-Agent",web.getSettings().getUserAgentString());((DownloadManager)getSystemService(DOWNLOAD_SERVICE)).enqueue(request);toast("正在保存到系统下载文件夹");}catch(Exception e){toast("无法保存文件，请在浏览器中打开后下载");}}
    private void toast(String text){Toast.makeText(this,text,Toast.LENGTH_LONG).show();}
    void inboxReceived(JSONObject file){JSONObject event=HostState.obj("id",file.optString("id"),"name",file.optString("name"),"size",file.optLong("size"),"from",file.optString("from"),"savedPath",file.optString("savedPath"),"saving",file.optBoolean("saving"));runOnUiThread(()->{pendingInbox=event;showInbox=true;deliverInbox();});}
    void inboxSaved(JSONObject file){JSONObject event=HostState.obj("id",file.optString("id"),"saving",file.optBoolean("saving"),"savedPath",file.optString("savedPath"));runOnUiThread(()->{if(web!=null&&pageReady)web.evaluateJavascript("window.dispatchEvent(new CustomEvent('linkwave-inbox-saved',{detail:"+event+"}))",null);});}
    void transferChanged(JSONObject transfer){runOnUiThread(()->{pendingTransfers.put(transfer.optString("id"),transfer);deliverTransfers();});}
    private void deliverTransfers(){if(web==null||!pageReady)return;for(JSONObject transfer:pendingTransfers.values())web.evaluateJavascript("window.dispatchEvent(new CustomEvent('linkwave-transfer',{detail:"+transfer+"}))",null);pendingTransfers.clear();}
    private void deliverInbox(){if(web==null||!pageReady||!showInbox)return;String detail=pendingInbox==null?"{}":pendingInbox.toString();web.evaluateJavascript("window.dispatchEvent(new CustomEvent('linkwave-inbox',{detail:"+detail+"}))",null);pendingInbox=null;showInbox=false;}
    void openDownloads(){runOnUiThread(()->{try{startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));}catch(Exception e){toast("文件已保存在收件箱，请在列表中查看");}});}
    protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);if(intent.getBooleanExtra("openInbox",false)){showInbox=true;deliverInbox();}}
    public void onBackPressed(){if(web.canGoBack())web.goBack();else new AlertDialog.Builder(this).setTitle("邻波继续接收文件").setMessage("返回桌面后局域网服务继续运行，可从通知栏停止。").setPositiveButton("返回桌面",(d,w)->moveTaskToBack(true)).setNegativeButton("停止服务并退出",(d,w)->{stopService(new Intent(this,HostService.class));finish();}).show();}
    protected void onResume(){super.onResume();HostService h=HostService.instance;if(h!=null&&h.state!=null)h.state.activity=this;else if(h==null&&pageReady){pageReady=false;started=System.currentTimeMillis();startForegroundService(new Intent(this,HostService.class));handler.post(this::connect);}deliverInbox();}
    protected void onDestroy(){handler.removeCallbacksAndMessages(null);HostService h=HostService.instance;if(h!=null&&h.state!=null&&h.state.activity==this)h.state.activity=null;if(fileCallback!=null){fileCallback.onReceiveValue(null);fileCallback=null;}if(web!=null)web.destroy();super.onDestroy();}
    final class Bridge {@JavascriptInterface public void pickFolder(){MainActivity.this.pickFolder();}@JavascriptInterface public void pickFile(){MainActivity.this.pickFile();}@JavascriptInterface public void openDownloads(){MainActivity.this.openDownloads();}@JavascriptInterface public void batterySettings(){runOnUiThread(()->{try{startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));}catch(Exception ignored){}});}}
}

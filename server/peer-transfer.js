'use strict';
const fs=require('node:fs/promises');
const {fail,CHUNK_SIZE}=require('./util');
const {openLocalSource,validateLocalSource}=require('./local-files');
async function sendChunks(upload,peer,config,controller,progress){
  let origin;try{origin=new URL(peer.url).origin;}catch{throw fail('接收设备地址无效');}
  async function request(endpoint,options={},timeout=20000){
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(timeout)]);
    try{
      const response=await fetch(origin+endpoint,{redirect:'error',...options,signal});
      let data;try{data=await response.json();}catch{throw fail('接收设备返回了无效响应',502);}
      if(!response.ok)throw fail(data.error||`接收设备请求失败 (${response.status})`,response.status,{offset:data.offset});
      return data;
    }catch(error){
      if(controller.signal.aborted)throw fail('已暂停，点击继续发送',499);
      if(error.status)throw error;
      throw fail(`连接 ${origin} 中断或超时，请确认平板上的邻波仍在运行`,502);
    }
  }
  await progress({phase:'connecting',deliveredBytes:Number(upload.deliveredBytes)||0,targetUrl:origin});
  const health=await request('/api/health',{},8000);
  if(health.serverId!==peer.id)throw fail('接收设备地址已经变化，请重新选择平板',409);
  const bootstrapPath=`/api/bootstrap?deviceId=sender-${config.id}&name=${encodeURIComponent(config.name)}`;
  const boot=await request(bootstrapPath,{headers:{'User-Agent':'LinkWaveHost/1.2.1',...(upload.remoteUpload?.token?{Authorization:'Bearer '+upload.remoteUpload.token}:{})}});
  if(!boot.token||boot.server?.id!==peer.id)throw fail('接收设备无法建立文件传输连接',502);
  const headers={Authorization:'Bearer '+boot.token};
  const json=body=>({...headers,'Content-Type':'application/json'});
  let remote;
  if(upload.remoteUpload?.serverId===peer.id){
    try{remote=await request('/api/uploads/'+upload.remoteUpload.id,{headers});}
    catch(error){if(error.status!==404&&error.status!==403)throw error;}
  }
  if(!remote)remote=await request('/api/uploads',{method:'POST',headers:json(),body:JSON.stringify({name:upload.name,size:upload.size,relativePath:upload.relativePath,targetId:'server',lastModified:upload.createdAt})});
  upload.remoteUpload={serverId:peer.id,id:remote.id,token:boot.token};
  let offset=Number(remote.offset)||0;
  if(!Number.isSafeInteger(offset)||offset<0||offset>upload.size)throw fail('接收设备的续传位置无效',502);
  await progress({phase:'sending',deliveredBytes:offset});
  const file=upload.localSource?await openLocalSource(upload):await fs.open(upload.file,'r');
  try{
    while(offset<upload.size){
      if(controller.signal.aborted)throw fail('已暂停，点击继续发送',499);
      if(upload.localSource)await validateLocalSource(upload,file);
      const length=Math.min(CHUNK_SIZE,upload.size-offset),buffer=Buffer.allocUnsafe(length);
      const result=await file.read(buffer,0,length,offset);if(result.bytesRead!==length)throw fail('电脑缓存文件不完整，请重新选择文件',409);
      let written;
      for(let attempt=0;attempt<3;attempt++){
        try{written=await request(`/api/uploads/${remote.id}?offset=${offset}`,{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream'},body:buffer},90000);break;}
        catch(error){
          if(error.status===499)throw error;
          if(error.status===409&&Number.isSafeInteger(error.offset)){written={offset:error.offset};break;}
          if(error.status<500||attempt===2)throw error;
          const current=await request('/api/uploads/'+remote.id,{headers});if(current.offset!==offset){written=current;break;}
        }
      }
      const next=Number(written.offset);if(!Number.isSafeInteger(next)||next<offset||next>upload.size||next===offset)throw fail('平板未确认文件分块，请重试',502);
      offset=next;await progress({phase:'sending',deliveredBytes:offset});
    }
    if(upload.localSource)await validateLocalSource(upload,file);
  }finally{await file.close();}
  await progress({phase:'saving',deliveredBytes:upload.size});
  const complete=await request(`/api/uploads/${remote.id}/complete`,{method:'POST',headers:json(),body:'{}'},120000);
  if(complete.status!=='complete'||complete.received!==undefined&&complete.received!==upload.size)throw fail('接收设备尚未保存完成，请稍后重试',502);
  return complete;
}
module.exports={sendChunks};

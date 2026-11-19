'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const iconv=require('iconv-lite');
const {fail,resolveShared,safeRelative}=require('./util');
const SUBTITLE=/\.(ass|ssa|srt|vtt)$/i,FONT=/\.(ttf|otf|ttc)$/i,MAX=8*1024*1024;
function stem(name){return String(name).replace(/\.[^.]+$/,'').replace(/\[[^\]]*\]/g,' ').replace(/\([^)]*\)/g,' ').replace(/\bs0*(\d+)e0*(\d+)\b/gi,(_,season,number)=>`s${Number(season)} - ${Number(number)}`).replace(/\b(?:2160p|1080p|720p|480p|4k|x26[45]|h26[45]|hevc|avc|10bit|8bit|flac|aac|web.?dl|bd|end)\b/gi,' ').replace(/[._]+/g,' ').replace(/\s+/g,' ').trim().toLowerCase();}
function episode(name){const value=stem(name);let m=/(.*?\bs\d+)\s*-?\s*(\d{1,3})(?:\s|$)/i.exec(value)||/(.*?)\s*-\s*(\d{1,3})(?:\s|$)/.exec(value)||/(.*?)第\s*(\d{1,3})(?:话|話|集)(?:\s|$)/i.exec(value)||/(.*?)\bep?\s*(\d{1,3})(?:\s|$)/i.exec(value);if(!m)return null;const season=/\bs0*(\d+)\b/i.exec(m[1]);const series=m[1].replace(/\bs\d+\b/gi,'').replace(/[^\p{L}\p{N}]+/gu,'');return series.length>=3?{series,season:season?Number(season[1]):null,number:Number(m[2])}:null;}
function match(video,subtitle){const v=stem(video),s=stem(subtitle);if(v&&s===v||v&&s.startsWith(v+' ')&&/^(?:chs|cht|sc|tc|zh|en|eng|jpn|简|繁|简中|繁中|中文|简日|繁日)/i.test(s.slice(v.length+1)))return 'exact';const a=episode(video),b=episode(subtitle);return a&&b&&a.series===b.series&&a.season===b.season&&a.number===b.number?'episode':'directory';}
function label(name){if(/简|chs|(?:^|[._ -])sc(?:[._ -]|$)/i.test(name))return '简体中文 · '+name;if(/繁|cht|(?:^|[._ -])tc(?:[._ -]|$)/i.test(name))return '繁体中文 · '+name;return name;}
async function discoverSubtitles(root,videoPath){
  const relative=safeRelative(videoPath||''),video=await resolveShared(root,relative);if(!video.stat.isFile())throw fail('请选择视频文件');
  const parent=relative.split('/').slice(0,-1).join('/'),dirs=[parent],tracks=[],fonts=[],seen=new Set();
  for(let index=0;index<dirs.length&&index<20;index++){
    const dir=dirs[index];let target;try{target=await resolveShared(root,dir);}catch{continue;}
    if(!target.stat.isDirectory())continue;
    for(const child of await fs.readdir(target.filename,{withFileTypes:true})){
      const childPath=dir?dir+'/'+child.name:child.name;if(child.isSymbolicLink())continue;
      const depth=childPath.split('/').length-parent.split('/').filter(Boolean).length;
      const relativeDir=dir===parent?'':dir.slice(parent?parent.length+1:0),underSubtitles=/^(subs?|subtitles?|字幕)(?:\/|$)/i.test(relativeDir);
      if(child.isDirectory()&&depth<=2&&(/^(subs?|subtitles?|字幕|fonts?|字体)$/i.test(child.name)||underSubtitles)){dirs.push(childPath);continue;}
      if(!child.isFile()||!SUBTITLE.test(child.name)&&!FONT.test(child.name)||seen.has(childPath))continue;
      let item;try{item=await resolveShared(root,childPath);}catch{continue;}seen.add(childPath);
      if(SUBTITLE.test(child.name)&&item.stat.size<=MAX)tracks.push({name:child.name,path:childPath,format:path.extname(child.name).slice(1).toLowerCase(),label:label(child.name),match:match(path.basename(relative),child.name)});
      if(FONT.test(child.name)&&item.stat.size<=32*1024*1024&&fonts.length<64)fonts.push({name:child.name,path:childPath});
    }
  }
  tracks.sort((a,b)=>({exact:0,episode:1,directory:2}[a.match]-{exact:0,episode:1,directory:2}[b.match])||Number(!/简|chs/i.test(a.name))-Number(!/简|chs/i.test(b.name))||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
  return {tracks:tracks.slice(0,500),fonts};
}
function decodeSubtitle(bytes){
  if(bytes.length>MAX)throw fail('字幕文件不能超过 8 MB',413);
  if(bytes[0]===0xff&&bytes[1]===0xfe)return iconv.decode(bytes,'utf16le').replace(/^\uFEFF/,'');
  if(bytes[0]===0xfe&&bytes[1]===0xff)return iconv.decode(bytes,'utf16be').replace(/^\uFEFF/,'');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{return iconv.decode(bytes,'gb18030');}
}
const escapeText=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function timestamp(value){const m=/^(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());if(!m||Number(m[2])>59||Number(m[3])>59)return null;return `${m[1].padStart(2,'0')}:${m[2]}:${m[3]}.${m[4].padEnd(3,'0')}`;}
function toVtt(text,format){
  const normalized=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/\u0000/g,'');
  if(format==='vtt')return normalized.startsWith('WEBVTT')?normalized:'WEBVTT\n\n'+normalized;
  const cues=[];
  if(format==='ass'||format==='ssa'){
    let events=false,fields=['layer','start','end','style','name','marginl','marginr','marginv','effect','text'];
    for(const line of normalized.split('\n')){
      if(/^\[/.test(line)){events=/^\[events\]/i.test(line.trim());continue;}if(!events)continue;
      if(/^Format:/i.test(line)){fields=line.slice(line.indexOf(':')+1).split(',').map(v=>v.trim().toLowerCase());continue;}
      if(!/^Dialogue:/i.test(line))continue;
      const content=line.slice(line.indexOf(':')+1).trimStart(),parts=[];let rest=content;
      for(let i=0;i<fields.length-1;i++){const comma=rest.indexOf(',');if(comma<0)break;parts.push(rest.slice(0,comma));rest=rest.slice(comma+1);}parts.push(rest);
      if(parts.length!==fields.length)continue;const start=timestamp(parts[fields.indexOf('start')]||''),end=timestamp(parts[fields.indexOf('end')]||'');if(!start||!end)continue;
      const raw=parts[fields.indexOf('text')]||'';if(/\\p[1-9]/i.test(raw))continue;
      const message=escapeText(raw.replace(/\{[^}]*\}/g,'').replace(/\\[Nn]/g,'\n').replace(/\\h/g,' ').trim());if(message)cues.push(`${start} --> ${end}\n${message}`);
    }
  }else if(format==='srt'){
    for(const block of normalized.split(/\n\s*\n/)){
      const lines=block.split('\n');const index=lines.findIndex(line=>line.includes('-->'));if(index<0)continue;
      const times=lines[index].split('-->').map(v=>timestamp(v.trim().split(/\s+/)[0]));if(!times[0]||!times[1])continue;
      const message=escapeText(lines.slice(index+1).join('\n').replace(/<[^>]*>/g,'').trim());if(message)cues.push(`${times[0]} --> ${times[1]}\n${message}`);
    }
  }else throw fail('不支持这种字幕格式');
  return 'WEBVTT\n\n'+cues.join('\n\n')+'\n';
}
async function readSubtitle(root,relative,format='vtt'){
  const target=await resolveShared(root,relative);if(!target.stat.isFile()||!SUBTITLE.test(relative))throw fail('请选择 ASS、SSA、SRT 或 VTT 字幕文件');if(target.stat.size>MAX)throw fail('字幕文件不能超过 8 MB',413);
  const text=decodeSubtitle(await fs.readFile(target.filename));return format==='raw'?text:toVtt(text,path.extname(relative).slice(1).toLowerCase());
}
module.exports={discoverSubtitles,readSubtitle,decodeSubtitle,toVtt,match,episode};

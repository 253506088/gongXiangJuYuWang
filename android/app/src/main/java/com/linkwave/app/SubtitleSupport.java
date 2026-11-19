package com.linkwave.app;

import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.util.*;
import java.util.regex.*;

/** Text-only subtitle fallback and filename matching, shared by SAF routes. */
final class SubtitleSupport {
    static final int MAX_BYTES = 8 * 1024 * 1024;
    static final int MAX_FONT_BYTES = 32 * 1024 * 1024;
    private static final Pattern LANGUAGE = Pattern.compile("(?i)(?:[ ._\\-\\[\\](]+)(?:chs|cht|sc|tc|zh(?:[-_](?:hans|hant|cn|tw))?|cn|jp|ja|en|eng|jpn|gb|big5|简(?:体|中|日)?|繁(?:体|中|日)?|中文|中日|双语|字幕)(?:[ ._\\-\\]()]*)$");
    private static final Pattern EPISODE = Pattern.compile("(?i)^(.*?)(?:[ ._\\-]+(?:ep?|episode)?[ ._\\-]*|第)(\\d{1,3})(?:v\\d)?(?:集|话)?(?:[ ._\\-].*)?$");
    private static final Pattern SEASON_EPISODE = Pattern.compile("(?i)^(.*?)s(\\d{1,2})[ ._\\-]*e(\\d{1,3})(?:v\\d)?(?:[ ._\\-].*)?$");
    private static final Pattern NOISE = Pattern.compile("(?i)\\b(?:\\d{3,4}[pi]|\\d{3,4}x\\d{3,4}|[hx][ ._-]?26[45]|hevc|avc|av1|aac|flac|opus|ac3|dts|\\d{1,2}bit|web[- .]?dl|webrip|bluray|bdrip|bd|dvd|remux|raws)\\b");
    static String extension(String name) {int dot=name.lastIndexOf('.');return dot<0?"":name.substring(dot+1).toLowerCase(Locale.ROOT);}
    static boolean isSubtitle(String name) {return Arrays.asList("ass","ssa","srt","vtt").contains(extension(name));}
    static boolean isFont(String name) {return Arrays.asList("ttf","otf","ttc").contains(extension(name));}
    static boolean subtitleDirectory(String name) {return name.equalsIgnoreCase("sub")||name.equalsIgnoreCase("subs")||name.equalsIgnoreCase("subtitle")||name.equalsIgnoreCase("subtitles")||name.equals("字幕");}
    static boolean fontDirectory(String name) {return name.equalsIgnoreCase("font")||name.equalsIgnoreCase("fonts")||name.equals("字体");}
    static String stem(String name) {int dot=name.lastIndexOf('.');return dot>0?name.substring(0,dot):name;}
    static String withoutLanguage(String value) {String next;do{next=LANGUAGE.matcher(value).replaceFirst("");if(next.equals(value))break;value=next;}while(true);return value.trim();}
    static String canonical(String value) {return value.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]+","");}
    static String cleanRelease(String value) {
        value=withoutLanguage(value);
        value=value.replaceAll("\\[[^\\]]*\\]|【[^】]*】", " ");
        value=NOISE.matcher(value).replaceAll(" ");
        value=value.replaceAll("(?i)(?:^|[ ._\\-])[a-f0-9]{8,}(?=$|[ ._\\-])", " ");
        value=value.replaceAll("\\([ ._-]*\\)"," ");
        Matcher season=Pattern.compile("(?i)\\bs0*(\\d+)\\b").matcher(value);StringBuffer normalized=new StringBuffer();while(season.find())season.appendReplacement(normalized,"s"+Integer.parseInt(season.group(1)));season.appendTail(normalized);
        return normalized.toString().trim().replaceAll("[ ._]+", " ");
    }
    static String episodeKey(String name) {
        String value=cleanRelease(stem(name));Matcher m=SEASON_EPISODE.matcher(value);
        if(m.matches()){String series=canonical(m.group(1));if(series.length()<2)return null;return series+"s"+Integer.parseInt(m.group(2))+":"+Integer.parseInt(m.group(3));}
        m=EPISODE.matcher(value);if(!m.matches())return null;
        String series=canonical(m.group(1));if(series.length()<2)return null;
        return series+":"+Integer.parseInt(m.group(2));
    }
    static String match(String video,String subtitle) {
        String a=canonical(stem(video)),b=canonical(withoutLanguage(stem(subtitle)));
        if(!a.isEmpty()&&a.equals(b))return "exact";
        String key=episodeKey(video);return key!=null&&key.equals(episodeKey(subtitle))?"episode":"directory";
    }
    static int languageRank(String name) {
        String lower=name.toLowerCase(Locale.ROOT);
        if(lower.matches(".*(?:chs|zh[-_]hans|zh[-_]cn|(?:[._ -])sc(?:[._ -]|$)|简体|简中|简日).*"))return 0;
        if(lower.matches(".*(?:中文|中日|双语|(?:[._ -])zh(?:[._ -]|$)).*"))return 1;
        if(lower.matches(".*(?:cht|zh[-_]hant|zh[-_]tw|繁体|繁中).*"))return 2;
        return 3;
    }
    static String label(String name) {
        String language=languageRank(name)==0?"简中":languageRank(name)==1?"中文":languageRank(name)==2?"繁中":"";
        return language.isEmpty()?name:name+" · "+language;
    }
    static byte[] read(InputStream in,long knownSize)throws IOException {
        if(knownSize>MAX_BYTES)throw new IllegalArgumentException("字幕文件超过 8MB 限制");
        try(InputStream input=in;ByteArrayOutputStream out=new ByteArrayOutputStream()) {
            byte[] buffer=new byte[16384];int n;
            while((n=input.read(buffer))!=-1){if(out.size()+n>MAX_BYTES)throw new IllegalArgumentException("字幕文件超过 8MB 限制");out.write(buffer,0,n);}
            return out.toByteArray();
        }
    }
    static String decode(byte[] bytes)throws CharacterCodingException {
        int offset=0;Charset charset=StandardCharsets.UTF_8;
        if(bytes.length>=3&&(bytes[0]&255)==239&&(bytes[1]&255)==187&&(bytes[2]&255)==191)offset=3;
        else if(bytes.length>=2&&(bytes[0]&255)==255&&(bytes[1]&255)==254){offset=2;charset=StandardCharsets.UTF_16LE;}
        else if(bytes.length>=2&&(bytes[0]&255)==254&&(bytes[1]&255)==255){offset=2;charset=StandardCharsets.UTF_16BE;}
        else {
            // UTF-16 subtitle exports sometimes omit the BOM.
            int even=0,odd=0,limit=Math.min(bytes.length,256);for(int i=0;i<limit;i++)if(bytes[i]==0){if(i%2==0)even++;else odd++;}
            if(odd>limit/5&&even<odd/4)charset=StandardCharsets.UTF_16LE;
            else if(even>limit/5&&odd<even/4)charset=StandardCharsets.UTF_16BE;
        }
        try{return decodeAs(bytes,offset,charset);}catch(CharacterCodingException e){
            if(!charset.equals(StandardCharsets.UTF_8)||offset!=0)throw e;
            // Android's charset registry contains GB18030 even when the Java
            // host's optional legacy modules differ. Never silently mojibake.
            Charset legacy=Charset.availableCharsets().get("GB18030");if(legacy==null)throw e;return decodeAs(bytes,0,legacy);
        }
    }
    private static String decodeAs(byte[] bytes,int offset,Charset charset)throws CharacterCodingException {
        return charset.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes,offset,bytes.length-offset)).toString().replace("\r\n","\n").replace('\r','\n').replace("\u0000","");
    }
    private static long timestamp(String value) {
        Matcher m=Pattern.compile("^(?:(\\d{1,4}):)?(\\d{1,2}):(\\d{2})[.,](\\d{1,3})$").matcher(value.trim());
        if(!m.matches())return -1;
        int minutes=Integer.parseInt(m.group(2)),seconds=Integer.parseInt(m.group(3));if(minutes>=60||seconds>=60)return -1;
        String fraction=m.group(4);long millis=Long.parseLong(fraction);if(fraction.length()==1)millis*=100;else if(fraction.length()==2)millis*=10;
        return ((m.group(1)==null?0:Long.parseLong(m.group(1)))*3600+minutes*60+seconds)*1000+millis;
    }
    private static String time(long ms) {return String.format(Locale.ROOT,"%02d:%02d:%02d.%03d",ms/3600000,(ms/60000)%60,(ms/1000)%60,ms%1000);}
    private static String safeText(String text,boolean ass) {
        if(ass){text=text.replaceAll("\\{[^}]*\\}","").replace("\\N","\n").replace("\\n","\n").replace("\\h"," ");}
        // Emit plain cue text: subtitle markup cannot become active HTML, nor
        // can malicious arrows/newlines create additional VTT cue headers.
        text=text.replaceAll("(?is)<(?:script|style)\\b[^>]*>.*?</(?:script|style)\\s*>","").replaceAll("<[^>]*>","");
        text=text.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;");
        return text.replaceAll("\n{2,}","\n").replaceAll("[\\p{Cc}&&[^\\n\\t]]","").trim();
    }
    private static void cue(StringBuilder out,long start,long end,String text,boolean ass) {
        if(ass&&Pattern.compile("(?i)\\\\p[1-9]").matcher(text).find())return;
        if(start<0||end<=start)return;String safe=safeText(text,ass);if(safe.isEmpty())return;
        out.append(time(start)).append(" --> ").append(time(end)).append('\n').append(safe).append("\n\n");
    }
    static String toVtt(String text,String format) {
        StringBuilder out=new StringBuilder("WEBVTT\n\n");
        if(format.equals("ass")||format.equals("ssa")){
            boolean events=false;String[] fields={"Layer","Start","End","Style","Name","MarginL","MarginR","MarginV","Effect","Text"};
            for(String line:text.split("\n",-1)){
                String trimmed=line.trim();if(trimmed.startsWith("[")){events=trimmed.equalsIgnoreCase("[Events]");continue;}
                if(!events)continue;
                if(trimmed.regionMatches(true,0,"Format:",0,7)){fields=trimmed.substring(7).split(",");continue;}
                if(!trimmed.regionMatches(true,0,"Dialogue:",0,9))continue;
                String[] values=trimmed.substring(9).trim().split(",",fields.length);if(values.length!=fields.length)continue;
                String start=null,end=null,body=null;for(int i=0;i<fields.length;i++){String field=fields[i].trim();if(field.equalsIgnoreCase("Start"))start=values[i];else if(field.equalsIgnoreCase("End"))end=values[i];else if(field.equalsIgnoreCase("Text"))body=values[i];}
                if(start!=null&&end!=null&&body!=null)cue(out,timestamp(start),timestamp(end),body,true);
            }
        }else {
            String[] lines=text.split("\n",-1);Pattern timing=Pattern.compile("^\\s*([\\d:.,]+)\\s*-->\\s*([\\d:.,]+)(?:\\s+.*)?$");
            for(int i=0;i<lines.length;i++){Matcher m=timing.matcher(lines[i]);if(!m.matches())continue;StringBuilder body=new StringBuilder();while(++i<lines.length&&!lines[i].trim().isEmpty()){if(body.length()>0)body.append('\n');body.append(lines[i]);}cue(out,timestamp(m.group(1)),timestamp(m.group(2)),body.toString(),false);}
        }
        return out.toString();
    }
}

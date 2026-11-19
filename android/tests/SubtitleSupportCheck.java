package com.linkwave.app;

import java.io.*;
import java.nio.charset.*;
import java.util.*;

/** Authored fixtures only; no third-party subtitle dialogue is stored. */
public final class SubtitleSupportCheck {
    private static void same(Object actual,Object expected){if(!Objects.equals(actual,expected))throw new AssertionError("expected "+expected+", got "+actual);}
    private static void contains(String text,String part){if(!text.contains(part))throw new AssertionError("missing "+part+" in "+text);}
    public static void main(String[] args)throws Exception {
        String video="[Shiniori-Raws] Sousou no Frieren S2 - 01 (1080p x265 AAC) [0123ABCD].mkv";
        same(SubtitleSupport.match(video,"[SubsPlease] Sousou no Frieren S2 - 01.CHS.ass"),"episode");
        same(SubtitleSupport.match(video,"[SubsPlease] Another Series S2 - 01.CHS.ass"),"directory");
        same(SubtitleSupport.match(video,"[SubsPlease] Sousou no Frieren S1 - 01.CHS.ass"),"directory");
        same(SubtitleSupport.match(video,"[SubsPlease] Sousou no Frieren S2 - 02.CHS.ass"),"directory");
        same(SubtitleSupport.match("Example S2 - 01.mkv","Example S02E01.ass"),"episode");
        same(SubtitleSupport.match("Example - 01.mkv","Example - 01.zh-hans.srt"),"exact");
        same(SubtitleSupport.match("01.mp4","01.ass"),"exact");
        same(SubtitleSupport.match("01.mp4","Other - 01.ass"),"directory");
        String ass="[Script Info]\nTitle: Authored fixture - Episode 29\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize\nStyle: Default,Example Font,32\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:01.23,0:00:04.56,Default,,0,0,0,,{\\pos(300,80)\\i1}中文测试\\NSecond, line\\h& safe\n";
        same(SubtitleSupport.decode(ass.getBytes(StandardCharsets.UTF_8)),ass);
        for(Charset charset:new Charset[]{StandardCharsets.UTF_16LE,StandardCharsets.UTF_16BE,Charset.forName("GB18030")}){
            byte[] bytes=ass.getBytes(charset);if(charset.equals(StandardCharsets.UTF_16LE)||charset.equals(StandardCharsets.UTF_16BE)){byte[] bom=charset.equals(StandardCharsets.UTF_16LE)?new byte[]{(byte)255,(byte)254}:new byte[]{(byte)254,(byte)255};byte[] joined=new byte[bytes.length+2];System.arraycopy(bom,0,joined,0,2);System.arraycopy(bytes,0,joined,2,bytes.length);bytes=joined;}same(SubtitleSupport.decode(bytes),ass);
        }
        String vtt=SubtitleSupport.toVtt(ass,"ass");contains(vtt,"00:00:01.230 --> 00:00:04.560");contains(vtt,"中文测试\nSecond, line &amp; safe");same(vtt.contains("pos("),false);
        String drawing=SubtitleSupport.toVtt(ass+"Dialogue: 0,0:00:01.23,0:00:04.56,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}\n","ass");same(drawing.contains("m 0 0"),false);
        String srt="1\n00:00:01,100 --> 00:00:03,200\n<b>中文</b><script>alert('fixture')</script> & A --> B\n\n2\n00:00:10,000 --> 00:00:09,000\ninvalid interval\n";
        vtt=SubtitleSupport.toVtt(srt,"srt");contains(vtt,"中文 &amp; A --&gt; B");same(vtt.contains("script"),false);same(vtt.contains("invalid interval"),false);
        byte[] large=new byte[SubtitleSupport.MAX_BYTES+1];boolean rejected=false;try{SubtitleSupport.read(new ByteArrayInputStream(large),-1);}catch(IllegalArgumentException e){rejected=true;}same(rejected,true);
        same(SubtitleSupport.isFont("Example.ttc"),true);
        System.out.println("PASS Android subtitle matching, season isolation, authored ASS/SRT escaping, UTF8/UTF16/GB18030 and 8MB streaming limit");
    }
}

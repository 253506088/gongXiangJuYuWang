'use strict';
(() => {
  const escapeCue = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes).replace(/^\uFEFF/, '');
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/, '');
    try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes).replace(/^\uFEFF/, ''); }
    catch { return new TextDecoder('gb18030').decode(bytes).replace(/^\uFEFF/, ''); }
  }
  function seconds(value) {
    const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/);
    return match ? Number(match[1])*3600 + Number(match[2])*60 + Number(match[3]) + Number(`0.${match[4] || '0'}`) : NaN;
  }
  function timestamp(value) {
    const milliseconds = Math.max(0, Math.round(value*1000));
    return `${String(Math.floor(milliseconds/3600000)).padStart(2,'0')}:${String(Math.floor(milliseconds/60000)%60).padStart(2,'0')}:${String(Math.floor(milliseconds/1000)%60).padStart(2,'0')}.${String(milliseconds%1000).padStart(3,'0')}`;
  }
  function toVtt(content, format) {
    const text = String(content).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (format === 'vtt') {
      if (!/^WEBVTT(?:[ \t]|\n|$)/.test(text.trimStart())) throw new Error('这个文件不是有效的 WebVTT 字幕');
      return text;
    }
    const cues = [];
    if (format === 'srt') {
      for (const block of text.split(/\n\s*\n/)) {
        const lines = block.trim().split('\n');
        const index = lines.findIndex(line => line.includes('-->'));
        if (index < 0) continue;
        const times = lines[index].match(/(\d+:\d{2}:\d{2}[.,]\d+)\s*-->\s*(\d+:\d{2}:\d{2}[.,]\d+)/);
        if (!times) continue;
        const start = seconds(times[1]), end = seconds(times[2]);
        if (Number.isFinite(start) && end > start) cues.push(`${timestamp(start)} --> ${timestamp(end)}\n${lines.slice(index+1).join('\n')}`);
      }
    } else if (format === 'ass' || format === 'ssa') {
      let inEvents = false, fields = ['layer','start','end','style','name','marginl','marginr','marginv','effect','text'];
      for (const line of text.split('\n')) {
        if (/^\s*\[/.test(line)) { inEvents = /^\s*\[events\]/i.test(line); continue; }
        if (!inEvents) continue;
        if (/^\s*Format:/i.test(line)) { fields = line.replace(/^\s*Format:\s*/i,'').split(',').map(field=>field.trim().toLowerCase()); continue; }
        if (!/^\s*Dialogue:/i.test(line)) continue;
        const textIndex = fields.indexOf('text');
        const values = line.replace(/^\s*Dialogue:\s*/i,'').split(',');
        if (textIndex < 0 || values.length < fields.length) continue;
        // ASS text is the final field and may itself contain commas.
        const cueText = values.slice(textIndex).join(',').replace(/\{[^}]*\}/g,'').replace(/\\[Nn]/g,'\n').replace(/\\h/g,' ');
        const start = seconds(values[fields.indexOf('start')]), end = seconds(values[fields.indexOf('end')]);
        if (Number.isFinite(start) && end > start && cueText.trim()) cues.push(`${timestamp(start)} --> ${timestamp(end)}\n${escapeCue(cueText)}`);
      }
    } else throw new Error('请选择 ASS、SSA、SRT 或 VTT 字幕');
    if (!cues.length) throw new Error('字幕中没有可读取的时间轴');
    return `WEBVTT\n\n${cues.join('\n\n')}\n`;
  }
  globalThis.LinkWaveSubtitles = { decode, toVtt };
})();

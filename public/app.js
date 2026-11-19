'use strict';
(() => {
  // Android 8–11 may ship an older WebView. Install the small DOM fallback before
  // bootstrap renders device lists or opens any dialog.
  for (const constructor of [globalThis.Element, globalThis.DocumentFragment, globalThis.Document]) {
    if (constructor && !constructor.prototype.replaceChildren) Object.defineProperty(constructor.prototype, 'replaceChildren', {
      configurable:true, writable:true,
      value:function(...children) {
        while (this.firstChild) this.removeChild(this.firstChild);
        const document = this.ownerDocument || this;
        for (const child of children) this.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
      }
    });
  }
  if (!Array.prototype.at) Object.defineProperty(Array.prototype, 'at', {
    configurable:true, writable:true,
    value:function(index) { const length=this.length; const number=Number(index)||0; const integer=number<0?Math.ceil(number):Math.floor(number); const position=integer<0?length+integer:integer; return position<0||position>=length?undefined:this[position]; }
  });
  const $ = id => document.getElementById(id);
  const storage = { get(key, fallback = '') { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }, set(key, value) { try { localStorage.setItem(key, value); } catch {} }, remove(key) { try { localStorage.removeItem(key); } catch {} } };
  const uuid = () => globalThis.crypto?.randomUUID?.() || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  const defaultName = /Android/i.test(navigator.userAgent) ? '我的安卓手机' : /iPhone|iPad/i.test(navigator.userAgent) ? '我的 iPhone' : /Windows/i.test(navigator.userAgent) ? '我的电脑' : '我的设备';
  let deviceId = storage.get('linkwave.deviceId', uuid());
  let deviceName = storage.get('linkwave.deviceName', defaultName);
  let token = storage.get(`linkwave.token:${location.host}`);
  storage.set('linkwave.deviceId', deviceId);
  let boot = null, state = null, view = 'transfer', targetId = '', pollTimer, heartbeatTimer, ws, fetchingState = false, online = true, failures = 0, activityFilter = 'all';
  let currentShare = null, currentPath = '', browseData = null, browseRequest = 0, subtitleUrl = null, playerElement = null, modalCleanup = null, modalBusy = false;
  const jobs = [], seenInbox = new Set(), unreadInbox = new Set(), seenIncoming = new Set(), receiveSamples = new Map();
  let hasInitialInbox = false, queueRunning = false, renderJobTimer, sessionRefresh = null, pendingInboxEvent = null;
  let pendingTransferEvents = [], hasInitialTransfers = false;
  let pendingFilePick = null;
  let localPickerBusy = false;
  const viewLabels = { transfer: '文件互传', media: '影音共享', activity: '传输记录', settings: '偏好设置' };

  function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
  function icon(name, small = false) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', `icon${small ? ' small' : ''}`); svg.setAttribute('aria-hidden', 'true'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg; }
  function button(text, className, fn, name) { const b = el('button', className || 'button secondary', text); b.type = 'button'; if (name) b.prepend(icon(name)); if (fn) b.addEventListener('click', fn); return b; }
  function action(name, label, fn, danger = false) { const b = button('', `icon-button${danger ? ' danger' : ''}`, fn); b.append(icon(name)); b.title = label; b.setAttribute('aria-label', label); return b; }
  function bytes(n) { n = Math.max(0, Number(n) || 0); if (n < 1024) return `${n} B`; const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4); return `${(n / 1024 ** i).toFixed(n / 1024 ** i >= 100 ? 0 : n / 1024 ** i >= 10 ? 1 : 2).replace(/\.0+$/, '')} ${['B','KB','MB','GB','TB'][i]}`; }
  function date(n, short = false) { const value = new Date(n); return Number.isFinite(value.getTime()) ? value.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', ...(short ? {} : { hour:'2-digit', minute:'2-digit' }) }) : ''; }
  function fileKind(name, mime = '') { if (mime.startsWith('video/') || /\.(mp4|webm|mkv|mov|m4v|avi|mpeg|mpg|ts)$/i.test(name)) return 'video'; if (mime.startsWith('audio/') || /\.(mp3|flac|m4a|aac|wav|ogg|opus)$/i.test(name)) return 'audio'; if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(name)) return 'image'; return 'file'; }
  function fileIcon(name, mime, folder = false) { const kind = folder ? 'folder' : fileKind(name, mime); const node = el('span', `file-icon ${kind}`); node.append(icon({video:'film',audio:'music',image:'image',file:'file',folder:'folder'}[kind])); return node; }
  function statusText(status) { return ({uploading:'正在上传',sending:'正在发送',complete:'已送达',error:'传输失败',paused:'已暂停',queued:'等待发送',cancelled:'已取消'})[status] || status; }
  function statusNode(status, label) { const node = el('span', `file-status ${status}`, label || statusText(status)); if (status === 'complete') node.prepend(icon('check', true)); return node; }
  function transferRecords() {
    const records = [...(state?.transfers || [])];
    for (const upload of state?.uploads || []) {
      if (records.some(t => t.id === upload.id)) continue;
      const direction = upload.direction || (upload.owner === deviceId ? 'outgoing' : boot?.admin ? 'incoming' : 'outgoing');
      records.push({...upload, direction, received:upload.received ?? upload.offset ?? 0, to:upload.to || upload.targetId});
    }
    return records;
  }
  function boundedOffset(value, size) { return Math.min(Math.max(0, Number(size) || 0), Math.max(0, Number(value) || 0)); }
  function usesLocalFiles() { return boot?.admin === true && boot?.capabilities?.localFiles === true; }
  function progressInfo(transfer, speed = 0) {
    const size = Math.max(0, Number(transfer.size) || 0);
    const incoming = transfer.direction === 'incoming';
    const forwarding = !incoming && (transfer.localSource || transfer.status === 'sending' || transfer.sourceBuffered || ['connecting','sending','saving'].includes(transfer.phase));
    const offset = boundedOffset(forwarding ? transfer.deliveredBytes : transfer.received, size);
    const percent = size ? offset / size * 100 : transfer.status === 'complete' ? 100 : 0;
    const count = `${bytes(offset)} / ${bytes(size)}`;
    let label;
    if (transfer.phase === 'saving') label = incoming ? '已收到 · 正在保存到系统下载' : `${transfer.to || '对方'}正在保存文件`;
    else if (incoming) label = `${transfer.status === 'error' ? '接收已中断' : '正在接收'} · ${count}`;
    else if (forwarding) label = `${transfer.status === 'queued' ? '等待发送到' : ['paused','error'].includes(transfer.status) ? '发送已暂停于' : transfer.phase === 'connecting' ? '正在连接' : '正在发送到'} ${transfer.to || '对方'} · ${count}`;
    else label = `${transfer.status === 'queued' ? '等待上传到' : ['paused','error'].includes(transfer.status) ? '上传已暂停于' : '正在上传到'}${boot?.admin ? '本机' : '当前主机'} · ${count}`;
    return {offset, percent, label, detail: `${speed > 0 ? `${bytes(speed)}/s · ` : ''}${percent.toFixed(0)}%`};
  }
  function appendProgress(detail, info, incoming = false) {
    const track = el('div', 'progress-track');
    const bar = el('div', `progress-bar${incoming ? ' incoming' : ''}`); bar.style.width = `${info.percent}%`; track.append(bar);
    track.setAttribute('role', 'progressbar'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.setAttribute('aria-valuenow', String(Math.round(info.percent))); track.setAttribute('aria-label', info.label);
    const extra = el('div', 'progress-extra'); extra.append(el('span', '', info.label), el('span', '', info.detail));
    detail.append(track, extra);
  }
  function empty(name, title, description, large = false, extra) { const node = el('div', `empty-state${large ? ' large' : ''}`); node.append(icon(name), el('strong', '', title), el('p', '', description)); if (extra) node.append(extra); return node; }
  function toast(message, error = false) { const node = el('div', `toast${error ? ' error' : ''}`); node.append(icon(error ? 'info' : 'check'), el('span', '', message)); $('toast-region').append(node); setTimeout(() => { node.classList.add('leaving'); setTimeout(() => node.remove(), 250); }, error ? 6500 : 4000); }
  function url(path) { const address = new URL(path, location.origin); address.searchParams.set('token', token); return address.pathname + address.search; }
  async function api(path, options = {}, retrySession = true) {
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers };
    let body = options.body;
    if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const response = await fetch(path, { ...options, headers, body, cache:'no-store' });
    if (response.status === 401 && retrySession && !path.startsWith('/api/bootstrap')) {
      await bootstrapSession();
      return api(path, options, false);
    }
    let data; try { data = await response.json(); } catch { data = {error:`请求失败 (${response.status})`}; }
    if (!response.ok) { const error = new Error(data.error || `请求失败 (${response.status})`); error.status = response.status; error.data = data; throw error; }
    return data;
  }
  function persistSession(data) {
    if (data.token) { token = data.token; storage.set(`linkwave.token:${location.host}`, token); }
    if (data.device?.id) { deviceId = data.device.id; storage.set('linkwave.deviceId', deviceId); }
    if (data.device?.name) { deviceName = data.device.name; storage.set('linkwave.deviceName', deviceName); }
  }
  async function bootstrapSession() {
    if (sessionRefresh) return sessionRefresh;
    sessionRefresh = (async () => {
      const response = await fetch(`/api/bootstrap?deviceId=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(deviceName)}`, {cache:'no-store'});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '暂时无法连接主机');
      const previousToken = token;
      persistSession(data);
      boot = {...boot, ...data};
      if (!data.token) throw new Error('主机未返回连接信息，请重试');
      if (ws && previousToken !== token) connectWs();
      return boot;
    })();
    try { return await sessionRefresh; } finally { sessionRefresh = null; }
  }
  async function initialize() {
    $('loading-error').hidden = true; $('loading-retry').hidden = true;
    try {
      await bootstrapSession();
      await enterApp();
    } catch (error) {
      $('loading-screen').hidden = false;
      $('loading-error').textContent = `无法连接主机：${error.message}。请确认主机正在运行，并且设备处于同一网络。`;
      $('loading-error').hidden = false; $('loading-retry').hidden = false;
    }
  }
  async function enterApp() {
    $('app').hidden = false; $('loading-screen').hidden = true;
    document.querySelectorAll('.admin-only').forEach(node => { node.hidden = !boot.admin; });
    $('self-name').textContent = deviceName; $('self-label').textContent = boot.admin ? '当前主机 · 本机' : '此设备 · 已连接';
    $('top-avatar').textContent = deviceName.slice(0, 1).toUpperCase();
    $('device-name').value = deviceName;
    if (boot.server) { $('server-name').value = boot.server.name || ''; $('app-version').textContent = `v${boot.server.version || '1.0.0'}`; }
    $('download-dir').value = boot.downloadDir || '';
    configureFileSelection();
    if (boot.capabilities?.native || /android/i.test(boot.server?.platform || '') && boot.admin) {
      $('download-dir').readOnly = true; $('pick-download-dir').hidden = true;
      $('download-dir-help').textContent = '安卓主机自动管理接收目录，可从 App 的下载列表查看。';
    }
    if (boot.capabilities?.directoryZip && !$('download-folder')) { const download = action('download', '将当前文件夹下载为 ZIP', () => { if (!currentShare) return; const a = el('a'); a.href = url(sharePath(currentShare, 'download', currentPath)); a.download = `${currentShare.name}.zip`; document.body.append(a); a.click(); a.remove(); }); download.id = 'download-folder'; $('browser-refresh').before(download); }
    const initialView = location.hash.slice(1); switchView(viewLabels[initialView] ? initialView : 'transfer');
    await refreshState();
    clearInterval(pollTimer); clearInterval(heartbeatTimer);
    pollTimer = setInterval(refreshState, 3000);
    heartbeatTimer = setInterval(() => api('/api/heartbeat', {method:'POST',body:{}}).catch(() => {}), 10000);
    api('/api/heartbeat', {method:'POST',body:{}}).catch(() => {});
    connectWs();
    if ('serviceWorker' in navigator && (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.protocol === 'https:')) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  function connectWs() {
    if (!token || boot?.capabilities?.native) return;
    if (ws) { ws.onclose = null; ws.close(); }
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onmessage = event => { try { const data = JSON.parse(event.data); if (data.type === 'state') refreshState(); } catch {} };
      ws.onerror = () => {};
      ws.onclose = () => { if (token) setTimeout(connectWs, 15000); };
    } catch {}
  }
  async function refreshState() {
    if (!token || fetchingState) return;
    fetchingState = true;
    try {
      const next = await api('/api/state');
      state = next; failures = 0; setOnline(true);
      if (next.server) boot.server = next.server;
      if (next.urls) boot.urls = next.urls;
      if (next.downloadDir) boot.downloadDir = next.downloadDir;
      const revealPendingTransfer = pendingTransferEvents.some(t => t.direction === 'incoming' && !seenIncoming.has(t.id));
      for (const transfer of pendingTransferEvents) patchNativeTransfer(transfer);
      pendingTransferEvents = [];
      renderDevices(); syncCompletedJobs(); renderReceiving(); renderInbox(); renderFileLinks(); renderShares(); renderActivity();
      if (revealPendingTransfer && !$('receive-section').hidden) revealReceiving();
      if (pendingFilePick && next.pickedFile?.selectionId && next.pickedFile.selectionId !== pendingFilePick.selectionId) pendingFilePick.apply(next.pickedFile);
      $('stat-sent').textContent = bytes(next.stats?.sentBytes);
      $('stat-received').textContent = bytes(next.stats?.receivedBytes);
    } catch (error) {
      failures++; if (failures > 1) setOnline(false);
      if (error.status === 401) setOnline(false);
    } finally { fetchingState = false; }
  }
  function setOnline(value) {
    online = value; $('connection-banner').hidden = value;
    $('network-badge').classList.toggle('offline', !value);
    const badge = $('network-badge'); badge.replaceChildren(el('span','tiny-dot'), document.createTextNode(value ? '局域网已连接' : '正在重连'));
  }
  function switchView(next) {
    view = next;
    document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === `view-${next}`));
    document.querySelectorAll('[data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === next));
    $('view-crumb').textContent = viewLabels[next];
    if (location.hash !== `#${next}`) history.replaceState(null, '', `${location.pathname}${location.search}#${next}`);
    if (next === 'activity') renderActivity();
    if (next === 'settings') { $('device-name').value = deviceName; $('server-name').value = state?.server?.name || boot?.server?.name || ''; $('download-dir').value = state?.downloadDir || boot?.downloadDir || ''; }
  }
  function devicePlatform(device) { const p = String(device.platform || '').toLowerCase(); if (/android/.test(p)) return 'Android'; if (/windows|win32/.test(p)) return 'Windows'; if (/ios|iphone|ipad/.test(p)) return 'iOS'; if (/mac|darwin/.test(p)) return 'macOS'; return device.type === 'host' ? '共享主机' : '浏览器'; }
  function deviceIcon(device) { return /android|iphone|ipad|ios|mobile/i.test(device.platform || '') ? 'phone' : device.type === 'host' ? 'server' : 'pc'; }
  function targetDevice() { return targetId === 'server' ? {id:'server',name:`${state?.server?.name || boot?.server?.name || '主机'} · 收件箱`,type:'host',platform:boot?.server?.platform} : state?.devices?.find(d => d.id === targetId); }
  function renderDeviceCard(device, selectable = true) {
    const isSelf = device.self || device.id === deviceId;
    const node = el('button', `device-card${isSelf ? ' self' : ''}${device.id === targetId ? ' selected' : ''}${device.online === false ? ' offline' : ''}`); node.type = 'button';
    const avatar = el('span', 'device-avatar'); avatar.append(icon(deviceIcon(device)));
    const detail = el('span', 'device-card-detail'); detail.append(el('span', 'device-card-name', device.name || '未命名设备'));
    const meta = el('span', 'device-card-meta');
    if (!isSelf && device.online !== false) meta.append(el('span', 'tiny-dot'));
    const label = isSelf ? `${devicePlatform(device)} · 此设备` : device.id === 'server' ? '当前主机 · 接收文件' : `${devicePlatform(device)} · ${device.online === false ? '离线' : '可直接发送'}`;
    meta.append(document.createTextNode(label)); detail.append(meta); node.append(avatar,detail);
    if (!isSelf && device.type === 'host' && (device.url || device.ip)) { let address=device.ip || device.url;try{if(device.url)address=new URL(device.url).host;}catch{}const location=el('span','device-card-address',address);location.title=`接收设备地址：${device.url || device.ip}`;detail.append(location); }
    if (device.id === targetId) { const check = el('span', 'device-check'); check.append(icon('check')); node.append(check); }
    else if (!isSelf) node.append(icon('chevron', true));
    if (selectable && !isSelf && device.online !== false) node.addEventListener('click', () => selectTarget(device));
    if (isSelf) node.setAttribute('aria-label', `${device.name}，当前设备`);
    return node;
  }
  function renderDevices() {
    const devices = (state?.devices || []).filter(d => d.online !== false || d.self);
    // Choose once when another device first appears. Keep an explicit or prior
    // target even if it leaves, so later files cannot silently go elsewhere.
    if (!targetId) {
      const recipients=devices.filter(d=>!d.self&&d.id!==deviceId&&d.id!=='server'&&d.id!==state?.server?.id&&d.id!==`host:${state?.server?.id}`&&d.online!==false);
      const first=recipients.find(d=>d.type==='host') || recipients[0];
      if(first)targetId=first.id;
    }
    $('device-count').textContent = String(devices.filter(d => !d.self && d.id !== deviceId).length);
    const list = $('device-list'); list.replaceChildren();
    const self = devices.find(d => d.self || d.id === deviceId) || {id:deviceId,name:deviceName,platform:/Android/i.test(navigator.userAgent)?'Android':/Windows/i.test(navigator.userAgent)?'Windows':'browser',self:true,type:'browser',online:true};
    list.append(renderDeviceCard(self));
    for (const device of devices.filter(d => !d.self && d.id !== deviceId)) list.append(renderDeviceCard(device));
    if (devices.filter(d => !d.self && d.id !== deviceId).length === 0) list.append(empty('wifi','等待另一台设备加入','扫描邀请二维码，或在另一台主机打开邻波。'));
    updateTarget();
  }
  function updateTarget() {
    const device = targetDevice();
    const unavailable=targetId && (!device || device.online===false);
    $('target-name').textContent = !targetId ? '选择接收设备' : unavailable ? '所选设备暂时离线' : device.name;
    $('target-tip').textContent = !targetId ? '等待另一台设备加入' : unavailable ? '请重新选择接收设备' : targetId === 'server' ? usesLocalFiles() ? '在本机收件箱发布原文件，不复制' : '保存在当前主机' : device.type === 'host' ? `发送到对方主机${device.ip ? ` · ${device.ip}` : ''}` : '送达对方收件箱';
    $('target-button').title = device?.url || device?.ip || '';
    $('target-button').querySelector('.target-icon').replaceChildren(icon(device ? deviceIcon(device) : 'wifi'));
  }
  async function selectTarget(device) {
    targetId = device.id; closeModal(); renderDevices(); toast(`接下来的文件将发往：${device.name}`);
  }
  function showTargets() {
    openModal('把文件发送到…', body => {
      const list = el('div','target-list');
      list.append(renderDeviceCard({id:'server',name:`${state?.server?.name || '主机'} · 收件箱`,type:'host',online:true}));
      for (const d of (state?.devices || []).filter(d => !d.self && d.id !== deviceId && d.online !== false)) list.append(renderDeviceCard(d));
      body.append(list, el('p','modal-note',`发送到浏览器的文件会进入对方收件箱，由对方点击下载保存。发送到独立主机则直接保存在对方接收目录。${usesLocalFiles() ? '选择当前主机收件箱时，仅发布原文件供下载，不生成副本。' : ''}`));
    });
  }
  function openModal(title, build) {
    closeModal(); $('modal-title').textContent = title; $('modal-body').replaceChildren(); build($('modal-body')); $('modal').showModal();
  }
  function closeModal() {
    if (modalCleanup) { modalCleanup(); modalCleanup = null; }
    modalBusy = false;
    if ($('modal').open) $('modal').close();
  }
  async function copyText(text, message = '连接地址已复制') {
    let copied = false;
    if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(text); copied = true; } catch {} }
    if (!copied) {
      const input = el('textarea'); const focused = document.activeElement;
      input.value = text; input.style.cssText = 'position:fixed;opacity:0;left:0;top:0'; input.setAttribute('aria-hidden','true');
      const parent = $('modal').open ? $('modal-body') : document.body;
      parent.append(input); input.focus(); input.select();
      try { copied = document.execCommand('copy'); } catch {} finally { input.remove(); focused?.focus?.(); }
    }
    toast(copied ? message : '当前浏览器无法复制，请长按或选中地址手动复制。', !copied);
    return copied;
  }
  function fileLinkExpiry(link) {
    if (link.status === 'expired') return '已过期';
    if (link.status === 'missing') return '源文件不可用';
    return link.expiresAt ? `${date(link.expiresAt)} 到期` : '有效至手动撤销';
  }
  function renderFileLinks() {
    if (!boot?.admin) return;
    const links = [...(state?.fileLinks || [])].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    $('file-links-count').textContent = String(links.length);
    $('file-links-details').hidden = links.length === 0;
    const list = $('file-links-list'); list.replaceChildren();
    for (const link of links) {
      const row = el('div','file-link-row'); const detail = el('div','file-detail');
      detail.append(el('span','file-name',link.name));
      const meta = el('div','file-meta'); meta.append(el('span','',bytes(link.size)),el('span','meta-separator'),el('span',`file-link-status ${link.status || 'active'}`,fileLinkExpiry(link)),el('span','meta-separator'),el('span','',`${Number(link.downloads)||0} 次下载`)); detail.append(meta);
      const actions = el('div','file-link-actions');
      const copy = action('copy',`复制 ${link.name} 的下载链接`,() => copyText(link.url,'下载链接已复制，同一局域网打开即可下载'));
      copy.disabled = link.status !== 'active';
      actions.append(copy,action('external',`查看 ${link.name} 的下载链接`,() => showFileLink(link)),action('trash',`撤销 ${link.name} 的下载链接`,() => confirmRevokeFileLink(link),true));
      row.append(fileIcon(link.name),detail,actions); list.append(row);
    }
  }
  function showCreateFileLink() {
    if (!boot?.admin) return;
    openModal('创建单文件下载链接',body => {
      body.append(el('p','','从当前主机选择一个文件。生成的链接可以直接发给同一局域网内的设备，对方打开即可下载。'));
      const native = !!boot.capabilities?.native;
      const form = el('form','file-link-form');
      const pathLabel = el('label','field-label','文件完整路径');
      const input = el('input','text-input'); input.name='filePath'; input.placeholder='例如：D:\\Downloads\\报告.pdf'; input.required = !native; pathLabel.append(input); pathLabel.hidden = native;
      const selected = el('div','file-link-selected'); selected.hidden = true;
      const selectedName = el('strong'); const selectedSize = el('span'); const selectedDetail = el('div'); selectedDetail.append(selectedName,selectedSize); selected.append(icon('file'),selectedDetail);
      const pending = el('p','file-link-picker-note'); pending.hidden = true;
      const errorNode = el('p','modal-inline-error');
      const expiryLabel = el('label','field-label','链接有效期');
      const expiry = el('select','text-input file-link-expiry'); expiry.name='expiresIn';
      for (const [value,label] of [[86400,'24 小时'],[3600,'1 小时'],[604800,'7 天'],[0,'直到我手动撤销']]) { const option = el('option','',label); option.value=String(value); expiry.append(option); }
      expiryLabel.append(expiry);
      const submit = button('生成下载链接','button primary'); submit.type='submit'; submit.disabled = native;
      const applyPick = file => {
        if (!file?.path) return;
        input.value=file.path; selectedName.textContent=file.name || file.path.split(/[\\/]/).pop(); selectedSize.textContent=bytes(file.size); selected.hidden=false; pending.hidden=true; errorNode.textContent=''; submit.disabled=false;
        if (pendingFilePick) pendingFilePick.selectionId=file.selectionId || pendingFilePick.selectionId;
      };
      const picker = button(native?'选择本机文件':'从本机选择文件','button secondary file-link-picker',async() => {
        picker.disabled=true; errorNode.textContent=''; pending.hidden=true;
        pendingFilePick={selectionId:state?.pickedFile?.selectionId || '',apply:applyPick};
        try {
          const picked=await api('/api/pick-file',{method:'POST',body:{}});
          if (picked.pending) { pending.textContent='请在系统选择器中选择文件，返回后点击“生成下载链接”。'; pending.hidden=false; refreshState(); }
          else if (picked.path) applyPick(picked);
        } catch(error) { errorNode.textContent=error.message; }
        finally { picker.disabled=false; }
      },'file');
      picker.hidden = !native && boot.capabilities?.folderPicker === false;
      const note = el('p','modal-note','主机需要保持运行。持有链接的设备可以下载这个文件；你可以随时撤销链接，原文件会保留。');
      const actions = el('div','modal-actions'); actions.append(button('取消','button secondary',closeModal),submit);
      form.append(pathLabel,picker,selected,pending,expiryLabel,note,errorNode,actions); body.append(form);
      modalCleanup = () => { pendingFilePick=null; };
      input.addEventListener('input',()=>{selected.hidden=true;errorNode.textContent='';});
      form.addEventListener('submit',async event => {
        event.preventDefault(); const source=input.value.trim();
        if (!source) { errorNode.textContent='请先选择一个文件'; return; }
        submit.disabled=true; picker.disabled=true; errorNode.textContent='';
        try {
          const link=await api('/api/file-links',{method:'POST',body:{path:source,expiresIn:Number(expiry.value)}});
          await refreshState(); $('file-links-details').open=true; showFileLink(link,true);
        } catch(error) { errorNode.textContent=error.message; submit.disabled=false; picker.disabled=false; }
      });
    });
  }
  function showFileLink(link,created = false) {
    openModal(created?'下载链接已生成':'单文件下载链接',body => {
      const summary=el('div','file-link-result-summary'); summary.append(fileIcon(link.name),el('strong','',link.name)); body.append(summary);
      body.append(el('p','file-link-result-meta',`${bytes(link.size)} · ${fileLinkExpiry(link)}`));
      const label=el('label','field-label','局域网下载地址');
      const address=el('input','text-input file-link-address'); address.type='text'; address.readOnly=true; address.value=link.url || ''; address.addEventListener('click',()=>address.select()); label.append(address); body.append(label);
      const copy=button('复制下载链接','button primary full-width',()=>copyText(link.url,'下载链接已复制，同一局域网打开即可下载'),'copy'); copy.disabled=link.status!=='active'; body.append(copy);
      const detail=el('div','file-link-access-note'); detail.append(icon('globe'),el('span','','同一局域网内打开链接即可直接下载。主机保持运行，链接才可使用。')); body.append(detail);
      if(link.status==='active'){const download=el('a','text-button file-link-preview','打开下载链接'); download.href=link.url; download.target='_blank'; download.rel='noopener'; download.append(icon('external',true)); body.append(download);}
      const actions=el('div','modal-actions'); actions.append(button('完成','button secondary',closeModal)); body.append(actions);
    });
  }
  function confirmRevokeFileLink(link) {
    openModal('撤销下载链接',body => {
      body.append(el('p','',`撤销「${link.name}」的链接后，对方将无法再通过该地址下载。原文件不会被删除。`));
      const actions=el('div','modal-actions'); const revoke=button('撤销链接','button danger',async()=>{
        revoke.disabled=true;
        try { await api(`/api/file-links/${encodeURIComponent(link.id)}`,{method:'DELETE'}); closeModal(); await refreshState(); toast('下载链接已撤销，原文件已保留'); }
        catch(error) { revoke.disabled=false; toast(error.message,true); }
      }); actions.append(button('保留链接','button secondary',closeModal),revoke); body.append(actions);
    });
  }
  function showConnect() {
    openModal('连接一台新设备', body => {
      body.append(el('p','','同一个 Wi-Fi 下，电脑与安卓主机会自动相遇。浏览器扫描二维码或打开下面的地址，即可连接。'));
      const image=el('img','connect-qr'); image.alt='扫描地址直接连接'; image.src=url('/api/qr'); image.addEventListener('error',()=> { image.replaceWith(el('p','modal-note','二维码暂不可用，打开下方地址即可连接。')); });
      body.append(image);
      const addresses=state?.urls || boot.urls || []; const list=el('div','address-list');
      for (const address of addresses.length?addresses:[location.origin]) { const row=el('div','address-row'); const text=el('span','',address); text.title=address; row.append(text,action('copy','复制地址',()=>copyText(address))); list.append(row); }
      body.append(list);
      const form=el('form','manual-connect-form');const label=el('label','field-label','手动连接另一台主机');const address=el('input','text-input');address.type='text';address.inputMode='url';address.placeholder='http://192.168.1.8:53317';address.required=true;address.setAttribute('aria-label','另一台主机的连接地址');label.append(address);const errorNode=el('p','modal-inline-error');const submit=button('连接这台设备','button primary');submit.type='submit';form.append(label,errorNode,submit);body.append(form);
      form.addEventListener('submit',async event=>{event.preventDefault();submit.disabled=true;errorNode.textContent='';try{const value=address.value.trim();const data=await api('/api/peers/connect',{method:'POST',body:{url:/^https?:\/\//i.test(value)?value:`http://${value}`}});await refreshState();const device=data.device || data.peer || data;if(device.id){targetId=device.id;renderDevices();}closeModal();toast(`已连接 ${device.name || '另一台主机'}，现在可以直接发送文件`);}catch(error){errorNode.textContent=error.message;}finally{submit.disabled=false;}});
      const detail=el('div','connect-detail'); detail.append(icon('wifi'),el('span','','自动发现不到时，可输入对方显示的连接地址。设备需要处于同一个路由器或热点。')); body.append(detail);
    });
  }
  function updateInboxNotice() {
    const count=unreadInbox.size;
    $('inbox-nav-count').textContent=count?String(count):'';
    $('inbox-count').classList.toggle('has-new',count>0);
    if(!count)$('inbox-notice').hidden=true;
  }
  function revealInbox() {
    if(view!=='transfer')switchView('transfer');
    const section=$('inbox-section');
    section.classList.add('inbox-attention');
    requestAnimationFrame(()=>section.scrollIntoView({behavior:'smooth',block:'start'}));
  }
  function notifyInbox(items) {
    for(const item of items)unreadInbox.add(item.id);
    if(!items.length)return;
    $('inbox-notice-title').textContent=items.length===1?`收到文件：${items[0].name}`:`收到 ${items.length} 个新文件`;
    const saved=state?.downloadDir || boot?.downloadDir;
    $('inbox-notice-detail').textContent=boot?.admin&&items.some(item=>item.saving)?'文件已接收，可以立即查看。正在保存到系统下载列表。':boot?.admin?`已保存到${saved?` ${saved}`:'本机接收目录'}，可以立即查看。`:'文件已送达收件箱，点击「保存到本机」即可下载。';
    $('inbox-notice').hidden=false;
    updateInboxNotice();revealInbox();toast(items.length===1?`收到新文件：${items[0].name}`:`收到 ${items.length} 个新文件，请查看收件箱`);
  }
  function markInboxRead() {
    unreadInbox.clear();updateInboxNotice();$('inbox-section').classList.remove('inbox-attention');
    $('inbox-list').querySelectorAll('.is-new').forEach(row=>row.classList.remove('is-new'));
    $('inbox-list').querySelectorAll('.inbox-new-tag').forEach(tag=>tag.remove());
  }
  async function openInboxFolder() {
    const control=$('open-inbox');control.disabled=true;
    try {
      if(boot?.capabilities?.native && window.Android?.openDownloads){window.Android.openDownloads();return;}
      await api('/api/open-inbox',{method:'POST',body:{}});
    } catch(error){toast(`无法打开接收目录：${error.message}`,true);}finally{control.disabled=false;}
  }
  function revealReceiving() {
    if (view !== 'transfer') switchView('transfer');
    const section = $('receive-section');
    section.classList.add('inbox-attention');
    requestAnimationFrame(() => { if (!section.hidden) section.scrollIntoView({behavior:'smooth', block:'start'}); });
  }
  function renderReceiving() {
    const incoming = transferRecords().filter(t => t.direction === 'incoming' && (['uploading','sending'].includes(t.status) || t.phase === 'saving')).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    const section = $('receive-section'); section.hidden = incoming.length === 0;
    $('receive-count').textContent = String(incoming.length);
    const list = $('receive-list'); list.replaceChildren();
    let fresh = null;
    for (const transfer of incoming) {
      if (!seenIncoming.has(transfer.id) && hasInitialTransfers) fresh = transfer;
      seenIncoming.add(transfer.id);
      const offset = boundedOffset(transfer.received, transfer.size), now = Date.now();
      let sample = receiveSamples.get(transfer.id);
      if (!sample) sample = {offset, at:now, speed:0};
      else if (offset > sample.offset) sample = {offset, at:now, speed:(offset-sample.offset)/Math.max(.05,(now-sample.at)/1000)};
      else if (now - sample.at > 8000) sample.speed = 0;
      receiveSamples.set(transfer.id, sample);
      const row = el('div','file-row receive-row'); row.dataset.transfer = transfer.id;
      const detail = el('div','file-detail'); detail.append(el('span','file-name',transfer.name));
      const meta = el('div','file-meta'); meta.append(el('span','',`来自 ${findName(transfer.from)}`),el('span','meta-separator'),el('span','',bytes(transfer.size))); detail.append(meta);
      appendProgress(detail, progressInfo(transfer, transfer.phase === 'saving' ? 0 : sample.speed), true);
      row.append(fileIcon(transfer.name), detail, statusNode(transfer.status, transfer.phase === 'saving' ? '正在保存' : '正在接收')); list.append(row);
    }
    hasInitialTransfers = true;
    if (fresh) { revealReceiving(); toast(`开始接收：${fresh.name}`); }
  }
  function patchNativeTransfer(transfer) {
    if (!state || !transfer?.id) return;
    if (!state.transfers) state.transfers = [];
    const index = state.transfers.findIndex(t => t.id === transfer.id);
    if (index >= 0) state.transfers[index] = {...state.transfers[index], ...transfer};
    else state.transfers.unshift(transfer);
  }
  function onNativeTransfer(event) {
    const transfer = event.detail?.transfer || event.detail;
    if (!transfer?.id) { refreshState(); return; }
    if (!state) { pendingTransferEvents.push(transfer); refreshState(); return; }
    patchNativeTransfer(transfer);
    syncCompletedJobs(); renderReceiving(); renderActivity();
    refreshState();
  }
  function renderInbox() {
    const inbox = [...(state?.inbox || [])].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); $('inbox-count').textContent = String(inbox.length);
    const fresh=inbox.filter(item=>!seenInbox.has(item.id));
    const nativeItem=pendingInboxEvent?.id?inbox.find(item=>item.id===pendingInboxEvent.id):null;
    if(nativeItem&&!fresh.some(item=>item.id===nativeItem.id)&&!unreadInbox.has(nativeItem.id))fresh.unshift(nativeItem);
    for(const id of unreadInbox)if(!inbox.some(item=>item.id===id))unreadInbox.delete(id);
    if(hasInitialInbox||pendingInboxEvent){for(const item of fresh)unreadInbox.add(item.id);}
    const dir=state?.downloadDir || boot?.downloadDir;
    $('inbox-location').textContent=boot?.admin?`接收位置：${dir || '本机接收目录'}`:`当前收件箱：${state?.server?.name || boot?.server?.name || '共享主机'} · 下载后保存到你的设备`;
    $('open-inbox').hidden=!boot?.admin;
    $('inbox-save-help').textContent=boot?.admin&&boot?.capabilities?.native?(inbox.some(item=>item.saving)?'收到的文件可以立即打开，系统下载副本正在保存。':'文件已保存到手机，在系统通知或下载列表中可直接打开。'):boot?.admin?'文件已自动保存。点击「打开接收目录」即可在本机查看。':'文件已保存在当前主机，点击「保存到本机」下载到此设备。';
    const list=$('inbox-list'); list.replaceChildren();
    if (!inbox.length) list.append(empty('download','收件箱空空的，连接已经就绪','另一台设备发送文件后，就会出现在这里。'));
    for (const item of inbox) {
      const isNew=unreadInbox.has(item.id);const row=el('div',`file-row${isNew?' is-new':''}`);row.dataset.inbox=item.id; const detail=el('div','file-detail'); const title=el('span','inbox-file-title');title.append(el('span','file-name',item.name));if(isNew)title.append(el('span','inbox-new-tag','新收到'));detail.append(title);
      const meta=el('div','file-meta'); meta.append(el('span','',bytes(item.size)),el('span','meta-separator'),el('span','',`来自 ${findName(item.from)}`),el('span','meta-separator'),el('span','',date(item.createdAt))); detail.append(meta);
      if(item.savedPath && boot?.admin){const saved=el('span','inbox-saved-path',`已保存：${item.savedPath}`);saved.title=item.savedPath;detail.append(saved);}
      if(item.saving)detail.append(el('span','inbox-saved-path','已收到 · 正在保存到系统下载'));
      else if(item.saveError)detail.append(el('span','transfer-error',`系统下载副本保存失败：${item.saveError}。仍可在这里打开文件。`));
      const actions=el('div','file-actions'); const download=el('a','button secondary small'); download.append(icon('download',true),document.createTextNode(boot?.admin&&boot?.capabilities?.native?'打开 / 下载':'保存到本机')); download.href=url(`/api/inbox/${encodeURIComponent(item.id)}/download`); download.download=item.name; download.title='保存到当前设备';download.addEventListener('click',()=>{unreadInbox.delete(item.id);row.classList.remove('is-new');title.querySelector('.inbox-new-tag')?.remove();updateInboxNotice();});
      actions.append(download,action('trash','删除收到的文件',()=>confirmRemoveInbox(item),true)); row.append(fileIcon(item.name),detail,actions); list.append(row);
      seenInbox.add(item.id);
    }
    if((hasInitialInbox||pendingInboxEvent)&&fresh.length)notifyInbox(fresh);
    else updateInboxNotice();
    if(nativeItem || pendingInboxEvent && !pendingInboxEvent.id)pendingInboxEvent=null;
    hasInitialInbox = true;
  }
  function findName(id) { if (!id) return '局域网设备'; if (typeof id === 'object') return id.name || '局域网设备'; if (id === deviceId) return '我'; if(id==='server' || id===state?.server?.id || id===`host:${state?.server?.id}`) return state?.server?.name || '主机'; return state?.devices?.find(d=>d.id===id)?.name || (/^(host:)?[a-f0-9-]{20,}$/i.test(String(id)) ? '局域网设备' : String(id)); }
  function confirmRemoveInbox(item) { openModal('删除收到的文件', body => { body.append(el('p','',`将从主机接收目录中删除「${item.name}」。已经下载到其他设备的副本不受影响。`)); const actions=el('div','modal-actions'); actions.append(button('取消','button secondary',closeModal),button('删除文件','button danger',async()=>{try{await api(`/api/inbox/${encodeURIComponent(item.id)}`,{method:'DELETE'}); closeModal(); await refreshState(); toast('文件已删除');}catch(error){toast(error.message,true);}})); body.append(actions); }); }
  async function gatherEntries(entry, prefix='') {
    if(entry.isFile) return new Promise((resolve,reject)=>entry.file(file=>resolve([{file,path:prefix+file.name}]),reject));
    if(entry.isDirectory) { const reader=entry.createReader(); const all=[]; let batch; do { batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject)); all.push(...batch); }while(batch.length); const result=[]; for(const child of all) result.push(...await gatherEntries(child,`${prefix}${entry.name}/`)); return result; }
    return [];
  }
  function configureFileSelection() {
    const local=usesLocalFiles();
    $('paste-local-paths').hidden=!local;
    $('drop-title').textContent=local?'直接发送原文件':'把文件拖到这里';
    $('drop-description').textContent=local?'在本机文件窗口选择文件或整个文件夹':'也可以从设备中选择文件或整个文件夹';
    $('drop-zone').setAttribute('aria-label',local?'选择本机原文件直接发送':'点击或拖放文件到这里发送');
    $('drop-footer').replaceChildren(icon('lock',true),document.createTextNode(local?'直接读取原文件，不生成临时副本':'文件留在你的网络里 · 多文件 · 大文件'));
    $('send-help').textContent=local?'直接读取原文件，不生成临时副本。进度只显示实际发送到对方的字节；暂停后可继续，取消只移除任务，原文件保留。':'先上传到当前主机，再发送到接收设备。暂停后可继续；已上传完的文件，重新打开页面后可直接继续发送。上传未完成时，重新选择同一文件即可接续。';
  }
  function readyTarget() {
    const device=targetDevice();
    if(!device || device.online===false){toast(targetId?'所选设备已离线，请重新选择接收设备。':'请先选择接收设备',true);return null;}
    return {id:device.id,name:device.name};
  }
  function setLocalPickerBusy(busy) {
    localPickerBusy=busy;
    $('choose-files').disabled=busy;$('choose-folder').disabled=busy;$('paste-local-paths').disabled=busy;
  }
  async function queueLocalPaths(paths, recipient) {
    const selected=[...new Set(paths.filter(path=>typeof path==='string' && path.trim()).map(path=>path.trim()))];
    if(!selected.length)return {added:0,skipped:[]};
    const result=await api('/api/local-transfers',{method:'POST',body:{paths:selected,targetId:recipient.id}});
    let added=0;
    for(const transfer of result.transfers || []){
      if(jobs.some(job=>job.id===transfer.id))continue;
      jobs.push(localJob(transfer,recipient));added++;
    }
    renderJobs();
    if(added)toast(`已加入 ${added} 个原文件，直接发送至 ${recipient.name}`);
    const skipped=result.skipped || [];
    if(skipped.length)toast(`有 ${skipped.length} 个路径未发送：${skipped[0].error || '无法读取原文件'}`,true);
    await refreshState();
    return {added,skipped};
  }
  async function chooseSendSource(folder=false) {
    if(!usesLocalFiles()){ $(folder?'folder-input':'files-input').click();return; }
    if(localPickerBusy)return;
    const recipient=readyTarget();if(!recipient)return;
    setLocalPickerBusy(true);
    try{
      const picked=await api(folder?'/api/pick-folder':'/api/pick-send-files',{method:'POST',body:{}});
      const paths=folder?(picked.path?[picked.path]:[]):(picked.paths || []);
      if(paths.length)await queueLocalPaths(paths,recipient);
    }catch(error){toast(error.message,true);}
    finally{setLocalPickerBusy(false);}
  }
  function showLocalPaths() {
    if(!usesLocalFiles())return;
    const recipient=readyTarget();if(!recipient)return;
    openModal('粘贴原文件路径',body=>{
      body.append(el('p','',`将原文件直接发送至 ${recipient.name}。每行一个文件或文件夹的完整路径，支持 Windows“复制文件地址”带引号的路径；文件夹会保留目录结构。`));
      const form=el('form','local-path-form'),label=el('label','field-label','文件或文件夹的完整路径');
      const input=el('textarea','text-input local-path-input');input.id='local-path-input';input.rows=5;input.required=true;input.placeholder='D:\\Downloads\\报告.pdf\n"D:\\Videos\\电影文件夹"';label.append(input);
      const errors=el('p','modal-inline-error');
      const submit=button('直接发送','button primary');submit.type='submit';
      const cancel=button('取消','button secondary',closeModal),actions=el('div','modal-actions');actions.append(cancel,submit);
      form.append(label,el('p','modal-note','直接读取原文件，不生成临时副本。选择当前主机时仅发布到本机收件箱，原文件保留。'),errors,actions);body.append(form);
      form.addEventListener('submit',async event=>{
        event.preventDefault();
        const paths=input.value.split(/\r?\n/).map(path=>path.trim().replace(/^"(.*)"$/,'$1')).filter(Boolean);
        if(!paths.length){errors.textContent='请粘贴至少一个完整路径';return;}
        errors.textContent='';submit.disabled=true;cancel.disabled=true;input.disabled=true;
        try{const result=await queueLocalPaths(paths,recipient);if(result.added)closeModal();else errors.textContent=result.skipped.map(item=>`${item.path}：${item.error}`).join('\n') || '没有可发送的文件';}
        catch(error){errors.textContent=error.message;}
        finally{submit.disabled=false;cancel.disabled=false;input.disabled=false;}
      });
      requestAnimationFrame(()=>input.focus());
    });
  }
  function localJob(transfer, recipient) {
    const size=Number(transfer.size)||0;
    return {key:uuid(),id:transfer.id,name:transfer.name,size,path:transfer.relativePath || transfer.name,targetId:transfer.targetId || recipient?.id || transfer.to,targetName:recipient?.name || findName(transfer.targetId || transfer.to),status:transfer.status || 'queued',phase:transfer.phase || 'queued',localSource:true,sourceBuffered:false,offset:size,displayOffset:size,deliveredBytes:boundedOffset(transfer.deliveredBytes,size),speed:0,error:transfer.error || '',createdAt:transfer.createdAt || new Date().toISOString(),updatedAt:Date.now(),xhr:null};
  }
  async function acceptFiles(files) {
    if(usesLocalFiles()){toast('浏览器不给原路径，请在文件窗口选择，直接发送原文件');await chooseSendSource();return;}
    const device=readyTarget();if(!device)return;
    let added=0;
    for(const item of files) {
      const file=item.file || item; const path=item.path || file.webkitRelativePath || file.name;
      if(jobs.some(j=>j.name===file.name&&j.size===file.size&&j.lastModified===file.lastModified&&j.path===path&&j.targetId===targetId&&!['complete','cancelled','error'].includes(j.status)))continue;
      jobs.push({key:uuid(),file,name:file.name,size:file.size,lastModified:file.lastModified,path,targetId,targetName:device.name,status:'queued',phase:'uploading',sourceBuffered:false,offset:0,displayOffset:0,deliveredBytes:0,id:null,chunkSize:4*1024*1024,speed:0,error:'',startedAt:0,updatedAt:Date.now(),createdAt:new Date().toISOString(),xhr:null});added++;
    }
    if(!added) return toast('这些文件已在发送队列中');
    renderJobs(); toast(`已加入 ${added} 个文件，发送至 ${device.name}`); runQueue();
  }
  async function runQueue() {
    if(queueRunning) return;
    queueRunning=true;
    try { let job; while((job=jobs.find(j=>j.status==='queued' && !j.localSource))) await uploadJob(job); }
    finally { queueRunning=false; renderJobs(); refreshState(); }
  }
  function chunkRequest(job, chunk) {
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest(); job.xhr=xhr;
      xhr.open('PUT',`/api/uploads/${encodeURIComponent(job.id)}?offset=${job.offset}`);xhr.setRequestHeader('Authorization',`Bearer ${token}`);xhr.setRequestHeader('Content-Type','application/octet-stream');xhr.timeout=120000;
      const chunkStart=performance.now();
      xhr.upload.onprogress=event=>{if(event.lengthComputable){job.displayOffset=job.offset+event.loaded;job.speed=event.loaded/Math.max(.05,(performance.now()-chunkStart)/1000);scheduleJobRender();}};
      xhr.onload=()=>{job.xhr=null;let data;try{data=JSON.parse(xhr.responseText);}catch{data={error:`发送失败 (${xhr.status})`};}if(xhr.status>=200&&xhr.status<300)resolve(data);else{const error=new Error(data.error||'发送失败');error.status=xhr.status;error.data=data;reject(error);}};
      xhr.onerror=()=>{job.xhr=null;reject(new Error('网络连接中断'));};xhr.ontimeout=()=>{job.xhr=null;reject(new Error('网络响应超时'));};xhr.onabort=()=>{job.xhr=null;const error=new Error('已暂停');error.name='AbortError';reject(error);};xhr.send(chunk);
    });
  }
  async function uploadJob(job) {
    if(job.localSource)return;
    job.status=job.sourceBuffered?'sending':'uploading';job.phase=job.sourceBuffered?'connecting':'uploading';job.error='';job.startedAt=Date.now();renderJobs();
    try {
      if(job.sourceBuffered){await sendBufferedJob(job);return;}
      let session=job.id?await api(`/api/uploads/${encodeURIComponent(job.id)}`).catch(error=>{if(error.status===404)return null;throw error;}):null;
      if(!session)session=await api('/api/uploads',{method:'POST',body:{name:job.name,size:job.size,relativePath:job.path,targetId:job.targetId,lastModified:job.lastModified}});
      job.id=session.id;job.offset=Number(session.offset)||0;job.displayOffset=job.offset;job.chunkSize=Math.min(Number(session.chunkSize)||4*1024*1024,4*1024*1024);
      if(job.status==='cancelled'){await api(`/api/uploads/${encodeURIComponent(job.id)}`,{method:'DELETE'}).catch(()=>{});return;}
      if(job.status!=='uploading')return;
      while(job.offset<job.size && job.status==='uploading') {
        let attempts=0;
        while(true) {
          try {const chunk=job.file.slice(job.offset,Math.min(job.offset+job.chunkSize,job.size));const result=await chunkRequest(job,chunk);job.offset=Number(result.offset);job.displayOffset=job.offset;break;}
          catch(error) {
            if(job.status!=='uploading' || error.name==='AbortError')return;
            if(error.status===401){await bootstrapSession();if(++attempts>3)throw error;continue;}
            if(error.status===409 && Number.isFinite(error.data?.offset)){job.offset=Number(error.data.offset);job.displayOffset=job.offset;break;}
            if(error.status && error.status<500)throw error;
            if(++attempts>3)throw error;
            job.error=`连接重试 ${attempts}/3`;scheduleJobRender();await new Promise(resolve=>setTimeout(resolve,1000*attempts));
            const current=await api(`/api/uploads/${encodeURIComponent(job.id)}`).catch(()=>null);if(current){job.offset=Number(current.offset)||0;job.displayOffset=job.offset;}
          }
        }
        job.error='';scheduleJobRender();
      }
      if(job.status!=='uploading')return;
      job.sourceBuffered=true;job.displayOffset=job.size;job.speed=0;
      await sendBufferedJob(job);
    }catch(error){if(job.stopRequested||job.status==='paused'||job.status==='cancelled')return;job.status='error';job.error=error.message;job.speed=0;toast(`${job.name}：${error.message}`,true);}
    finally{renderJobs();refreshState();}
  }
  async function sendBufferedJob(job) {
    job.status='sending';job.phase='connecting';job.error='';job.speed=0;job.deliverySample={offset:job.deliveredBytes || 0,at:Date.now()};renderJobs();
    const result=await api(`/api/uploads/${encodeURIComponent(job.id)}/complete`,{method:'POST',body:{}});
    if(job.stopRequested||job.status==='paused'||job.status==='cancelled')return;
    if(!['sending','complete'].includes(result.status))throw new Error(result.error || '主机尚未确认文件送达，请重试');
    const current=transferRecords().find(t=>t.id===job.id);
    if(current?.status==='complete')result.status='complete';
    const previousStatus=job.status;job.status=result.status;job.phase=result.phase || (result.status==='complete'?'complete':job.phase);
    if(result.deliveredBytes!==undefined)job.deliveredBytes=boundedOffset(result.deliveredBytes,job.size);
    if(result.status==='complete')job.deliveredBytes=job.size;
    job.updatedAt=Date.now();
    if(job.status==='complete'&&previousStatus!=='complete')toast(`已送达 ${job.targetName}：${job.name}`);
  }
  function jobTransfer(job) { return {size:job.size,received:job.displayOffset,deliveredBytes:job.deliveredBytes,status:job.status,phase:job.phase,sourceBuffered:job.sourceBuffered,localSource:job.localSource,direction:'outgoing',to:job.targetName}; }
  function scheduleJobRender() {
    if(renderJobTimer)return;
    renderJobTimer=setTimeout(()=>{
      renderJobTimer=null;
      for(const job of jobs){
        if(job.status!=='uploading')continue;
        const row=$('upload-list').querySelector(`[data-job="${job.key}"]`);if(!row)continue;
        const info=progressInfo(jobTransfer(job),job.speed),track=row.querySelector('.progress-track'),bar=row.querySelector('.progress-bar'),extra=row.querySelector('.progress-extra');
        if(bar)bar.style.width=`${info.percent}%`;
        if(track){track.setAttribute('aria-valuenow',String(Math.round(info.percent)));track.setAttribute('aria-label',info.label);}
        if(extra){extra.firstChild.textContent=info.label;extra.lastChild.textContent=info.detail;}
      }
    },120);
  }
  async function pauseJob(job) {
    if(job.pausing)return;
    if(job.status==='sending' || job.localSource && job.status==='queued'){
      job.pausing=true;job.stopRequested=true;renderJobs();
      try{const result=await api(`/api/uploads/${encodeURIComponent(job.id)}/pause`,{method:'POST',body:{}});job.status=result.status==='paused'?'paused':'error';job.phase='error';job.error=result.error || '已暂停，点击继续发送';job.speed=0;}
      catch(error){job.stopRequested=false;toast(error.message,true);}
      finally{job.pausing=false;renderJobs();refreshState();}
      return;
    }
    job.status='paused';job.speed=0;job.xhr?.abort();job.displayOffset=job.offset;renderJobs();
  }
  async function resumeJob(job) {
    if(job.resuming)return;
    job.stopRequested=false;job.error='';
    if(!job.localSource){job.status='queued';renderJobs();runQueue();return;}
    job.resuming=true;renderJobs();
    try{
      const result=await api(`/api/uploads/${encodeURIComponent(job.id)}/complete`,{method:'POST',body:{}});
      if(!['queued','sending','complete'].includes(result.status))throw new Error(result.error || '无法继续发送，请重新选择原文件');
      const current=transferRecords().find(t=>t.id===job.id);
      job.status=current?.status==='complete'?'complete':result.status;job.phase=result.phase || job.status;
      if(result.deliveredBytes!==undefined)job.deliveredBytes=boundedOffset(result.deliveredBytes,job.size);
      if(job.status==='complete')job.deliveredBytes=job.size;
    }catch(error){job.status='error';job.error=error.message;toast(`${job.name}：${error.message}`,true);}
    finally{job.resuming=false;renderJobs();refreshState();}
  }
  async function cancelJob(job) {job.status='cancelled';job.xhr?.abort();if(job.id)await api(`/api/uploads/${encodeURIComponent(job.id)}`,{method:'DELETE'}).catch(error=>toast(error.message,true));const index=jobs.indexOf(job);if(index>=0)jobs.splice(index,1);renderJobs();refreshState();}
  function syncCompletedJobs() {
    const records=transferRecords();
    for(const transfer of records){
      if(transfer.direction!=='outgoing'||jobs.some(j=>j.id===transfer.id))continue;
      if(transfer.localSource){if(['queued','sending','error','paused'].includes(transfer.status))jobs.push(localJob(transfer));continue;}
      if(!['sending','error','paused'].includes(transfer.status)||(Number(transfer.received)||0)<(Number(transfer.size)||0))continue;
      jobs.push({key:uuid(),id:transfer.id,name:transfer.name,size:Number(transfer.size)||0,path:transfer.relativePath || transfer.name,targetId:transfer.targetId || transfer.to,targetName:findName(transfer.to),status:transfer.status,phase:transfer.phase || (transfer.status==='sending'?'connecting':'error'),sourceBuffered:true,offset:Number(transfer.received)||0,displayOffset:Number(transfer.received)||0,deliveredBytes:boundedOffset(transfer.deliveredBytes,transfer.size),speed:0,error:transfer.error || '',createdAt:transfer.createdAt,updatedAt:Date.now(),xhr:null});
    }
    for(const job of jobs.filter(j=>j.localSource||j.sourceBuffered||j.status==='sending')) {
      const transfer=records.find(t=>t.id===job.id);
      if(!transfer||job.pausing||job.resuming||job.stopRequested||job.status==='cancelled'||job.status==='queued'&&!job.localSource||!['queued','sending','complete','error','paused'].includes(transfer.status))continue;
      const previousStatus=job.status,now=Date.now(),offset=transfer.status==='complete'?job.size:boundedOffset(transfer.deliveredBytes ?? job.deliveredBytes,job.size);
      if(!job.deliverySample)job.deliverySample={offset,at:now};
      else if(offset>job.deliverySample.offset){job.speed=(offset-job.deliverySample.offset)/Math.max(.05,(now-job.deliverySample.at)/1000);job.deliverySample={offset,at:now};}
      else if(now-job.deliverySample.at>8000)job.speed=0;
      job.deliveredBytes=offset;job.status=transfer.status;job.phase=transfer.phase || (transfer.status==='complete'?'complete':job.phase);job.error=transfer.error || '';
      if(transfer.status!=='sending')job.speed=0;
      if(['queued','sending'].includes(previousStatus)&&transfer.status==='complete')toast(`${job.localSource&&job.targetId==='server'?'已发布到':'已送达'} ${job.targetName}：${job.name}`);
      else if(['queued','sending'].includes(previousStatus)&&transfer.status==='error')toast(`${job.name} 未送达：${job.error || '对方接收失败'}`,true);
    }
    renderJobs();
  }
  function renderJobs() {
    $('upload-section').hidden=jobs.length===0;$('queue-count').textContent=String(jobs.length);const list=$('upload-list');list.replaceChildren();
    for(const job of jobs) {
      const row=el('div','file-row');row.dataset.job=job.key;const detail=el('div','file-detail');detail.append(el('span','file-name',job.name));
      const publish=job.localSource&&job.targetId==='server';
      const meta=el('div','file-meta');meta.append(el('span','',bytes(job.size)),el('span','meta-separator'),el('span','',`${publish?(job.status==='complete'?'已发布到':'发布到'):job.status==='complete'?'对方已接收':'发往'} ${job.targetName}`));detail.append(meta);
      if(!['complete','cancelled'].includes(job.status))appendProgress(detail,progressInfo(jobTransfer(job),job.speed));
      if(job.error)detail.append(el('p','transfer-error',job.error));
      const actions=el('div','file-actions');actions.append(statusNode(job.status,job.pausing?'正在暂停':publish&&job.status==='complete'?'已发布':job.status==='error'&&/暂停/.test(job.error)?'已暂停':undefined));
      if(['uploading','sending'].includes(job.status)||job.localSource&&job.status==='queued'){const pause=action('pause','暂停发送',()=>pauseJob(job));pause.disabled=job.pausing || job.resuming;actions.append(pause);}
      if(['paused','error'].includes(job.status)){const resume=button(job.resuming?'正在继续':'继续发送','button secondary small',()=>resumeJob(job),'play');resume.disabled=job.resuming;actions.append(resume);}
      if(job.status!=='complete'&&(job.localSource||job.status!=='sending')){const cancel=action('x','取消发送',()=>cancelJob(job));cancel.disabled=job.pausing || job.resuming;actions.append(cancel);}row.append(fileIcon(job.name),detail,actions);list.append(row);
    }
    if(view==='activity')renderActivity();
  }
  function renderActivity() {
    const combined=transferRecords();
    for(const job of jobs){const index=combined.findIndex(t=>t.id===job.id);const data={id:job.id || job.key,name:job.name,...jobTransfer(job),from:index>=0?combined[index].from:deviceId,to:job.targetName,createdAt:job.createdAt,error:job.error};if(index>=0)combined[index]={...combined[index],...data};else combined.push(data);}
    combined.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    $('activity-count').textContent=combined.length?String(combined.length):'';$('summary-total').textContent=String(combined.length);$('summary-complete').textContent=String(combined.filter(t=>t.status==='complete').length);$('summary-active').textContent=String(combined.filter(t=>['uploading','sending','queued'].includes(t.status)).length);
    const list=$('activity-list');list.replaceChildren();const selected=combined.filter(t=>activityFilter==='all'||activityFilter==='active'&&['uploading','sending','queued'].includes(t.status)||activityFilter==='complete'&&t.status==='complete'||activityFilter==='error'&&['error','paused','cancelled'].includes(t.status));
    if(!selected.length)list.append(empty('clock','这里，等着文件的第一段旅程','发送或接收文件后，传输记录会自动出现在这里。',true));
    for(const t of selected){
      const row=el('div','file-row');const detail=el('div','file-detail');detail.append(el('span','file-name',t.name));
      const meta=el('div','file-meta');meta.append(el('span',`activity-direction ${t.direction==='incoming'?'incoming':''}`,t.direction==='incoming'?'接收':'发送'),el('span','',bytes(t.size)),el('span','meta-separator'),el('span','',`${findName(t.from)} → ${findName(t.to)}`));detail.append(meta);
      const job=jobs.find(j=>j.id===t.id||j.key===t.id);
      if(['queued','uploading','sending','paused','error'].includes(t.status)||t.phase==='saving')appendProgress(detail,progressInfo({...t,to:findName(t.to)},job?.speed || receiveSamples.get(t.id)?.speed || 0),t.direction==='incoming');
      if(t.error)detail.append(el('p','transfer-error',t.error));
      const actions=el('div','file-actions');actions.append(statusNode(t.status,t.direction==='incoming'&&t.status==='uploading'?'正在接收':t.phase==='saving'?'正在保存':t.status==='error'&&/暂停/.test(t.error || '')?'已暂停':undefined));
      if(t.direction==='outgoing'&&job&&['paused','error'].includes(t.status)){const resume=button(job.resuming?'正在继续':'继续发送','button secondary small',()=>resumeJob(job),'play');resume.disabled=job.resuming;actions.append(resume);}
      if(t.direction==='outgoing'&&job&&(t.status==='sending'||job.localSource&&t.status==='queued')){const pause=action('pause','暂停发送',()=>pauseJob(job));pause.disabled=job.pausing || job.resuming;actions.append(pause);}
      if(t.direction==='outgoing'&&job?.localSource&&t.status!=='complete'){const cancel=action('x','取消发送',()=>cancelJob(job));cancel.disabled=job.pausing || job.resuming;actions.append(cancel);}
      row.append(fileIcon(t.name),detail,el('span','activity-time',date(t.createdAt)),actions);list.append(row);
    }
  }
  function renderShares() {
    const shares=state?.shares || [];$('share-count').textContent=String(shares.length);const grid=$('share-grid');grid.replaceChildren();
    for(const [i,share]of shares.entries()){const remote=share.remote || !!share.hostId;const source=share.sourceName || state?.server?.name || '当前主机';const card=el('div','share-card');card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',`打开 ${source} 的共享文件夹 ${share.name}`);const cover=el('div',`share-cover ${['','mint','blue'][i%3]}`);cover.append(el('span','share-badge',remote?'来自另一台设备':'本机共享'),icon('folder'));const detail=el('div','share-card-body');detail.append(el('strong','share-card-name',share.name));const meta=el('span','share-card-meta');meta.append(icon(remote?'wifi':'server',true),document.createTextNode(source));meta.title=source;detail.append(meta);card.append(cover,detail);card.addEventListener('click',()=>browseShare(share,''));card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();browseShare(share,'');}});if(boot.admin&&!remote){const remove=action('trash','取消共享',event=>{event.stopPropagation();confirmRemoveShare(share);},true);remove.classList.add('share-delete');card.append(remove);}grid.append(card);}
    if(boot.admin){const add=button('共享一个文件夹','share-add-card',showAddShare);add.prepend(icon('plus'));grid.append(add);}
    if(!shares.length&&!boot.admin)grid.append(empty('folder','等待主机分享第一处空间','在主机本机添加共享文件夹后，就能浏览和在线播放其中的影音。',true));
    if(currentShare&&!shares.some(s=>shareKey(s)===shareKey(currentShare))){currentShare=null;currentPath='';browseData=null;$('media-browser').hidden=true;$('media-root').hidden=false;}
  }
  function shareKey(share){return `${share.hostId || 'local'}:${share.id}`;}
  function sharePath(share,operation,path){const root=share.hostId?`/api/peers/${encodeURIComponent(share.hostId)}/shares`:'/api/shares';return `${root}/${encodeURIComponent(share.id)}/${operation}?path=${encodeURIComponent(path || '')}`;}
  function showAddShare() {
    openModal('共享一个文件夹',body=>{
      body.append(el('p','','添加一个影音文件夹，让同一网络中的设备浏览和播放。文件保留在原处，取消共享不会删除原文件。'));
      const form=el('form');const pathLabel=el('label','field-label','文件夹路径');const input=el('input','text-input');input.placeholder='例如：D:\\Movies';input.required=true;pathLabel.append(input);const picker=button('从本机选择文件夹','button secondary',async()=>{
        picker.disabled=true;try{const result=await api('/api/pick-folder',{method:'POST',body:{}});if(result.pending){closeModal();toast('请在本机选择要共享的文件夹，完成后自动加入共享空间。');refreshState();}else if(result.path){input.value=result.path;name.value=result.path.split(/[\\/]/).filter(Boolean).at(-1)||'';}}catch(error){errorNode.textContent=error.message;}finally{picker.disabled=false;}
      },'folder');picker.style.marginTop='12px';
      const nameLabel=el('label','field-label','显示名称（可选）');const name=el('input','text-input');name.placeholder='例如：电影收藏';name.maxLength=60;nameLabel.append(name);const errorNode=el('p','modal-inline-error');const actions=el('div','modal-actions');const submit=button('开始共享','button primary');submit.type='submit';actions.append(button('取消','button secondary',closeModal),submit);form.append(pathLabel,picker,nameLabel,errorNode,actions);
      if(boot.capabilities?.native){pathLabel.hidden=true;nameLabel.hidden=true;submit.hidden=true;input.required=false;picker.className='button primary full-width';picker.textContent='选择要共享的文件夹';picker.prepend(icon('folder'));}
      form.addEventListener('submit',async event=>{event.preventDefault();submit.disabled=true;errorNode.textContent='';try{await api('/api/shares',{method:'POST',body:{path:input.value.trim(),name:name.value.trim()||undefined}});closeModal();await refreshState();toast('文件夹已共享，其他设备现在可以访问。');}catch(error){errorNode.textContent=error.message;}finally{submit.disabled=false;}});body.append(form);
    });
  }
  function confirmRemoveShare(share){openModal('取消共享',body=>{body.append(el('p','',`取消共享「${share.name}」后，其他设备将无法继续浏览。原文件保留在主机上。`));const actions=el('div','modal-actions');actions.append(button('保留共享','button secondary',closeModal),button('取消共享','button danger',async()=>{try{await api(`/api/shares/${encodeURIComponent(share.id)}`,{method:'DELETE'});closeModal();await refreshState();toast('已取消共享');}catch(error){toast(error.message,true);}}));body.append(actions);});}
  async function browseShare(share,path){currentShare=share;currentPath=path;const request=++browseRequest;$('media-root').hidden=true;$('media-browser').hidden=false;$('file-search').value='';$('file-browser').replaceChildren(empty('folder','正在打开文件夹',`正在读取 ${share.sourceName || '主机'} 中的文件。`));renderBreadcrumbs();try{const data=await api(sharePath(share,'browse',path));if(request!==browseRequest)return;browseData=data;currentPath=data.path??path;renderBreadcrumbs();renderBrowseFiles();}catch(error){if(request!==browseRequest)return;browseData=null;$('file-browser').replaceChildren(empty('info','暂时无法打开这个文件夹',error.message,false,button('重试','button secondary',()=>browseShare(share,path),'refresh')));$('browser-total').textContent='';}}
  function renderBreadcrumbs(){const crumbs=$('breadcrumbs');crumbs.replaceChildren();crumbs.append(button('共享空间','',()=>{currentShare=null;currentPath='';browseData=null;browseRequest++;$('media-root').hidden=false;$('media-browser').hidden=true;}));if(!currentShare)return;crumbs.append(icon('chevron',true),button(`${currentShare.sourceName?`${currentShare.sourceName} · `:''}${currentShare.name}`,'',()=>browseShare(currentShare,'')));const parts=currentPath.split('/').filter(Boolean);let segment='';for(const part of parts){segment+=(segment?'/':'')+part;const path=segment;crumbs.append(icon('chevron',true),button(part,'',()=>browseShare(currentShare,path)));}}
  function mediaUrl(entry,download=false){return url(sharePath(currentShare,download?'download':'file',entry.path));}
  function renderBrowseFiles(){if(!browseData)return;const search=$('file-search').value.trim().toLocaleLowerCase();const sort=$('file-sort').value;const entries=(browseData.entries||[]).filter(e=>e.name.toLocaleLowerCase().includes(search));entries.sort((a,b)=>{if(a.type!==b.type)return a.type==='folder'?-1:1;if(sort==='date')return new Date(b.modifiedAt)-new Date(a.modifiedAt);if(sort==='size')return Number(b.size)-Number(a.size);return a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'});});const list=$('file-browser');list.replaceChildren();if(!entries.length){list.append(empty('folder',search?'没有找到匹配的文件':'这个文件夹还没有文件',search?'换一个关键词试试。':'把影音文件放入共享文件夹，刷新后即可看到。'));}else{const head=el('div','browse-row browse-table-head');head.append(el('span','','名称'),el('span','browse-size','大小'),el('span','browse-date','修改日期'),el('span','',''));list.append(head);for(const entry of entries){const row=el('div','browse-row');row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-label',`${entry.type==='folder'?'打开文件夹':'打开文件'} ${entry.name}`);const name=el('span','browse-name');name.append(fileIcon(entry.name,entry.mime,entry.type==='folder'),el('span','',entry.name));name.title=entry.name;const actions=el('div','browse-actions');if(entry.type==='folder'){actions.append(action('chevron','打开文件夹',event=>{event.stopPropagation();browseShare(currentShare,entry.path);}));}else{const kind=fileKind(entry.name,entry.mime);if(kind!=='file'){const preview=action(kind==='image'?'image':'play','预览文件',event=>{event.stopPropagation();openPlayer(entry);});preview.classList.add('preview-button');actions.append(preview);}const download=el('a','icon-button');download.append(icon('download'));download.title='下载原文件';download.setAttribute('aria-label',`下载 ${entry.name}`);download.href=mediaUrl(entry,true);download.download=entry.name;download.addEventListener('click',event=>event.stopPropagation());actions.append(download);}const open=()=>entry.type==='folder'?browseShare(currentShare,entry.path):fileKind(entry.name,entry.mime)!=='file'?openPlayer(entry):downloadFile(entry);row.addEventListener('click',open);row.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();open();}});row.append(name,el('span','browse-size',entry.type==='folder'?'—':bytes(entry.size)),el('span','browse-date',date(entry.modifiedAt)),actions);list.append(row);}}$('browser-total').textContent=`${entries.length} 项${search?` · 共 ${(browseData.entries||[]).length} 项`:''}`;}
  function downloadFile(entry){const a=el('a');a.href=mediaUrl(entry,true);a.download=entry.name;document.body.append(a);a.click();a.remove();}
  function openPlayer(entry){closePlayer();const kind=fileKind(entry.name,entry.mime);$('player-title').textContent=entry.name;$('player-detail').textContent=`${bytes(entry.size)} · ${currentShare?.name||'共享文件'}`;$('player-error').hidden=true;$('player-download').href=mediaUrl(entry,true);$('player-download').download=entry.name;$('subtitle-button').hidden=kind!=='video';playerElement=el(kind==='image'?'img':kind==='audio'?'audio':'video');playerElement.src=mediaUrl(entry);if(kind==='image')playerElement.alt=entry.name;else{playerElement.controls=true;playerElement.autoplay=true;playerElement.preload='metadata';if(kind==='video')playerElement.setAttribute('playsinline','');}playerElement.addEventListener('error',()=>{$('player-error').textContent=kind==='image'?'图片无法预览，请下载原文件查看。':'当前浏览器无法解码这个影音文件，或主机连接已经中断。推荐 MP4（H.264）/ WebM；也可下载原文件用本地播放器打开。';$('player-error').hidden=false;});$('player-content').replaceChildren(playerElement);$('player-modal').showModal();}
  function closePlayer(){if(playerElement){if(typeof playerElement.pause==='function')playerElement.pause();playerElement.removeAttribute('src');if(typeof playerElement.load==='function')playerElement.load();playerElement=null;}$('player-content').replaceChildren();if(subtitleUrl){URL.revokeObjectURL(subtitleUrl);subtitleUrl=null;}if($('player-modal').open)$('player-modal').close();}
  async function saveDevice(event){event.preventDefault();const submit=$('device-form').querySelector('[type=submit]');submit.disabled=true;try{const name=$('device-name').value.trim();if(!name)throw new Error('请输入设备名称');await api('/api/device',{method:'POST',body:{name}});deviceName=name;storage.set('linkwave.deviceName',name);$('self-name').textContent=name;$('top-avatar').textContent=name.slice(0,1).toUpperCase();await refreshState();toast('设备名称已保存');}catch(error){toast(error.message,true);}finally{submit.disabled=false;}}
  async function saveServer(event){event.preventDefault();const submit=$('server-form').querySelector('[type=submit]');submit.disabled=true;try{const body={name:$('server-name').value.trim()};if(!boot.capabilities?.native && !$('download-dir').readOnly)body.downloadDir=$('download-dir').value.trim();const data=await api('/api/settings',{method:'PATCH',body});boot={...boot,...data};await refreshState();toast('主机设置已保存');}catch(error){toast(error.message,true);}finally{submit.disabled=false;}}

  document.querySelectorAll('[data-view]').forEach(node=>node.addEventListener('click',()=>switchView(node.dataset.view)));
  window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(viewLabels[next])switchView(next);});
  $('loading-retry').addEventListener('click',initialize);
  $('connection-button').addEventListener('click',showConnect);$('connect-main').addEventListener('click',showConnect);$('mobile-connect').addEventListener('click',showConnect);
  $('reconnect-button').addEventListener('click',refreshState);$('refresh-inbox').addEventListener('click',()=>{refreshState();toast('收件箱已刷新');});$('refresh-activity').addEventListener('click',refreshState);
  $('open-inbox').addEventListener('click',openInboxFolder);$('inbox-notice-view').addEventListener('click',revealInbox);$('inbox-notice-dismiss').addEventListener('click',markInboxRead);
  $('target-button').addEventListener('click',showTargets);
  $('create-file-link').addEventListener('click',showCreateFileLink);
  $('modal-close').addEventListener('click',closeModal);$('modal').addEventListener('cancel',event=>{event.preventDefault();closeModal();});$('modal').addEventListener('click',event=>{if(event.target===$('modal')){const rect=$('modal').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeModal();}});
  $('choose-files').addEventListener('click',event=>{event.stopPropagation();chooseSendSource();});$('choose-folder').addEventListener('click',event=>{event.stopPropagation();chooseSendSource(true);});
  $('paste-local-paths').addEventListener('click',event=>{event.stopPropagation();showLocalPaths();});
  $('drop-zone').addEventListener('click',event=>{if(!event.target.closest('button'))chooseSendSource();});$('drop-zone').addEventListener('keydown',event=>{if(event.target===$('drop-zone')&&(event.key==='Enter'||event.key===' ')){event.preventDefault();chooseSendSource();}});
  $('files-input').addEventListener('change',()=>{acceptFiles([...$('files-input').files]);$('files-input').value='';});$('folder-input').addEventListener('change',()=>{acceptFiles([...$('folder-input').files]);$('folder-input').value='';});
  let dragDepth=0;const drop=$('drop-zone');drop.addEventListener('dragenter',event=>{event.preventDefault();dragDepth++;drop.classList.add('dragover');});drop.addEventListener('dragleave',event=>{event.preventDefault();if(--dragDepth<=0){dragDepth=0;drop.classList.remove('dragover');}});drop.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='copy';});drop.addEventListener('drop',async event=>{event.preventDefault();dragDepth=0;drop.classList.remove('dragover');if(usesLocalFiles()){toast('浏览器不给原路径，请在文件窗口选择，直接发送原文件');await chooseSendSource();return;}try{const items=[...(event.dataTransfer.items||[])];const entries=items.map(item=>item.webkitGetAsEntry?.()).filter(Boolean);if(entries.length){const result=[];for(const entry of entries)result.push(...await gatherEntries(entry));await acceptFiles(result);}else await acceptFiles([...event.dataTransfer.files]);}catch(error){toast(`读取拖入的文件失败：${error.message}`,true);}});
  window.addEventListener('dragover',event=>event.preventDefault());window.addEventListener('drop',event=>event.preventDefault());
  $('clear-complete').addEventListener('click',()=>{for(let i=jobs.length-1;i>=0;i--)if(['complete','cancelled'].includes(jobs[i].status))jobs.splice(i,1);renderJobs();});
  $('activity-filter').addEventListener('click',event=>{const b=event.target.closest('[data-filter]');if(!b)return;activityFilter=b.dataset.filter;for(const child of $('activity-filter').children)child.classList.toggle('active',child===b);renderActivity();});
  $('add-share').addEventListener('click',showAddShare);$('file-search').addEventListener('input',renderBrowseFiles);$('file-sort').addEventListener('change',renderBrowseFiles);$('browser-refresh').addEventListener('click',()=>{if(currentShare)browseShare(currentShare,currentPath);});
  $('player-close').addEventListener('click',closePlayer);$('player-modal').addEventListener('cancel',event=>{event.preventDefault();closePlayer();});$('subtitle-button').addEventListener('click',()=>$('subtitle-input').click());$('subtitle-input').addEventListener('change',()=>{const file=$('subtitle-input').files[0];if(!file||!playerElement||playerElement.tagName!=='VIDEO')return;if(!/\.vtt$/i.test(file.name)){toast('请选择 WebVTT (.vtt) 字幕文件',true);return;}if(subtitleUrl)URL.revokeObjectURL(subtitleUrl);subtitleUrl=URL.createObjectURL(file);playerElement.querySelectorAll('track').forEach(track=>track.remove());const track=el('track');track.kind='subtitles';track.label=file.name;track.srclang='zh';track.default=true;track.src=subtitleUrl;playerElement.append(track);track.addEventListener('load',()=>{track.track.mode='showing';});toast('字幕已加载');$('subtitle-input').value='';});
  $('device-form').addEventListener('submit',saveDevice);$('server-form').addEventListener('submit',saveServer);$('pick-download-dir').addEventListener('click',async()=>{const b=$('pick-download-dir');b.disabled=true;try{const result=await api('/api/pick-folder',{method:'POST',body:{}});if(result.path)$('download-dir').value=result.path;}catch(error){toast(error.message,true);}finally{b.disabled=false;}});
  window.addEventListener('online',refreshState);window.addEventListener('linkwave-native-share',()=>{refreshState();if(view!=='media')switchView('media');});window.addEventListener('linkwave-native-file',()=>refreshState());window.addEventListener('linkwave-transfer',onNativeTransfer);window.addEventListener('linkwave-inbox-saved',refreshState);window.addEventListener('linkwave-inbox',event=>{pendingInboxEvent=event.detail || {};revealInbox();refreshState();});document.addEventListener('visibilitychange',()=>{if(!document.hidden){refreshState();if(token)api('/api/heartbeat',{method:'POST',body:{}}).catch(()=>{});}});
  window.addEventListener('beforeunload',event=>{if(jobs.some(j=>!j.localSource&&['uploading','queued','sending'].includes(j.status))){event.preventDefault();event.returnValue='';}});
  if(/Android|iPhone|iPad/i.test(navigator.userAgent)) $('choose-folder').hidden=true;
  initialize();
})();

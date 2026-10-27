'use strict';
/* Terwo frontend */

// ---------- helper ----------
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('Session expired'); }
  return r;
}
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtDate(ms) {
  return new Date(ms).toLocaleString('en-US');
}
function fmtUptime(sec) {
  sec = Math.floor(sec || 0);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// ---------- lucide icons ----------
function refreshIcons() {
  try {
    if (window.lucide) { lucide.createIcons(); return; }
  } catch (e) {}
  // lucide belum termuat: coba lagi setelah window load, jangan diam-diam gagal
  if (document.readyState !== 'complete') {
    window.addEventListener('load', function () {
      try { if (window.lucide) lucide.createIcons(); } catch (e) {}
    }, { once: true });
  }
}
function ic(n, c) { return '<i data-lucide="' + n + '" class="' + (c || 'h-4 w-4') + '"></i>'; }
function dot() { return '<span class="h-1.5 w-1.5 rounded-full bg-current"></span>'; }
// ---------- dark/light theme (stored in localStorage 'terwo-theme') ----------
function getTheme() {
  try { return localStorage.getItem('terwo-theme') === 'light' ? 'light' : 'dark'; }
  catch (e) { return 'dark'; }
}
function updateThemeUI(t) {
  const icon = t === 'light' ? 'moon' : 'sun';
  const label = t === 'light' ? 'Dark mode' : 'Light mode';
  document.querySelectorAll('.btn-theme').forEach((b) => {
    const hasLabel = b.querySelector('span') !== null;
    b.innerHTML = ic(icon, 'h-4 w-4') + (hasLabel ? '<span>' + label + '</span>' : '');
    b.setAttribute('title', label);
    b.setAttribute('aria-label', label);
  });
  refreshIcons();
}
function applyTheme(t) {
  document.documentElement.classList.toggle('light', t === 'light');
  try { localStorage.setItem('terwo-theme', t); } catch (e) {}
  updateThemeUI(t);
}
function badgeOk(t) { return '<span class="badge badge-ok">' + dot() + esc(t) + '</span>'; }
function badgeOff(t) { return '<span class="badge badge-off">' + dot() + esc(t) + '</span>'; }
function badgeWarn(t) { return '<span class="badge badge-warn">' + dot() + esc(t) + '</span>'; }

// ---------- tabs (one slug per page) ----------
const TAB_SLUGS = { dashboard: 'dashboard', web: 'website', db: 'database', files: 'files', cron: 'cron', backup: 'backup', settings: 'settings', term: 'terminal', install: 'store', ai: 'ai' };
const SLUG_TABS = {};
for (const k of Object.keys(TAB_SLUGS)) SLUG_TABS[TAB_SLUGS[k]] = k;
const TAB_TITLES = { dashboard: 'Dashboard', web: 'Website', db: 'Database', files: 'File Manager', cron: 'Cron', backup: 'Backup', settings: 'Settings', term: 'Terminal', install: 'Store', ai: 'AI Chat' };
function tabFromPath() { const slug = location.pathname.replace(/^\/+|\/+$/g, ''); if (slug === 'tunnel') return 'web'; return SLUG_TABS[slug] || 'dashboard'; } // link /tunnel lama dialihkan ke Website
function showTab(id, push) {
  if (!TAB_SLUGS[id]) id = 'dashboard';
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === id));
  document.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  document.title = TAB_TITLES[id] + ' — Terwo';
  if (id === 'install') loadInstall();
  if (id === 'db') loadDbConfig();
  if (id === 'ai') loadAiConfig();
  if (id === 'web') { loadNginx(); loadSites(); }
  if (id === 'dashboard') startStats(); else stopStats();
  if (id === 'cron') loadCron();
  if (id === 'term') termTabOpen();
  if (id === 'backup') loadBackups();
  if (id === 'settings') { loadSettings(); loadTunnel(); startTunnelPoll(); } else stopTunnelPoll();
  if (push) history.pushState({ tab: id }, '', '/' + TAB_SLUGS[id]);
  refreshIcons();
}
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => showTab(t.dataset.tab, true));
});
window.addEventListener('popstate', () => showTab(tabFromPath(), false));
// initial tab is activated at the end of this file, once every let/const below is initialized

// ---------- confirm dialog ----------
function confirmDialog({ title, message, okText, danger = true, icon = 'alert-triangle' } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-title').textContent = title || 'Are you sure?';
    document.getElementById('confirm-msg').textContent = message || '';
    const iconEl = document.getElementById('confirm-icon');
    iconEl.className = danger ? 'text-err' : 'text-warn';
    iconEl.innerHTML = '<i data-lucide="' + icon + '" class="h-5 w-5"></i>';
    const okBtn = document.getElementById('confirm-ok');
    okBtn.textContent = okText || 'Delete';
    okBtn.className = (danger ? 'btn-danger' : 'btn') + ' btn-sm';
    refreshIcons();
    modal.classList.remove('hidden');
    let done = false;
    const close = (val) => {
      if (done) return;
      done = true;
      modal.classList.add('hidden');
      document.getElementById('confirm-ok').removeEventListener('click', onOk);
      document.getElementById('confirm-cancel').removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (e) => { if (e.target === modal) close(false); };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };
    document.getElementById('confirm-ok').addEventListener('click', onOk);
    document.getElementById('confirm-cancel').addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// ---------- logout ----------
document.getElementById('btn-logout').addEventListener('click', async () => {
  const ok = await confirmDialog({ title: 'Log out?', message: 'End this session and return to the login page.', okText: 'Log out', danger: false, icon: 'log-out' });
  if (!ok) return;
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});
// ---------- file manager ----------
let curDir = '';
const crumbsEl = document.getElementById('crumbs');
const listEl = document.getElementById('file-list');
const fileErr = document.getElementById('file-error');

function entryPath(name) { return curDir ? curDir + '/' + name : name; }

function showFileErr(m) {
  fileErr.textContent = m;
  setTimeout(() => { fileErr.textContent = ''; }, 4000);
}

function renderCrumbs() {
  const parts = curDir ? curDir.split('/') : [];
  let html = '<button class="crumb" data-p="">' + ic('house', 'h-[15px] w-[15px]') + '</button>';
  let acc = '';
  for (const p of parts) {
    acc = acc ? acc + '/' + p : p;
    html += ' <span class="text-muted">/</span> <button class="crumb" data-p="' + esc(acc) + '">' + esc(p) + '</button>';
  }
  crumbsEl.innerHTML = html;
  crumbsEl.querySelectorAll('.crumb').forEach((b) => {
    b.addEventListener('click', () => { curDir = b.dataset.p; loadFiles(); });
  });
  refreshIcons();
}

function fileIcon(e) {
  if (e.type === 'dir') return ic('folder', 'h-4 w-4 text-accent-h');
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(e.name)) return ic('image', 'h-4 w-4 text-warn');
  if (/\.zip$/i.test(e.name)) return ic('archive', 'h-4 w-4 text-ok');
  return ic('file-text', 'h-4 w-4 text-muted');
}

async function loadFiles() {
  renderCrumbs();
  try {
    const j = await (await api('/api/files?path=' + encodeURIComponent(curDir))).json();
    listEl.innerHTML = '';
    if (curDir) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4"><button class="crumb" id="up">' + ic('arrow-up', 'h-[15px] w-[15px]') + ' ..</button></td>';
      listEl.appendChild(tr);
      tr.querySelector('#up').addEventListener('click', () => {
        curDir = curDir.split('/').slice(0, -1).join('/');
        loadFiles();
      });
    }
    for (const e of j.entries) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><span class="fname inline-flex cursor-pointer items-center gap-2 font-medium hover:text-accent-h" data-n="' + esc(e.name) + '" data-t="' + e.type + '">' + fileIcon(e) + ' ' + esc(e.name) + '</span></td>' +
        '<td class="muted">' + (e.type === 'dir' ? '—' : fmtSize(e.size)) + '</td>' +
        '<td class="muted">' + fmtDate(e.mtime) + '</td>' +
        '<td><div class="row-actions"></div></td>';
      const acts = tr.querySelector('.row-actions');
      const mkBtn = (icn, fn, title) => {
        const b = document.createElement('button');
        b.className = 'mini'; b.innerHTML = ic(icn, 'h-[15px] w-[15px]');
        if (title) b.title = title;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        acts.appendChild(b);
      };
      if (e.type === 'dir') {
        tr.querySelector('.fname').addEventListener('click', () => {
          curDir = entryPath(e.name);
          loadFiles();
        });
      } else {
        mkBtn('download', () => {
          location.href = '/api/download?path=' + encodeURIComponent(curDir) + '&name=' + encodeURIComponent(e.name);
        }, 'Download');
        mkBtn('pencil', () => openEditor(e.name), 'Edit');
        if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(e.name)) mkBtn('eye', () => previewImage(e.name), 'Preview');
        if (/\.zip$/i.test(e.name)) mkBtn('package-open', () => unzipEntry(e.name), 'Extract ZIP');
      }
      mkBtn('archive', () => zipEntry(e.name), 'Archive as ZIP');
      mkBtn('pencil-line', () => renameEntry(e.name), 'Rename');
      mkBtn('trash-2', () => deleteEntry(e.name), 'Delete');
      listEl.appendChild(tr);
    }
    if (!j.entries.length) {
      listEl.innerHTML += '<tr><td colspan="4" class="muted">Empty folder</td></tr>';
    }
    refreshIcons();
  } catch (e) {
    showFileErr(e.message || 'Failed to load');
  }
}
// file manager: actions
document.getElementById('btn-mkdir').addEventListener('click', async () => {
  const n = prompt('Folder name:');
  if (!n) return;
  const r = await api('/api/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: curDir, name: n }),
  });
  const j = await r.json();
  if (j.ok) loadFiles(); else showFileErr(j.error || 'Failed');
});
document.getElementById('btn-touch').addEventListener('click', async () => {
  const n = prompt('File name:');
  if (!n) return;
  const r = await api('/api/touch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: curDir, name: n }),
  });
  const j = await r.json();
  if (j.ok) loadFiles(); else showFileErr(j.error || 'Failed');
});
async function deleteEntry(name) {
  if (!(await confirmDialog({ title: 'Delete file?', message: 'Delete "' + name + '"? This cannot be undone.' }))) return;
  const r = await api('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: curDir, name }),
  });
  const j = await r.json();
  if (j.ok) loadFiles(); else showFileErr(j.error || 'Failed');
}
async function renameEntry(name) {
  const n = prompt('New name:', name);
  if (!n || n === name) return;
  const r = await api('/api/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: curDir, from: name, to: n }),
  });
  const j = await r.json();
  if (j.ok) loadFiles(); else showFileErr(j.error || 'Failed');
}
async function zipEntry(name) {
  const r = await api('/api/files/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: entryPath(name) }),
  });
  const j = await r.json();
  if (j.ok) loadFiles(); else showFileErr(j.error || 'Failed');
}
async function unzipEntry(name) {
  const r = await api('/api/files/unzip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: entryPath(name) }),
  });
  const j = await r.json();
  if (j.ok) loadFiles(); else showFileErr(j.error || 'Failed');
}
// upload (JSON base64)
document.getElementById('btn-upload').addEventListener('click', () => {
  document.getElementById('file-input').click();
});
document.getElementById('file-input').addEventListener('change', (ev) => {
  const f = ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  const rd = new FileReader();
  rd.onload = async () => {
    const b64 = String(rd.result).split(',')[1] || '';
    try {
      const r = await api('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: curDir, name: f.name, data: b64 }),
      });
      const j = await r.json();
      if (j.ok) loadFiles(); else showFileErr(j.error || 'Upload failed');
    } catch (e) {
      showFileErr(e.message || 'Upload failed');
    }
  };
  rd.onerror = () => showFileErr('Failed to read file');
  rd.readAsDataURL(f);
});

// ---------- editor file ----------
const edModal = document.getElementById('editor-modal');
const edText = document.getElementById('editor-text');
let edName = null;
async function openEditor(name) {
  edName = name;
  document.getElementById('editor-title').textContent = 'Edit: ' + name;
  edText.value = 'loading…';
  edModal.classList.remove('hidden');
  try {
    const r = await api('/api/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: curDir, name }),
    });
    const j = await r.json();
    edText.value = j.ok ? j.content : ('Error: ' + (j.error || 'gagal'));
  } catch (e) {
    edText.value = 'Error: ' + (e.message || 'gagal');
  }
}
document.getElementById('editor-close').addEventListener('click', () => edModal.classList.add('hidden'));
document.getElementById('editor-save').addEventListener('click', async () => {
  const r = await api('/api/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: curDir, name: edName, content: edText.value }),
  });
  const j = await r.json();
  if (j.ok) { edModal.classList.add('hidden'); loadFiles(); }
  else showFileErr(j.error || 'Failed to save');
});
// ---------- preview gambar ----------
const pvModal = document.getElementById('preview-modal');
function previewImage(name) {
  document.getElementById('preview-title').textContent = name;
  document.getElementById('preview-img').src =
    '/api/files/preview?path=' + encodeURIComponent(entryPath(name));
  pvModal.classList.remove('hidden');
}
document.getElementById('preview-close').addEventListener('click', () => pvModal.classList.add('hidden'));

// ---------- terminal (xterm.js) ----------
let termWs = null, term = null, fitAddon = null, termOpened = false;

function termTabOpen() {
  if (!term) initTerm();
  if (termOpened) return;
  termOpened = true;
  term.open(document.getElementById('term-box'));
  fitAddon.fit();
  connectTerm();
  new ResizeObserver(() => { if (term && termOpened) { try { fitAddon.fit(); } catch {} } }).observe(document.getElementById('term-box'));
}
function initTerm() {
  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Consolas, monospace',
    theme: { background: '#14171b', foreground: '#e8ecef', cursor: '#20a53a', selectionBackground: 'rgba(32,165,58,0.35)' },
  });
  if (window.FitAddon && window.FitAddon.FitAddon) {
    fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
  }
  term.attachCustomKeyEventHandler((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && term.getSelection()) {
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    return true;
  });
  term.onData((d) => {
    if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ t: 'in', d }));
  });
}
function connectTerm() {
  const st = document.getElementById('term-status');
  st.textContent = 'connecting…';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  termWs = new WebSocket(proto + '//' + location.host + '/term');
  termWs.onopen = () => {
    st.innerHTML = badgeOk('Connected');
    if (fitAddon) termWs.send(JSON.stringify({ t: 'rs', c: term.cols, r: term.rows }));
    refreshIcons();
  };
  termWs.onclose = () => { st.innerHTML = badgeOff('Disconnected'); refreshIcons(); };
  termWs.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m && m.t === 'out' && m.d) { term.write(m.d); return; }
    } catch { /* bukan JSON, tulis mentah */ }
    term.write(ev.data);
  };
}
document.getElementById('btn-term-conn').addEventListener('click', () => {
  if (termWs) { try { termWs.close(); } catch {} }
  termTabOpen();
  connectTerm();
});
document.getElementById('btn-term-clear').addEventListener('click', () => {
  if (term) term.clear();
});
document.getElementById('btn-term-paste').addEventListener('click', async () => {
  try {
    const txt = await navigator.clipboard.readText();
    if (txt && termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ t: 'in', d: txt }));
  } catch (e) {
    alert('Clipboard is not accessible to the browser. Use Ctrl+Shift+V / right-click.');
  }
});

// ---------- dashboard ----------
let statsTimer = null;
function startStats() {
  stopStats();
  loadStats();
  statsTimer = setInterval(loadStats, 5000);
}
function stopStats() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
}
async function loadStats() {
  try {
    const j = await (await api('/api/stats')).json();
    const m = j.mem || {}, c = j.cpu || {}, d = j.disk;
    const bar = (p) => '<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-border"><div class="h-full rounded-full bg-accent transition-all" style="width:' + Math.min(100, p || 0) + '%"></div></div>';
    const card = (icn, label, val, sub, pb) =>
      '<div class="card !p-4"><div class="flex items-center gap-2 text-[13px] text-muted">' + ic(icn, 'h-4 w-4 text-accent-h') + esc(label) + '</div>' +
      '<div class="mt-1.5 text-xl font-bold tracking-tight">' + val + '</div>' +
      (sub ? '<div class="mt-0.5 text-xs text-muted">' + sub + '</div>' : '') + (pb || '') + '</div>';
    document.getElementById('stats-grid').innerHTML =
      card('cpu', 'CPU', (c.load1 != null ? c.load1.toFixed(2) : '—'), (c.cores || '—') + ' core', '') +
      card('memory-stick', 'RAM', (m.percent != null ? m.percent + '%' : '—'), fmtSize(m.used || 0) + ' / ' + fmtSize(m.total || 0), bar(m.percent)) +
      card('hard-drive', 'Disk', d ? d.percent + '%' : '—', d ? fmtSize(d.used) + ' / ' + fmtSize(d.total) : '', d ? bar(d.percent) : '') +
      card('battery-medium', 'Battery', (j.battery && j.battery.percentage != null) ? j.battery.percentage + '%' : '—', j.battery ? esc(j.battery.status || j.battery.error || '') : '', '') +
      card('timer', 'Uptime', fmtUptime(j.uptime), fmtDate(j.time), '');
    if (j.sites) renderDashSites(j.sites);
    refreshIcons();
  } catch (e) { /* ignore */ }
}
function renderDashSites(list) {
  const el = document.getElementById('dash-sites');
  el.innerHTML = '';
  if (!list || !list.length) {
    el.innerHTML = '<tr><td colspan="4" class="muted">No websites yet</td></tr>';
  } else {
    for (const s of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(s.name) + '</td><td class="muted">' + esc(s.type) + '</td><td class="muted">' + s.port + '</td><td>' + (s.running ? badgeOk('Running') : badgeOff('Stopped')) + '</td>';
      el.appendChild(tr);
    }
  }
  refreshIcons();
}
async function loadDashSites() {
  try {
    const j = await (await api('/api/sites')).json();
    renderDashSites(j.sites);
  } catch { /* ignore */ }
}

// ---------- website ----------
let siteType = 'node';
document.querySelectorAll('[data-stype]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-stype]').forEach((x) => x.classList.toggle('active', x === b));
    siteType = b.dataset.stype;
    document.querySelector('#site-add span').textContent = 'Add (' + b.textContent.trim() + ')';
    loadSites();
  });
});
const siteModal = document.getElementById('site-modal');
document.getElementById('site-add').addEventListener('click', () => {
  document.getElementById('site-modal-title').textContent = 'Add Website (' + siteType + ')';
  document.getElementById('site-name').value = '';
  document.getElementById('site-path').value = '';
  document.getElementById('site-port').value = '';
  document.getElementById('site-err').textContent = '';
  siteModal.classList.remove('hidden');
});
document.getElementById('site-close').addEventListener('click', () => siteModal.classList.add('hidden'));
document.getElementById('site-save').addEventListener('click', async () => {
  const err = document.getElementById('site-err');
  err.textContent = '';
  const body = {
    name: document.getElementById('site-name').value.trim(),
    path: document.getElementById('site-path').value.trim(),
    port: parseInt(document.getElementById('site-port').value, 10),
    type: siteType,
  };
  if (!body.name || !body.path || !body.port) { err.textContent = 'Fill in all fields'; return; }
  const r = await api('/api/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.ok) { siteModal.classList.add('hidden'); loadSites(); loadDashSites(); }
  else err.textContent = j.error || 'Failed';
});
async function loadSites() {
  try {
    const j = await (await api('/api/sites')).json();
    const el = document.getElementById('site-list');
    el.innerHTML = '';
    const list = (j.sites || []).filter((s) => s.type === siteType);
    for (const s of list) {
      const tr = document.createElement('tr');
      const tun = s.tunnel || {};
      const tunState = tun.enabled ? (tun.url ? 'on' : (s.running ? 'starting' : 'armed')) : 'off';
      tr.innerHTML =
        '<td>' + esc(s.name) + '</td>' +
        '<td class="muted font-mono text-[12.5px]">' + esc(s.path) + '</td>' +
        '<td class="muted">' + s.port + '</td>' +
        '<td>' + (s.running ? badgeOk('Running') : badgeOff('Stopped')) + '</td>' +
        '<td><div class="akses-cell"></div></td>' +
        '<td><div class="row-actions"></div></td>';
      // Kolom Akses: opsi eksplisit per website — Stay Local / Tunneling.
      const akses = tr.querySelector('.akses-cell');
      const seg = document.createElement('div');
      seg.className = 'flex flex-wrap items-center gap-1';
      const segBtn = (label, active, fn) => {
        const b = document.createElement('button');
        b.className = active ? 'btn btn-sm' : 'btn-ghost btn-sm';
        b.textContent = label;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        seg.appendChild(b);
      };
      segBtn('Stay Local', tunState === 'off', async () => {
        await api('/api/sites/' + s.id + '/tunnel/stop', { method: 'POST' }).catch(() => {});
        loadSites();
      });
      segBtn('Tunneling', tunState !== 'off', async () => {
        if (s.tunnel && s.tunnel.mode) {
          await api('/api/sites/' + s.id + '/tunnel/start', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: s.tunnel.mode, token: '', hostname: '' }) }).catch(() => {});
          loadSites();
        } else openSiteTunnelModal(s);
      });
      const atur = document.createElement('button');
      atur.className = 'btn-ghost btn-sm';
      atur.textContent = 'Atur';
      atur.title = 'Atur mode Quick/Named + token tunnel';
      atur.addEventListener('click', (ev) => { ev.stopPropagation(); openSiteTunnelModal(s); });
      seg.appendChild(atur);
      akses.appendChild(seg);
      if (tun.url) {
        const a = document.createElement('a');
        a.className = 'mt-1 block font-mono text-[12.5px] text-accent-h underline';
        a.target = '_blank'; a.rel = 'noopener'; a.href = tun.url; a.textContent = tun.url;
        akses.appendChild(a);
      } else if (tunState === 'starting') {
        const sp = document.createElement('span');
        sp.className = 'muted text-sm'; sp.textContent = 'Tunnel starting…';
        akses.appendChild(sp);
      } else if (tunState === 'armed') {
        const sp = document.createElement('span');
        sp.className = 'muted text-sm'; sp.textContent = 'Tunnel armed (nyala saat website jalan)';
        akses.appendChild(sp);
      }
      const acts = tr.querySelector('.row-actions');
      const mk = (icn, fn, title, danger) => {
        const b = document.createElement('button');
        b.className = 'mini'; b.innerHTML = ic(icn, 'h-[15px] w-[15px]'); b.title = title;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        if (danger) b.classList.add('text-err', 'border-err/30');
        acts.appendChild(b);
      };
      if (s.running) { mk('square', () => siteAct('stop', s.id), 'Stop'); mk('rotate-cw', () => siteAct('restart', s.id), 'Restart'); }
      else mk('play', () => siteAct('start', s.id), 'Start');
      mk('scroll-text', () => showLogs(s), 'Log');
      mk('trash-2', () => delSite(s), 'Delete', true);
      el.appendChild(tr);
    }
    if (!list.length) {
      el.innerHTML = '<tr><td colspan="6" class="muted">No ' + esc(siteType) + ' websites yet</td></tr>';
    }
    refreshIcons();
  } catch { /* ignore */ }
}
async function siteAct(act, id) {
  await api('/api/sites/' + id + '/' + act, { method: 'POST' }).catch(() => {});
  loadSites(); loadDashSites();
}
async function delSite(s) {
  if (!(await confirmDialog({ title: 'Delete website?', message: 'Delete website "' + s.name + '"? This cannot be undone.' }))) return;
  await api('/api/sites/' + s.id + '/delete', { method: 'POST' }).catch(() => {});
  loadSites(); loadDashSites();
}
// modal log website
const logsModal = document.getElementById('logs-modal');
document.getElementById('logs-close').addEventListener('click', () => logsModal.classList.add('hidden'));
async function showLogs(s) {
  document.getElementById('logs-title').textContent = 'Log: ' + s.name;
  document.getElementById('logs-body').textContent = 'loading…';
  logsModal.classList.remove('hidden');
  try {
    const j = await (await api('/api/sites/' + s.id + '/logs')).json();
    document.getElementById('logs-body').textContent = (j.logs ? j.logs : 'Log empty') + '\n';
  } catch (e) {
    document.getElementById('logs-body').textContent = 'Failed to load log';
  }
}

// ---------- tunnel per website ----------
let curTunnelSite = null;
const stunModal = document.getElementById('stun-modal');
function openSiteTunnelModal(s) {
  curTunnelSite = s;
  document.getElementById('stun-title').textContent = 'Tunnel: ' + s.name + ' (port ' + s.port + ')';
  const tun = s.tunnel || {};
  document.getElementById('stun-mode').value = tun.mode || 'quick';
  document.getElementById('stun-token-row').style.display = ((tun.mode || 'quick') === 'token') ? '' : 'none';
  document.getElementById('stun-token').value = '';
  document.getElementById('stun-host').value = tun.hostname || '';
  document.getElementById('stun-err').textContent = '';
  stunModal.classList.remove('hidden');
  refreshIcons();
}
function closeSiteTunnelModal() { stunModal.classList.add('hidden'); curTunnelSite = null; }
document.getElementById('stun-close').addEventListener('click', closeSiteTunnelModal);
stunModal.addEventListener('click', (e) => { if (e.target === stunModal) closeSiteTunnelModal(); });
document.getElementById('stun-mode').addEventListener('change', (e) => {
  document.getElementById('stun-token-row').style.display = (e.target.value === 'token') ? '' : 'none';
});
document.getElementById('stun-save').addEventListener('click', async () => {
  if (!curTunnelSite) return;
  const err = document.getElementById('stun-err');
  err.textContent = '';
  const r = await api('/api/sites/' + curTunnelSite.id + '/tunnel/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: document.getElementById('stun-mode').value,
      token: document.getElementById('stun-token').value.trim(),
      hostname: document.getElementById('stun-host').value.trim() }),
  });
  const jj = await r.json();
  if (jj.ok) { closeSiteTunnelModal(); loadSites(); }
  else err.textContent = jj.error || 'Failed';
});
document.getElementById('stun-stop').addEventListener('click', async () => {
  if (!curTunnelSite) return;
  await api('/api/sites/' + curTunnelSite.id + '/tunnel/stop', { method: 'POST' }).catch(() => {});
  closeSiteTunnelModal(); loadSites();
});
// ---------- nginx reverse proxy ----------
async function loadNginx() {
  try {
    const j = await (await api('/api/nginx/status')).json();
    document.getElementById('nginx-status').innerHTML = j.running ? badgeOk('Nginx running') : badgeOff('Nginx stopped');
  } catch { /* ignore */ }
  try {
    const j = await (await api('/api/nginx/proxies')).json();
    const el = document.getElementById('px-list');
    el.innerHTML = '';
    for (const p of j.proxies || []) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + esc(p.name) + '</td><td class="muted">' + p.listenPort + '</td><td class="muted">' + esc(p.domain || '—') + '</td><td class="muted">' + p.targetPort + '</td>' +
        '<td><div class="row-actions"><button class="mini text-err border-err/30">' + ic('trash-2', 'h-[15px] w-[15px]') + '</button></div></td>';
      tr.querySelector('button').addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Delete proxy?', message: 'Delete proxy "' + p.name + '"? This cannot be undone.' }))) return;
        await api('/api/nginx/proxies/' + p.id, { method: 'DELETE' }).catch(() => {});
        loadNginx();
      });
      el.appendChild(tr);
    }
    if (!(j.proxies || []).length) el.innerHTML = '<tr><td colspan="5" class="muted">No proxies yet</td></tr>';
    refreshIcons();
  } catch { /* ignore */ }
}
async function nginxService(action) {
  await api('/api/nginx/service', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }).catch(() => {});
  loadNginx();
}
document.getElementById('nginx-start').addEventListener('click', () => nginxService('start'));
document.getElementById('nginx-stop').addEventListener('click', () => nginxService('stop'));
document.getElementById('nginx-reload').addEventListener('click', () => nginxService('reload'));
document.getElementById('px-add').addEventListener('click', async () => {
  const err = document.getElementById('px-err');
  err.textContent = '';
  const r = await api('/api/nginx/proxies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('px-name').value.trim(),
      listenPort: parseInt(document.getElementById('px-port').value, 10),
      domain: document.getElementById('px-domain').value.trim(),
      targetPort: parseInt(document.getElementById('px-target').value, 10),
    }),
  });
  const j = await r.json();
  if (j.ok) loadNginx(); else err.textContent = j.error || 'Failed';
});

// ---------- store (install) ----------
async function loadInstall() {
  try {
    const j = await (await api('/api/install')).json();
    renderInstall(j.items || []);
  } catch (e) {
    document.getElementById('install-grid').innerHTML = '<p class="err">Failed to load</p>';
  }
}
function renderInstall(items) {
  const el = document.getElementById('install-grid');
  el.innerHTML = '';
  for (const it of items) {
    const d = document.createElement('div');
    d.className = 'card';
    const badge = it.installing ? badgeWarn('Running…') : (it.installed ? badgeOk('Installed') : badgeOff('Not installed'));
    const desc = it.desc ? '<p class="mt-1 text-[13px] text-muted">' + esc(it.desc) + '</p>' : '';
    const btn = it.installed
      ? '<button class="btn-ghost btn-sm" data-r="1">' + ic('rotate-cw', 'h-4 w-4') + 'Reinstall</button>'
      : '<button class="btn btn-sm" data-i="1">' + ic('download', 'h-4 w-4') + 'Install</button>';
    d.innerHTML =
      '<div class="flex items-start justify-between gap-3">' +
      '<div class="min-w-0"><div class="flex items-center gap-2 text-[15px] font-semibold">' + ic('package', 'h-[18px] w-[18px] text-accent-h') + '<span>' + esc(it.name || it.id) + '</span></div>' + desc + '</div>' + badge + '</div>' +
      '<div class="mt-3 flex gap-2">' + btn + '</div>';
    const b = d.querySelector('button');
    b.addEventListener('click', () => startInstall(it.id, it.name || it.id));
    el.appendChild(d);
  }
  refreshIcons();
}
const instModal = document.getElementById('install-modal');
document.getElementById('install-close').addEventListener('click', () => {
  instModal.classList.add('hidden');
  stopInstallPoll();
});
let instTimer = null;
function stopInstallPoll() {
  if (instTimer) { clearInterval(instTimer); instTimer = null; }
}
async function startInstall(id, label) {
  stopInstallPoll();
  try {
    const r = await api('/api/install/' + id + '/start', { method: 'POST' });
    const j = await r.json();
    if (!j.ok) { alert(j.error || 'Failed to start install'); return; }
  } catch (e) { alert(e.message || 'Failed'); return; }
  document.getElementById('install-title').textContent = 'Install: ' + label;
  document.getElementById('install-body').textContent = 'starting…\n';
  instModal.classList.remove('hidden');
  const poll = async () => {
    try {
      const j = await (await api('/api/install/' + id + '/log')).json();
      const el = document.getElementById('install-body');
      el.textContent = j.logs || '';
      el.scrollTop = el.scrollHeight;
      if (!j.running) {
        stopInstallPoll();
        el.textContent += '\n--- done (exit ' + j.exitCode + ') ---\n';
        loadInstall();
      }
    } catch { /* coba lagi */ }
  };
  await poll();
  instTimer = setInterval(poll, 1000);
}

// ---------- database ----------
let dbType = 'mysql';
let dbConnected = false;
document.querySelectorAll('[data-dtype]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-dtype]').forEach((x) => x.classList.toggle('active', x === b));
    dbType = b.dataset.dtype;
    loadDbConfig();
  });
});
async function loadDbConfig() {
  try {
    const j = await (await api('/api/db/' + dbType + '/config')).json();
    const c = j.config || {};
    document.getElementById('db-host').value = c.host || '127.0.0.1';
    document.getElementById('db-port').value = c.port || (dbType === 'mysql' ? 3306 : 5432);
    document.getElementById('db-user').value = c.user || 'root';
    document.getElementById('db-pass').value = c.password || '';
    document.getElementById('db-name').value = c.database || '';
    dbConnected = !!j.connected;
    updateDbStatus();
    if (dbConnected) refreshDb();
  } catch { /* ignore */ }
}
function updateDbStatus() {
  const st = document.getElementById('db-status');
  st.innerHTML = dbConnected ? badgeOk('Connected (' + dbType + ')') : badgeOff('Not connected');
  document.getElementById('db-browser').classList.toggle('hidden', !dbConnected);
  refreshIcons();
}
function dbForm() {
  return {
    host: document.getElementById('db-host').value,
    port: parseInt(document.getElementById('db-port').value, 10),
    user: document.getElementById('db-user').value,
    password: document.getElementById('db-pass').value,
    database: document.getElementById('db-name').value,
  };
}
document.getElementById('db-test').addEventListener('click', async () => {
  const err = document.getElementById('db-err');
  err.textContent = '';
  const r = await api('/api/db/' + dbType + '/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dbForm()),
  });
  const j = await r.json();
  err.textContent = j.ok ? 'Connection OK' : ('Failed: ' + (j.error || ''));
});
document.getElementById('db-connect').addEventListener('click', async () => {
  const err = document.getElementById('db-err');
  err.textContent = '';
  const r = await api('/api/db/' + dbType + '/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dbForm()),
  });
  const j = await r.json();
  if (j.ok) {
    dbConnected = true;
    updateDbStatus();
    refreshDb();
  } else {
    err.textContent = j.error || 'Connection failed';
  }
});
document.getElementById('db-disconnect').addEventListener('click', async () => {
  await api('/api/db/' + dbType + '/disconnect', { method: 'POST' });
  dbConnected = false;
  updateDbStatus();
});
let dbNames = [];
function formatSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
}
function dbMsg(text, isErr) {
  const el = document.getElementById('db-msg');
  el.textContent = text || '';
  el.className = isErr ? 'err' : 'hint';
}
async function loadDbList() {
  try {
    const jj = await (await api('/api/db/' + dbType + '/databases/details')).json();
    const list = jj.databases || [];
    dbNames = list.map((d) => d.name);
    const el = document.getElementById('db-list');
    el.innerHTML = '';
    for (const d of list) {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      const nb = document.createElement('button');
      nb.className = 'font-mono text-[12.5px] text-accent-h underline';
      nb.textContent = d.name;
      nb.addEventListener('click', () => loadDbTables(d.name));
      nameTd.appendChild(nb);
      const tTd = document.createElement('td'); tTd.className = 'muted'; tTd.textContent = d.tables;
      const sTd = document.createElement('td'); sTd.className = 'muted'; sTd.textContent = formatSize(d.size);
      const aTd = document.createElement('td');
      const act = document.createElement('div'); act.className = 'flex flex-wrap gap-1';
      const mkA = (label, fn, danger) => {
        const b = document.createElement('button');
        b.className = danger ? 'btn-ghost btn-sm text-err' : 'btn-ghost btn-sm';
        b.textContent = label;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        act.appendChild(b);
      };
      mkA('Open', () => openPma(d.name));
      mkA('Backup', () => backupDb(d.name));
      mkA('Restore', () => openRestoreModal(d.name));
      mkA('Delete', () => delDb(d.name), true);
      aTd.appendChild(act);
      tr.append(nameTd, tTd, sTd, aTd);
      el.appendChild(tr);
    }
    if (!list.length) el.innerHTML = '<tr><td colspan="4" class="muted">Belum ada database</td></tr>';
  } catch { /* ignore */ }
}
async function loadDbUsers() {
  try {
    const jj = await (await api('/api/db/' + dbType + '/users')).json();
    const el = document.getElementById('db-users');
    el.innerHTML = '';
    for (const u of jj.users || []) {
      const tr = document.createElement('tr');
      const uTd = document.createElement('td'); uTd.className = 'font-mono text-[12.5px]'; uTd.textContent = u.user;
      const hTd = document.createElement('td'); hTd.className = 'muted font-mono text-[12.5px]'; hTd.textContent = u.host;
      const aTd = document.createElement('td');
      const act = document.createElement('div'); act.className = 'flex flex-wrap gap-1';
      const mkA = (label, fn, danger) => {
        const b = document.createElement('button');
        b.className = danger ? 'btn-ghost btn-sm text-err' : 'btn-ghost btn-sm';
        b.textContent = label;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        act.appendChild(b);
      };
      mkA('Password', () => openPwModal(u.user, u.host));
      mkA('Privileges', () => openGrantModal(u.user, u.host));
      mkA('Delete', () => delDbUser(u.user, u.host), true);
      aTd.appendChild(act);
      tr.append(uTd, hTd, aTd);
      el.appendChild(tr);
    }
    if (!(jj.users || []).length) el.innerHTML = '<tr><td colspan="3" class="muted">Belum ada user</td></tr>';
  } catch { /* ignore */ }
}
function refreshDb() { loadDbList(); loadDbUsers(); loadPma(); }
let pmaState = null;
async function loadPma() {
  try {
    const j = await (await api('/api/phpmyadmin')).json();
    pmaState = j;
    const st = document.getElementById('pma-status');
    if (st) {
      if (!j.installed) st.textContent = 'Belum terpasang — klik Pasang (unduh ±16 MB dari phpmyadmin.net, butuh PHP + unzip di Termux).';
      else if (j.running) st.textContent = 'Berjalan di ' + j.url + (j.startedAt ? ' sejak ' + new Date(j.startedAt).toLocaleString() : '');
      else st.textContent = 'Terpasang, sedang berhenti — klik Start untuk menyalakan.';
    }
    const portEl = document.getElementById('pma-port');
    if (portEl) portEl.value = j.port;
    const autoEl = document.getElementById('pma-autostart');
    if (autoEl) autoEl.checked = !!j.autoStart;
    const show = (id, v) => { const el = document.getElementById(id); if (el) el.style.display = v ? '' : 'none'; };
    show('pma-install', !j.installed);
    show('pma-start', j.installed && !j.running);
    show('pma-stop', j.running);
    show('pma-open', j.running);
  } catch { /* ignore */ }
}
function pmaMsg(txt) { const el = document.getElementById('pma-msg'); if (el) el.textContent = txt || ''; }
// Open ala aaPanel: selalu mengarah ke phpMyAdmin (bukan browser internal).
// Browser internal tetap ada lewat klik NAMA database (loadDbTables).
async function openPma(db) {
  if (pmaState && pmaState.running) {
    window.open(pmaState.url + '/index.php?db=' + encodeURIComponent(db), '_blank');
    return;
  }
  if (pmaState && pmaState.installed) {
    // Terpasang tapi berhenti: nyalakan dulu, lalu buka (php -S cepat nyala).
    dbMsg('Menyalakan phpMyAdmin…');
    await pmaAction('/api/phpmyadmin/start', null, '');
    setTimeout(() => {
      if (pmaState && pmaState.running) window.open(pmaState.url + '/index.php?db=' + encodeURIComponent(db), '_blank');
      else dbMsg('phpMyAdmin gagal dinyalakan — cek kartu phpMyAdmin.');
    }, 1000);
    return;
  }
  dbMsg('phpMyAdmin belum terpasang — klik Pasang di kartu phpMyAdmin di bawah.');
  const card = document.getElementById('pma-status');
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function pmaAction(path, body, busyText) {
  pmaMsg(busyText || '');
  try {
    const jj = await (await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
    if (!jj.ok) { pmaMsg(jj.error || 'Gagal'); return; }
    if (jj.warnings && jj.warnings.length) pmaMsg('Peringatan: ' + jj.warnings.join(' '));
    else pmaMsg('');
    await loadPma();
  } catch (e) { pmaMsg('Gagal: ' + e.message); }
}
document.getElementById('pma-install').addEventListener('click', () => {
  const b = document.getElementById('pma-install');
  b.disabled = true;
  pmaAction('/api/phpmyadmin/install', null, 'Mengunduh & memasang phpMyAdmin, tunggu sebentar…').finally(() => { b.disabled = false; });
});
document.getElementById('pma-start').addEventListener('click', () => pmaAction('/api/phpmyadmin/start', null, 'Menyalakan phpMyAdmin…'));
document.getElementById('pma-stop').addEventListener('click', () => pmaAction('/api/phpmyadmin/stop', null, 'Mematikan phpMyAdmin…'));
document.getElementById('pma-open').addEventListener('click', () => { if (pmaState && pmaState.running) window.open(pmaState.url + '/index.php', '_blank'); });
document.getElementById('pma-save').addEventListener('click', () => pmaAction('/api/phpmyadmin/config', {
  port: parseInt(document.getElementById('pma-port').value, 10),
  autoStart: document.getElementById('pma-autostart').checked,
}, 'Menyimpan…'));

async function delDb(name) {
  if (!(await confirmDialog({ title: 'Delete database?', message: 'Hapus database "' + name + '"? Semua data di dalamnya hilang permanen. User-nya tidak ikut dihapus.' }))) return;
  const r = await api('/api/db/' + dbType + '/databases/' + encodeURIComponent(name), { method: 'DELETE' }).catch(() => null);
  const jj = r ? await r.json().catch(() => ({})) : {};
  if (jj.ok) { dbMsg('Database ' + name + ' dihapus'); document.getElementById('db-tables').innerHTML = ''; refreshDb(); }
  else dbMsg('Gagal hapus database: ' + (jj.error || 'Failed'), true);
}
async function backupDb(name) {
  dbMsg('Membuat backup ' + name + '…');
  try {
    const r = await api('/api/db/' + dbType + '/databases/' + encodeURIComponent(name) + '/backup', { method: 'POST' });
    const jj = await r.json();
    if (!jj.ok) { dbMsg('Backup gagal: ' + (jj.error || 'Failed'), true); return; }
    dbMsg('Backup ' + name + ' selesai (' + formatSize(jj.size) + '), mengunduh…');
    window.open('/api/download?path=' + encodeURIComponent('.termux-panel/db-backups') + '&name=' + encodeURIComponent(jj.file), '_blank');
  } catch (e) { dbMsg('Backup gagal: ' + (e.message || 'Failed'), true); }
}
async function delDbUser(user, host) {
  if (!(await confirmDialog({ title: 'Delete user?', message: 'Hapus user "' + user + '@' + host + '"?' }))) return;
  const r = await api('/api/db/' + dbType + '/users/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, host }) }).catch(() => null);
  const jj = r ? await r.json().catch(() => ({})) : {};
  if (jj.ok) { dbMsg('User ' + user + ' dihapus'); refreshDb(); }
  else dbMsg('Gagal hapus user: ' + (jj.error || 'Failed'), true);
}
// ---------- create database (modal, ala aaPanel) ----------
const dbModal = document.getElementById('db-modal');
function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const buf = new Uint32Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (x) => chars[x % chars.length]).join('');
}
function dbHostValue(selectId, customId) {
  const v = document.getElementById(selectId).value;
  if (v !== 'custom') return v;
  return document.getElementById(customId).value.trim();
}
function bindHostSelect(selectId, customId) {
  document.getElementById(selectId).addEventListener('change', (e) => {
    document.getElementById(customId).classList.toggle('hidden', e.target.value !== 'custom');
  });
}
bindHostSelect('db-new-host', 'db-new-host-custom');
bindHostSelect('dbuser-host', 'dbuser-host-custom');
function openDbModal() {
  document.getElementById('db-modal-title').textContent = 'Add Database (' + dbType + ')';
  document.getElementById('db-new-name').value = '';
  document.getElementById('db-with-user').checked = false;
  document.getElementById('db-user-fields').classList.add('hidden');
  document.getElementById('db-new-user').value = '';
  document.getElementById('db-new-pass').value = '';
  document.getElementById('db-new-host').value = 'localhost';
  document.getElementById('db-new-host-custom').classList.add('hidden');
  document.getElementById('db-new-host-custom').value = '';
  document.getElementById('db-host-row').style.display = dbType === 'mysql' ? '' : 'none';
  document.getElementById('db-modal-err').textContent = '';
  dbModal.classList.remove('hidden');
  document.getElementById('db-new-name').focus();
  refreshIcons();
}
function closeDbModal() { dbModal.classList.add('hidden'); }
document.getElementById('db-create').addEventListener('click', openDbModal);
document.getElementById('db-modal-close').addEventListener('click', closeDbModal);
dbModal.addEventListener('click', (e) => { if (e.target === dbModal) closeDbModal(); });
document.getElementById('db-with-user').addEventListener('change', (e) => {
  document.getElementById('db-user-fields').classList.toggle('hidden', !e.target.checked);
  if (e.target.checked && !document.getElementById('db-new-user').value) {
    document.getElementById('db-new-user').value = document.getElementById('db-new-name').value.trim();
  }
});
document.getElementById('db-new-gen').addEventListener('click', () => { document.getElementById('db-new-pass').value = genPassword(); });
async function saveDbModal() {
  const err = document.getElementById('db-modal-err');
  err.textContent = '';
  const name = document.getElementById('db-new-name').value.trim();
  if (!name) { err.textContent = 'Nama database wajib diisi'; return; }
  const body = { name };
  if (document.getElementById('db-with-user').checked) {
    body.user = document.getElementById('db-new-user').value.trim() || name;
    body.password = document.getElementById('db-new-pass').value;
    if (dbType === 'mysql') body.host = dbHostValue('db-new-host', 'db-new-host-custom');
    if (!body.password) { err.textContent = 'Password user wajib diisi (atau klik Generate)'; return; }
  }
  const r = await api('/api/db/' + dbType + '/databases', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const jj = await r.json();
  if (jj.ok) { closeDbModal(); dbMsg('Database ' + name + ' dibuat' + (body.user ? ' + user ' + body.user : '')); refreshDb(); }
  else err.textContent = jj.error || 'Failed';
}
document.getElementById('db-modal-save').addEventListener('click', saveDbModal);
document.getElementById('db-new-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveDbModal(); });
// ---------- add user ----------
const dbuserModal = document.getElementById('dbuser-modal');
function fillDbSelect(sel, includeEmpty) {
  sel.innerHTML = '';
  if (includeEmpty) { const o = document.createElement('option'); o.value = ''; o.textContent = '(tidak diberi hak)'; sel.appendChild(o); }
  for (const d of dbNames) { const o = document.createElement('option'); o.value = d; o.textContent = d; sel.appendChild(o); }
}
function openUserModal() {
  document.getElementById('dbuser-name').value = '';
  document.getElementById('dbuser-pass').value = '';
  document.getElementById('dbuser-host').value = 'localhost';
  document.getElementById('dbuser-host-custom').classList.add('hidden');
  document.getElementById('dbuser-host-custom').value = '';
  document.getElementById('dbuser-host-row').style.display = dbType === 'mysql' ? '' : 'none';
  fillDbSelect(document.getElementById('dbuser-db'), true);
  document.getElementById('dbuser-err').textContent = '';
  dbuserModal.classList.remove('hidden');
  document.getElementById('dbuser-name').focus();
  refreshIcons();
}
function closeUserModal() { dbuserModal.classList.add('hidden'); }
document.getElementById('db-user-add').addEventListener('click', openUserModal);
document.getElementById('dbuser-close').addEventListener('click', closeUserModal);
dbuserModal.addEventListener('click', (e) => { if (e.target === dbuserModal) closeUserModal(); });
document.getElementById('dbuser-gen').addEventListener('click', () => { document.getElementById('dbuser-pass').value = genPassword(); });
document.getElementById('dbuser-save').addEventListener('click', async () => {
  const err = document.getElementById('dbuser-err');
  err.textContent = '';
  const body = {
    username: document.getElementById('dbuser-name').value.trim(),
    password: document.getElementById('dbuser-pass').value,
    database: document.getElementById('dbuser-db').value,
  };
  if (dbType === 'mysql') body.host = dbHostValue('dbuser-host', 'dbuser-host-custom');
  if (!body.username) { err.textContent = 'Username wajib diisi'; return; }
  const r = await api('/api/db/' + dbType + '/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const jj = await r.json();
  if (jj.ok) { closeUserModal(); dbMsg('User ' + body.username + ' dibuat'); refreshDb(); }
  else err.textContent = jj.error || 'Failed';
});
// ---------- change password ----------
let curPwUser = '', curPwHost = '';
const dbpwModal = document.getElementById('dbpw-modal');
function openPwModal(user, host) {
  curPwUser = user; curPwHost = host;
  document.getElementById('dbpw-title').textContent = 'Change Password: ' + user + (host !== '-' ? '@' + host : '');
  document.getElementById('dbpw-pass').value = '';
  document.getElementById('dbpw-err').textContent = '';
  dbpwModal.classList.remove('hidden');
  document.getElementById('dbpw-pass').focus();
  refreshIcons();
}
function closePwModal() { dbpwModal.classList.add('hidden'); }
document.getElementById('dbpw-close').addEventListener('click', closePwModal);
dbpwModal.addEventListener('click', (e) => { if (e.target === dbpwModal) closePwModal(); });
document.getElementById('dbpw-gen').addEventListener('click', () => { document.getElementById('dbpw-pass').value = genPassword(); });
document.getElementById('dbpw-save').addEventListener('click', async () => {
  const err = document.getElementById('dbpw-err');
  err.textContent = '';
  const r = await api('/api/db/' + dbType + '/users/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: curPwUser, host: curPwHost, password: document.getElementById('dbpw-pass').value }) });
  const jj = await r.json();
  if (jj.ok) { closePwModal(); dbMsg('Password user ' + curPwUser + ' diubah'); }
  else err.textContent = jj.error || 'Failed';
});
// ---------- privileges ----------
let curGrantUser = '', curGrantHost = '';
const dbgrantModal = document.getElementById('dbgrant-modal');
function openGrantModal(user, host) {
  curGrantUser = user; curGrantHost = host;
  document.getElementById('dbgrant-title').textContent = 'Privileges: ' + user + (host !== '-' ? '@' + host : '');
  fillDbSelect(document.getElementById('dbgrant-db'), false);
  document.getElementById('dbgrant-err').textContent = '';
  dbgrantModal.classList.remove('hidden');
  refreshIcons();
}
function closeGrantModal() { dbgrantModal.classList.add('hidden'); }
document.getElementById('dbgrant-close').addEventListener('click', closeGrantModal);
dbgrantModal.addEventListener('click', (e) => { if (e.target === dbgrantModal) closeGrantModal(); });
async function grantAct(action) {
  const err = document.getElementById('dbgrant-err');
  err.textContent = '';
  const database = document.getElementById('dbgrant-db').value;
  if (!database) { err.textContent = 'Pilih database dulu'; return; }
  const r = await api('/api/db/' + dbType + '/users/grant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: curGrantUser, host: curGrantHost, database, action }) });
  const jj = await r.json();
  if (jj.ok) { closeGrantModal(); dbMsg((action === 'grant' ? 'Hak penuh diberikan' : 'Hak dicabut') + ' untuk ' + curGrantUser + ' pada ' + database); }
  else err.textContent = jj.error || 'Failed';
}
document.getElementById('dbgrant-grant').addEventListener('click', () => grantAct('grant'));
document.getElementById('dbgrant-revoke').addEventListener('click', () => grantAct('revoke'));
// ---------- restore backup ----------
const dbrestoreModal = document.getElementById('dbrestore-modal');
async function openRestoreModal(prefillDb) {
  document.getElementById('dbrestore-db').value = prefillDb || '';
  document.getElementById('dbrestore-err').textContent = '';
  const sel = document.getElementById('dbrestore-file');
  sel.innerHTML = '';
  try {
    const jj = await (await api('/api/db/backups')).json();
    for (const b of jj.backups || []) { const o = document.createElement('option'); o.value = b.file; o.textContent = b.file + ' (' + formatSize(b.size) + ')'; sel.appendChild(o); }
    if (!(jj.backups || []).length) { const o = document.createElement('option'); o.value = ''; o.textContent = '(belum ada backup)'; sel.appendChild(o); }
  } catch { const o = document.createElement('option'); o.value = ''; o.textContent = '(gagal memuat daftar)'; sel.appendChild(o); }
  dbrestoreModal.classList.remove('hidden');
  refreshIcons();
}
function closeRestoreModal() { dbrestoreModal.classList.add('hidden'); }
document.getElementById('db-restore-open').addEventListener('click', () => openRestoreModal(''));
document.getElementById('dbrestore-close').addEventListener('click', closeRestoreModal);
dbrestoreModal.addEventListener('click', (e) => { if (e.target === dbrestoreModal) closeRestoreModal(); });
document.getElementById('dbrestore-save').addEventListener('click', async () => {
  const err = document.getElementById('dbrestore-err');
  err.textContent = '';
  const database = document.getElementById('dbrestore-db').value.trim();
  const file = document.getElementById('dbrestore-file').value;
  if (!database) { err.textContent = 'Nama database tujuan wajib diisi'; return; }
  if (!file) { err.textContent = 'Pilih file backup dulu'; return; }
  const r = await api('/api/db/' + dbType + '/databases/' + encodeURIComponent(database) + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) });
  const jj = await r.json();
  if (jj.ok) { closeRestoreModal(); dbMsg('Restore ' + file + ' ke ' + database + ' selesai'); refreshDb(); }
  else err.textContent = jj.error || 'Failed';
});
async function loadDbTables(db) {
  try {
    const j = await (await api('/api/db/' + dbType + '/tables?db=' + encodeURIComponent(db))).json();
    const el = document.getElementById('db-tables');
    el.innerHTML = '';
    el.dataset.db = db;
    for (const t of j.tables || []) {
      const b = document.createElement('button');
      b.className = 'list-item';
      b.textContent = t;
      b.addEventListener('click', () => browseTable(db, t));
      el.appendChild(b);
    }
  } catch { /* ignore */ }
}
async function browseTable(db, table) {
  const box = document.getElementById('db-result');
  box.innerHTML = '<p class="muted text-sm">loading…</p>';
  try {
    const j = await (await api('/api/db/' + dbType + '/rows?db=' + encodeURIComponent(db) + '&table=' + encodeURIComponent(table))).json();
    box.innerHTML = renderTable(j.fields || [], j.rows || []);
  } catch (e) {
    box.innerHTML = '<p class="err">' + esc(e.message || 'Failed') + '</p>';
  }
}
function renderTable(fields, rows) {
  if (!rows.length) return '<p class="muted text-sm">0 baris.</p>';
  let html = '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
    fields.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>' + fields.map((c) => '<td class="muted">' + esc(row[c] == null ? 'NULL' : String(row[c])) + '</td>').join('') + '</tr>';
  }
  return html + '</tbody></table></div>';
}
document.getElementById('db-run').addEventListener('click', runQuery);
async function runQuery() {
  const sql = document.getElementById('db-sql').value;
  const box = document.getElementById('db-result');
  box.innerHTML = '<p class="muted text-sm">running…</p>';
  try {
    const r = await api('/api/db/' + dbType + '/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
    const j = await r.json();
    if (j.error && !j.rows) { box.innerHTML = '<p class="err">' + esc(j.error) + '</p>'; return; }
    box.innerHTML = renderTable(j.fields || [], j.rows || []) +
      (j.affected != null ? '<p class="hint">' + j.affected + ' baris terpengaruh</p>' : '');
  } catch (e) {
    box.innerHTML = '<p class="err">' + esc(e.message || 'Failed') + '</p>';
  }
}
// ---------- cron ----------
document.getElementById('cj-preset').addEventListener('change', (e) => {
  const inp = document.getElementById('cj-sched');
  if (e.target.value === 'custom') { inp.disabled = false; inp.value = ''; inp.focus(); }
  else { inp.disabled = true; inp.value = e.target.value; }
});
async function loadCron() {
  try {
    const j = await (await api('/api/cron/status')).json();
    document.getElementById('cron-status').innerHTML = j.running ? badgeOk('crond running') : badgeOff('crond stopped');
    refreshIcons();
  } catch { /* ignore */ }
  try {
    const j = await (await api('/api/cron/jobs')).json();
    const el = document.getElementById('cj-list');
    el.innerHTML = '';
    for (const c of j.jobs || []) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + esc(c.name) + '</td><td class="muted font-mono text-[12.5px]">' + esc(c.schedule) + '</td><td class="muted font-mono text-[12.5px]">' + esc(c.command) + '</td>' +
        '<td>' + (c.enabled ? badgeOk('Enabled') : badgeOff('Stopped')) + '</td>' +
        '<td><div class="row-actions"></div></td>';
      const acts = tr.querySelector('.row-actions');
      const mk = (icn, fn, title) => {
        const b = document.createElement('button');
        b.className = 'mini'; b.innerHTML = ic(icn, 'h-[15px] w-[15px]'); b.title = title;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        acts.appendChild(b);
      };
      mk(c.enabled ? 'pause' : 'play', async () => {
        await api('/api/cron/jobs/' + c.id + '/toggle', { method: 'POST' }).catch(() => {});
        loadCron();
      }, c.enabled ? 'Disable' : 'Enable');
      mk('trash-2', async () => {
        if (!(await confirmDialog({ title: 'Delete cron job?', message: 'Delete job "' + c.name + '"? This cannot be undone.' }))) return;
        await api('/api/cron/jobs/' + c.id, { method: 'DELETE' }).catch(() => {});
        loadCron();
      }, 'Delete');
      el.appendChild(tr);
    }
    if (!(j.jobs || []).length) el.innerHTML = '<tr><td colspan="5" class="muted">No jobs yet</td></tr>';
    refreshIcons();
  } catch { /* ignore */ }
}
async function cronService(action) {
  await api('/api/cron/service', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }).catch(() => {});
  loadCron();
}
document.getElementById('cron-start').addEventListener('click', () => cronService('start'));
document.getElementById('cron-stop').addEventListener('click', () => cronService('stop'));
document.getElementById('cj-add').addEventListener('click', async () => {
  const err = document.getElementById('cj-err');
  err.textContent = '';
  const preset = document.getElementById('cj-preset').value;
  const sched = preset === 'custom' ? document.getElementById('cj-sched').value.trim() : preset;
  const r = await api('/api/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('cj-name').value.trim(),
      schedule: sched,
      command: document.getElementById('cj-cmd').value.trim(),
    }),
  });
  const j = await r.json();
  if (j.ok) { document.getElementById('cj-name').value = ''; document.getElementById('cj-cmd').value = ''; loadCron(); }
  else err.textContent = j.error || 'Failed';
});

// ---------- tunnel (Cloudflare auto tunneling) ----------
let tunnelTimer = null;
function startTunnelPoll() { stopTunnelPoll(); tunnelTimer = setInterval(loadTunnel, 5000); }
function stopTunnelPoll() { if (tunnelTimer) { clearInterval(tunnelTimer); tunnelTimer = null; } }
async function loadTunnel() {
  try {
    const j = await (await api('/api/tunnel')).json();
    const sw = document.getElementById('tun-switch');
    sw.checked = !!(j.running || j.enabled);
    document.getElementById('tun-mode').value = j.mode || 'quick';
    document.getElementById('tun-token-row').style.display = (j.mode === 'token') ? '' : 'none';
    if (j.hostname) document.getElementById('tun-host').value = j.hostname;
    if (j.targetPort) document.getElementById('tun-port').placeholder = 'panel ini (' + j.targetPort + ')';
    const st = document.getElementById('tun-status');
    st.innerHTML = j.running ? (j.url ? badgeOk('Tunnel aktif') : badgeWarn('Tunnel starting…')) : badgeOff('Tunnel mati');
    const urlEl = document.getElementById('tun-url');
    const showUrl = j.url || (j.mode === 'token' && j.hostname ? 'https://' + j.hostname : '');
    urlEl.innerHTML = showUrl ? '<a class="font-mono text-[13px] text-accent-h underline" target="_blank" rel="noopener" href="' + esc(showUrl) + '">' + esc(showUrl) + '</a>' : '<span class="muted text-sm">Belum ada URL publik</span>';
    urlEl.dataset.url = showUrl;
    document.getElementById('tun-log').textContent = j.logs || '—';
    refreshIcons();
  } catch { /* ignore */ }
}
document.getElementById('tun-mode').addEventListener('change', (e) => {
  document.getElementById('tun-token-row').style.display = (e.target.value === 'token') ? '' : 'none';
});
document.getElementById('tun-switch').addEventListener('change', async (e) => {
  const err = document.getElementById('tun-err');
  err.textContent = '';
  if (e.target.checked) {
    const r = await api('/api/tunnel/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: document.getElementById('tun-mode').value,
        targetPort: document.getElementById('tun-port').value.trim(),
        token: document.getElementById('tun-token').value.trim(),
        hostname: document.getElementById('tun-host').value.trim() }),
    });
    const j = await r.json();
    if (!j.ok && j.error) { err.textContent = j.error; e.target.checked = false; }
    else document.getElementById('tun-token').value = '';
  } else {
    await api('/api/tunnel/stop', { method: 'POST' }).catch(() => {});
  }
  loadTunnel();
});
document.getElementById('tun-copy').addEventListener('click', async () => {
  const u = document.getElementById('tun-url').dataset.url || '';
  if (!u) return;
  try { await navigator.clipboard.writeText(u); } catch {
    const t = document.createElement('textarea'); t.value = u; document.body.appendChild(t);
    t.select(); document.execCommand('copy'); t.remove();
  }
});

// ---------- backup ----------
async function loadBackups() {
  try {
    const j = await (await api('/api/backups')).json();
    const el = document.getElementById('bk-list');
    el.innerHTML = '';
    for (const b of j.backups || []) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + esc(b.name) + '</td><td class="muted">' + esc(b.type) + '</td><td class="muted font-mono text-[12.5px]">' + esc(b.source || '—') + '</td><td class="muted">' + fmtSize(b.size || 0) + '</td>' +
        '<td><div class="row-actions"></div></td>';
      const acts = tr.querySelector('.row-actions');
      const mk = (icn, fn, title, danger) => {
        const bEl = document.createElement('button');
        bEl.className = 'mini'; bEl.innerHTML = ic(icn, 'h-[15px] w-[15px]'); bEl.title = title;
        bEl.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        if (danger) bEl.classList.add('text-err', 'border-err/30');
        acts.appendChild(bEl);
      };
      mk('download', () => {
        location.href = '/api/backups/' + encodeURIComponent(b.name) + '/download';
      }, 'Download');
      mk('rotate-ccw', async () => {
        if (!(await confirmDialog({ title: 'Restore backup?', message: 'Restore backup "' + b.name + '"? Current files may be overwritten.', okText: 'Restore', danger: false, icon: 'rotate-ccw' }))) return;
        await api('/api/backups/' + encodeURIComponent(b.name) + '/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }).catch(() => {});
        loadBackups();
      }, 'Restore');
      mk('trash-2', async () => {
        if (!(await confirmDialog({ title: 'Delete backup?', message: 'Delete backup "' + b.name + '"? This cannot be undone.' }))) return;
        await api('/api/backups/' + encodeURIComponent(b.name), { method: 'DELETE' }).catch(() => {});
        loadBackups();
      }, 'Delete', true);
      el.appendChild(tr);
    }
    if (!(j.backups || []).length) el.innerHTML = '<tr><td colspan="5" class="muted">No backups yet</td></tr>';
    refreshIcons();
  } catch { /* ignore */ }
}
document.getElementById('bk-create').addEventListener('click', async () => {
  const err = document.getElementById('bk-err');
  err.textContent = '';
  const r = await api('/api/backups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('bk-name').value.trim(),
      type: document.getElementById('bk-type').value,
      source: document.getElementById('bk-source').value.trim(),
    }),
  });
  const j = await r.json();
  if (j.ok) { document.getElementById('bk-name').value = ''; document.getElementById('bk-source').value = ''; loadBackups(); }
  else err.textContent = j.error || 'Failed';
});

// ---------- settings ----------
async function loadSettings() {
  try {
    const j = await (await api('/api/settings')).json();
    document.getElementById('set-uname').textContent = j.username || '';
    document.getElementById('set-ver').textContent = j.version || '';
    const tg = j.telegram || {};
    document.getElementById('set-tg-token').value = tg.botToken || '';
    document.getElementById('set-tg-chat').value = tg.chatId || '';
    document.getElementById('set-tg-on').checked = !!tg.enabled;
    document.getElementById('set-tg-cmd').checked = tg.commandsEnabled !== false;
  } catch { /* ignore */ }
}
document.getElementById('set-user-save').addEventListener('click', async () => {
  const err = document.getElementById('set-user-err');
  err.textContent = '';
  const r = await api('/api/auth/change-username', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: document.getElementById('set-newuser').value.trim() }),
  });
  const j = await r.json();
  if (j.ok) loadSettings(); else err.textContent = j.error || 'Failed';
});
document.getElementById('set-pw-save').addEventListener('click', async () => {
  const err = document.getElementById('set-pw-err');
  err.textContent = '';
  const nw = document.getElementById('set-pw-new').value;
  if (nw !== document.getElementById('set-pw-conf').value) { err.textContent = 'Password confirmation does not match'; return; }
  const r = await api('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentPassword: document.getElementById('set-pw-old').value,
      newPassword: nw,
      confirmPassword: document.getElementById('set-pw-conf').value,
    }),
  });
  const j = await r.json();
  if (j.ok) {
    document.getElementById('set-pw-old').value = '';
    document.getElementById('set-pw-new').value = '';
    document.getElementById('set-pw-conf').value = '';
    err.textContent = 'Password changed — please log in again';
    setTimeout(() => { location.href = '/login'; }, 1200);
  } else err.textContent = j.error || 'Failed';
});
document.getElementById('set-tg-save').addEventListener('click', async () => {
  const err = document.getElementById('set-tg-err');
  err.textContent = '';
  const r = await api('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telegram: {
        botToken: document.getElementById('set-tg-token').value.trim(),
        chatId: document.getElementById('set-tg-chat').value.trim(),
        enabled: document.getElementById('set-tg-on').checked,
        commandsEnabled: document.getElementById('set-tg-cmd').checked,
      },
    }),
  });
  const j = await r.json();
  if (!j.ok) err.textContent = j.error || 'Failed';
});
document.getElementById('set-tg-test').addEventListener('click', async () => {
  const err = document.getElementById('set-tg-err');
  err.textContent = 'sending…';
  const r = await api('/api/settings/test-telegram', { method: 'POST' });
  const j = await r.json();
  err.textContent = j.ok ? 'Test message sent' : (j.error || 'Failed');
});
document.getElementById('set-logout-all').addEventListener('click', async () => {
  if (!(await confirmDialog({ title: 'Log out all sessions?', message: 'End all active sessions on every device. You will need to log in again.', okText: 'Log out all', danger: false, icon: 'log-out' }))) return;
  await api('/api/auth/logout-all', { method: 'POST' }).catch(() => {});
  location.href = '/login';
});

// ---------- init ----------
document.querySelectorAll('.btn-theme').forEach((b) => {
  b.addEventListener('click', () => applyTheme(getTheme() === 'light' ? 'dark' : 'light'));
});
updateThemeUI(getTheme());
document.getElementById('cj-preset').dispatchEvent(new Event('change'));
loadFiles();
loadSites();

// ---------- boot ----------
// showTab menyuntikkan markup baru, jadi konversi ikon dilakukan SESUDAHNYA
showTab(tabFromPath(), false);
refreshIcons();

// ---------- AI Chat (ala opencode CLI) ----------
let aiMessages = [];
// Always Allow: sekali diklik di bubble approval, semua approval exec/write
// berikutnya jalan otomatis TANPA bubble, sampai halaman di-reload.
let aiAlwaysAllow = false;
function aiSetAlwaysAllow(v) {
  aiAlwaysAllow = !!v;
  const ind = document.getElementById('ai-always-allow-ind');
  if (ind) ind.classList.toggle('hidden', !aiAlwaysAllow);
}
try { aiMessages = JSON.parse(localStorage.getItem('terwo-ai-chat') || '[]').filter((m) => m && (m.role === 'user' || m.role === 'assistant')); } catch { aiMessages = []; }
let aiSavedModel = '';
let aiAbort = null;
function aiSaveLocal() { try { localStorage.setItem('terwo-ai-chat', JSON.stringify(aiMessages.slice(-100))); } catch {} }
function renderAiMessages() {
  const el = document.getElementById('ai-messages');
  el.innerHTML = '';
  for (const m of aiMessages) {
    const d = document.createElement('div');
    d.className = 'rounded-xl px-3 py-2 text-sm whitespace-pre-wrap';
    if (m.role === 'user') { d.style.cssText = 'align-self:flex-end;background:var(--accent);color:#fff;max-width:85%'; }
    else { d.style.cssText = 'align-self:flex-start;background:var(--surface2);max-width:85%'; }
    d.textContent = m.content;
    el.appendChild(d);
  }
  el.scrollTop = el.scrollHeight;
}
function aiMsg(text, isErr) {
  const el = document.getElementById('ai-msg');
  el.textContent = text || '';
  el.className = isErr ? 'err' : 'hint';
}
async function loadAiConfig() {
  try {
    const jj = await (await api('/api/ai/config')).json();
    document.getElementById('ai-endpoint').value = jj.endpoint || '';
    document.getElementById('ai-key-state').textContent = jj.hasKey ? 'API key tersimpan (kosongkan kolom key bila tidak ingin mengubahnya)' : 'API key belum diatur';
    aiSavedModel = jj.model || '';
    const sel = document.getElementById('ai-model');
    sel.innerHTML = '';
    if (aiSavedModel) { const o = document.createElement('option'); o.value = aiSavedModel; o.textContent = aiSavedModel; sel.appendChild(o); }
    document.getElementById('ai-chat-model').textContent = aiSavedModel ? 'Model: ' + aiSavedModel : 'Model belum diatur — isi Settings AI dulu';
    renderAiMessages();
  } catch { /* ignore */ }
}
document.getElementById('ai-fetch').addEventListener('click', async () => {
  const err = document.getElementById('ai-err');
  err.textContent = '';
  aiMsg('Mengambil daftar model…');
  try {
    const r = await api('/api/ai/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: document.getElementById('ai-endpoint').value.trim(), apiKey: document.getElementById('ai-key').value }) });
    const jj = await r.json();
    if (!jj.models) { err.textContent = jj.error || 'Fetch models gagal'; aiMsg(''); return; }
    const sel = document.getElementById('ai-model');
    sel.innerHTML = '';
    for (const m of jj.models) { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); }
    if (aiSavedModel && jj.models.includes(aiSavedModel)) sel.value = aiSavedModel;
    aiMsg(jj.models.length + ' model ditemukan' + (jj.models.length ? '' : ' — endpoint ini tidak mengembalikan daftar model, ketik manual saja'));
  } catch (e) { err.textContent = e.message || 'Fetch models gagal'; aiMsg(''); }
});
document.getElementById('ai-save').addEventListener('click', async () => {
  const err = document.getElementById('ai-err');
  err.textContent = '';
  const model = document.getElementById('ai-model-custom').value.trim() || document.getElementById('ai-model').value;
  const r = await api('/api/ai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: document.getElementById('ai-endpoint').value.trim(), apiKey: document.getElementById('ai-key').value, model }) });
  const jj = await r.json();
  if (jj.ok) {
    aiSavedModel = jj.model;
    document.getElementById('ai-key').value = '';
    document.getElementById('ai-model-custom').value = '';
    document.getElementById('ai-key-state').textContent = 'API key tersimpan (kosongkan kolom key bila tidak ingin mengubahnya)';
    document.getElementById('ai-chat-model').textContent = 'Model: ' + jj.model;
    aiMsg('Settings AI tersimpan');
  } else { err.textContent = jj.error || 'Save gagal'; aiMsg(''); }
});
document.getElementById('ai-new').addEventListener('click', () => { aiMessages = []; aiSaveLocal(); renderAiMessages(); });
document.getElementById('ai-always-allow-ind').addEventListener('click', () => aiSetAlwaysAllow(false));
document.getElementById('ai-stop').addEventListener('click', () => { if (aiAbort) aiAbort.abort(); });
async function aiSend() {
  if (document.getElementById('ai-agent-mode').checked) return aiSendAgent();
  const inp = document.getElementById('ai-input');
  const text = inp.value.trim();
  if (!text || aiAbort) return;
  aiMessages.push({ role: 'user', content: text });
  aiMessages.push({ role: 'assistant', content: '' });
  inp.value = '';
  renderAiMessages();
  const bubbles = document.getElementById('ai-messages').children;
  const ab = bubbles[bubbles.length - 1];
  const sendBtn = document.getElementById('ai-send');
  const stopBtn = document.getElementById('ai-stop');
  sendBtn.disabled = true;
  stopBtn.classList.remove('hidden');
  aiAbort = new AbortController();
  try {
    const r = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: aiMessages.slice(0, -1) }), signal: aiAbort.signal });
    if (!r.ok) {
      const jj = await r.json().catch(() => ({}));
      throw new Error(jj.error || ('Chat gagal (' + r.status + ')'));
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let acc = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let pj;
          try { pj = JSON.parse(payload); } catch { continue; }
          if (pj.error) throw new Error(pj.error);
          const d = pj.data || pj;
          const delta = (d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content) || (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
          if (delta) { acc += delta; ab.textContent = acc; document.getElementById('ai-messages').scrollTop = document.getElementById('ai-messages').scrollHeight; }
        }
      }
    }
    aiMessages[aiMessages.length - 1].content = acc || '(tidak ada jawaban dari model)';
    if (!acc) ab.textContent = aiMessages[aiMessages.length - 1].content;
  } catch (e) {
    if (e.name === 'AbortError') { aiMessages[aiMessages.length - 1].content += ' [dihentikan]'; }
    else { aiMessages[aiMessages.length - 1].content = 'Error: ' + (e.message || 'Chat gagal'); }
    ab.textContent = aiMessages[aiMessages.length - 1].content;
  } finally {
    aiSaveLocal();
    aiAbort = null;
    sendBtn.disabled = false;
    stopBtn.classList.add('hidden');
  }
}
document.getElementById('ai-send').addEventListener('click', aiSend);
document.getElementById('ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(); } });

// ---------- AI Agent mode ----------
function aiAppendBubble(role, content) {
  const el = document.getElementById('ai-messages');
  const d = document.createElement('div');
  d.className = 'rounded-xl px-3 py-2 text-sm whitespace-pre-wrap';
  if (role === 'user') d.style.cssText = 'align-self:flex-end;background:var(--accent);color:#fff;max-width:85%';
  else if (role === 'tool') d.style.cssText = 'align-self:flex-start;background:var(--surface2);max-width:85%;border:1px dashed var(--border)';
  else d.style.cssText = 'align-self:flex-start;background:var(--surface2);max-width:85%';
  d.textContent = content;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
  return d;
}
async function aiReadAgentStream(r, runTexts) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.type === 'text') { runTexts.push(ev.content || ''); aiAppendBubble('assistant', ev.content || ''); }
        else if (ev.type === 'tool') { aiAppendBubble('tool', '🔧 ' + ev.tool + ' ' + JSON.stringify(ev.args || {}) + '\n' + String(ev.result || '').slice(0, 1000)); }
        else if (ev.type === 'approval') {
          if (aiAlwaysAllow) {
            const rr = await fetch('/api/ai/agent/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: ev.runId, approved: true }), signal: aiAbort ? aiAbort.signal : undefined });
            if (!rr.ok) { const jj = await rr.json().catch(() => ({})); throw new Error(jj.error || ('Approve gagal (' + rr.status + ')')); }
            await aiReadAgentStream(rr, runTexts);
            return;
          }
          const box = document.getElementById('ai-messages');
          const d = document.createElement('div');
          d.className = 'rounded-xl px-3 py-2 text-sm';
          d.style.cssText = 'align-self:flex-start;background:var(--surface2);max-width:85%;border:1px solid var(--warn, #f59e0b)';
          const title = document.createElement('div');
          title.textContent = '⚠️ Perlu approval: ' + ev.tool;
          const pre = document.createElement('div');
          pre.className = 'whitespace-pre-wrap font-mono text-[12.5px] mt-1';
          pre.textContent = JSON.stringify(ev.args || {}, null, 2);
          const row = document.createElement('div');
          row.className = 'flex gap-2 mt-2';
          const mkB = (label, cls) => { const b = document.createElement('button'); b.className = cls; b.textContent = label; row.appendChild(b); return b; };
          const allowB = mkB('Allow', 'btn btn-sm');
          const alwaysB = mkB('Always Allow', 'btn-ghost btn-sm');
          const denyB = mkB('Deny', 'btn-ghost btn-sm');
          const stopB = mkB('Stop run', 'btn-ghost btn-sm text-err');
          d.append(title, pre, row);
          box.appendChild(d);
          box.scrollTop = box.scrollHeight;
          const decision = await new Promise((resolve) => {
            const lock = () => { allowB.disabled = alwaysB.disabled = denyB.disabled = stopB.disabled = true; };
            allowB.onclick = () => { lock(); resolve(true); };
            alwaysB.onclick = () => { lock(); resolve('always'); };
            denyB.onclick = () => { lock(); resolve(false); };
            stopB.onclick = () => { lock(); resolve('stop'); };
          });
          if (decision === 'always') { aiSetAlwaysAllow(true); }
          if (decision === 'stop') { const e = new Error('Agent dihentikan user'); e.name = 'AgentStopped'; throw e; }
          const rr = await fetch('/api/ai/agent/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: ev.runId, approved: decision === 'always' ? true : decision }), signal: aiAbort ? aiAbort.signal : undefined });
          if (!rr.ok) { const jj = await rr.json().catch(() => ({})); throw new Error(jj.error || ('Approve gagal (' + rr.status + ')')); }
          await aiReadAgentStream(rr, runTexts);
          return;
        }
        else if (ev.type === 'done') { if (ev.note) aiAppendBubble('assistant', ev.note); return; }
        else if (ev.type === 'error') { throw new Error(ev.error || 'Agent gagal'); }
      }
    }
  }
}
async function aiSendAgent() {
  const inp = document.getElementById('ai-input');
  const text = inp.value.trim();
  if (!text || aiAbort) return;
  aiMessages.push({ role: 'user', content: text });
  aiAppendBubble('user', text);
  inp.value = '';
  const sendBtn = document.getElementById('ai-send');
  const stopBtn = document.getElementById('ai-stop');
  sendBtn.disabled = true;
  stopBtn.classList.remove('hidden');
  aiAbort = new AbortController();
  const runTexts = [];
  try {
    const r = await fetch('/api/ai/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: aiMessages }), signal: aiAbort.signal });
    if (!r.ok) { const jj = await r.json().catch(() => ({})); throw new Error(jj.error || ('Agent gagal (' + r.status + ')')); }
    await aiReadAgentStream(r, runTexts);
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'AgentStopped') aiAppendBubble('assistant', '[agent dihentikan]');
    else aiAppendBubble('assistant', 'Error: ' + (e.message || 'Agent gagal'));
  } finally {
    if (runTexts.length) aiMessages.push({ role: 'assistant', content: runTexts.join('\n') });
    aiSaveLocal();
    aiAbort = null;
    sendBtn.disabled = false;
    stopBtn.classList.add('hidden');
  }
}

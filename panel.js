#!/usr/bin/env node
'use strict';
/*
 * Terwo v1.13.0
 * Simple web panel for Termux: File Manager + Terminal + System Info.
 *
 * Keamanan bawaan:
 *  - Login password (hash PBKDF2), session cookie HttpOnly
 *  - File manager dikurung di dalam PANEL_ROOT (default $HOME)
 *  - Default hanya listen di 127.0.0.1 (localhost)
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, exec } = require('child_process');

let WebSocket;
try {
  WebSocket = require('ws');
} catch (e) {
  console.error('ERROR: module "ws" is not installed.\nRun first: npm install');
  process.exit(1);
}

// ================= Konfigurasi =================
const HOME = os.homedir();
const ROOT = path.resolve(process.env.PANEL_ROOT || HOME);
// Satu sumber kebenaran untuk versi: package.json
const VERSION = (function () {
  try { return require('./package.json').version; } catch (e) { return '0.0.0'; }
})();
const DATA_DIR = path.join(HOME, '.termux-panel');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PORT = parseInt(process.env.PANEL_PORT || '8080', 10);
const HOST = process.env.PANEL_HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = 50 * 1024 * 1024; // 50 MB
const sessions = new Map(); // token -> { created }

function hashPassword(pw, salt) {
  return crypto.pbkdf2Sync(pw, salt, 120000, 32, 'sha256').toString('hex');
}

function randAlnum(n) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += chars[b[i] % chars.length];
  return s;
}
function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!cfg.username) {
      cfg.username = 'admin';
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      console.log('INFO: default username "admin" added (change it in the Settings menu).');
    }
    return cfg;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const username = randAlnum(8);
  const password = crypto.randomBytes(12).toString('base64url');
  const cfg = { username, salt, hash: hashPassword(password, salt) };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  const line = '='.repeat(46);
  console.log('');
  console.log('  ' + line);
  console.log('  Terwo — initial access');
  console.log('  ' + line);
  console.log('  URL      : http://' + HOST + ':' + PORT);
  console.log('  Username : ' + username);
  console.log('  Password : ' + password);
  console.log('  ' + line);
  console.log('  Save these well, change them in the Settings menu after login.');
  console.log('');
  return cfg;
}
let config = loadConfig();


function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ================= Helper =================
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Sesi kedaluwarsa mengikuti Max-Age cookie (24 jam)
const SESSION_TTL = 86400 * 1000;
function isAuthed(req) {
  const c = parseCookies(req);
  if (!c.tpsid) return false;
  const s = sessions.get(c.tpsid);
  if (!s) return false;
  if (Date.now() - s.created > SESSION_TTL) { sessions.delete(c.tpsid); return false; }
  return true;
}
// Bersihkan token kedaluwarsa agar Map tidak tumbuh tanpa batas
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.created > SESSION_TTL) sessions.delete(t);
}, 3600 * 1000).unref();

// Pastikan path hasil selalu di dalam ROOT (cegah path traversal)
function safePath(rel) {
  const p = path.resolve(ROOT, rel || '.');
  if (p !== ROOT && !p.startsWith(ROOT + path.sep)) {
    throw new Error('Access outside working directory denied');
  }
  return p;
}

// Single file/folder name: reject path separators
function safeName(name) {
  if (!name || typeof name !== 'string') throw new Error('Invalid name');
  const n = name.trim();
  if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\\') || n.includes('\0')) {
    throw new Error('Invalid name');
  }
  return n;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers));
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function servePublic(res, filename) {
  try {
    const data = await fsp.readFile(path.join(PUBLIC_DIR, filename));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function relOf(abs) {
  const r = path.relative(ROOT, abs);
  return r === '' ? '' : r;
}

// ================= API: file manager =================
async function apiFiles(url, res) {
  const dir = safePath(url.searchParams.get('path') || '');
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.termux-panel') {
      // show dotfiles too, no problem
    }
    const full = path.join(dir, e.name);
    let size = 0, mtime = 0;
    try {
      const st = await fsp.stat(full);
      size = st.size; mtime = st.mtimeMs;
    } catch { /* ignore */ }
    out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', size, mtime });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  sendJson(res, 200, { path: relOf(dir), entries: out });
}

async function apiMkdir(req, res) {
  const { path: rel, name } = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  await fsp.mkdir(path.join(safePath(rel || ''), safeName(name)), { recursive: true });
  sendJson(res, 200, { ok: true });
}

async function apiTouch(req, res) {
  const { path: rel, name } = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const full = path.join(safePath(rel || ''), safeName(name));
  const fh = await fsp.open(full, 'wx').catch(() => null);
  if (fh) await fh.close();
  sendJson(res, 200, { ok: true });
}

async function apiRename(req, res) {
  const { path: rel, from, to } = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const dir = safePath(rel || '');
  await fsp.rename(path.join(dir, safeName(from)), path.join(dir, safeName(to)));
  sendJson(res, 200, { ok: true });
}

async function apiDelete(req, res) {
  const { path: rel, name } = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  await fsp.rm(path.join(safePath(rel || ''), safeName(name)), { recursive: true, force: true });
  sendJson(res, 200, { ok: true });
}

async function apiRead(req, res) {
  const { path: rel, name } = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const full = path.join(safePath(rel || ''), safeName(name));
  const st = await fsp.stat(full);
  if (st.size > 1024 * 1024) throw new Error('File too large to edit (max 1 MB)');
  const content = await fsp.readFile(full, 'utf8');
  sendJson(res, 200, { ok: true, content });
}

async function apiWrite(req, res) {
  const { path: rel, name, content } = JSON.parse((await readBody(req, 10 * 1024 * 1024)).toString('utf8'));
  if (typeof content !== 'string') throw new Error('Invalid content');
  await fsp.writeFile(path.join(safePath(rel || ''), safeName(name)), content, 'utf8');
  sendJson(res, 200, { ok: true });
}

async function apiUpload(req, res) {
  const { path: rel, name, data } = JSON.parse((await readBody(req, MAX_UPLOAD + 1024 * 1024)).toString('utf8'));
  const buf = Buffer.from(data, 'base64');
  if (buf.length > MAX_UPLOAD) throw new Error('File too large (max 50 MB)');
  await fsp.writeFile(path.join(safePath(rel || ''), safeName(name)), buf);
  sendJson(res, 200, { ok: true, size: buf.length });
}

async function apiDownload(url, res) {
  const rel = url.searchParams.get('path') || '';
  const name = safeName(url.searchParams.get('name') || '');
  const full = path.join(safePath(rel), name);
  const st = await fsp.stat(full);
  if (!st.isFile()) throw new Error('Not a file');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': 'attachment; filename="' + name.replace(/"/g, '') + '"',
  });
  fs.createReadStream(full).pipe(res);
}

async function apiChpasswd(req, res) {
  const { old, new: nw } = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  if (!old || hashPassword(old, config.salt) !== config.hash) {
    return sendJson(res, 401, { error: 'Password lama salah' });
  }
  if (!nw || nw.length < 6) return sendJson(res, 400, { error: 'Password baru minimal 6 karakter' });
  config.salt = crypto.randomBytes(16).toString('hex');
  config.hash = hashPassword(nw, config.salt);
  saveConfig();
  sessions.clear(); // paksa login ulang di semua sesi
  sendJson(res, 200, { ok: true });
}

function apiSysinfo(res) {
  sendJson(res, 200, {
    hostname: os.hostname(),
    platform: os.platform() + ' ' + os.arch(),
    uptime: Math.floor(os.uptime()),
    freemem: os.freemem(),
    totalmem: os.totalmem(),
    loadavg: os.loadavg().map((n) => +n.toFixed(2)),
    root: ROOT,
  });
}

// ================= Website hosting (Node.js & PHP) =================
const SITES_FILE = path.join(DATA_DIR, 'sites.json');
let sites = [];
function loadSites() {
  try { sites = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); }
  catch { sites = []; }
}
function saveSites() {
  fs.writeFileSync(SITES_FILE, JSON.stringify(sites, null, 2), { mode: 0o600 });
}
loadSites();
const running = new Map(); // id -> { child, logs[], type, started }
const deadLogs = new Map(); // id -> string log terakhir setelah proses berhenti

function siteById(id) {
  return sites.find((s) => s.id === id);
}

function pushLog(id, line) {
  const r = running.get(id);
  if (!r) return;
  r.logs.push(line);
  if (r.logs.length > 300) r.logs.splice(0, r.logs.length - 300);
}

async function apiSitesList(res) {
  sendJson(res, 200, {
    sites: sites.map((s) => {
      const copy = Object.assign({}, s, { running: running.has(s.id) });
      delete copy.tunnel; // token tunnel tidak pernah keluar lewat API
      if (s.tunnel) {
        copy.tunnel = { enabled: !!s.tunnel.enabled, mode: s.tunnel.mode || 'quick',
          hostname: s.tunnel.hostname || '', hasToken: !!s.tunnel.token,
          running: siteTunnelRunning(s.id), url: siteTunnelUrl(s.id) };
      }
      return copy;
    }),
  });
}

async function apiSiteCreate(req, res) {
  const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const name = (body.name || '').trim();
  const type = body.type;
  if (!name) throw new Error('Name is required');
  if (type !== 'node' && type !== 'php' && type !== 'static' && type !== 'go') throw new Error('Type must be nodejs, php, static, or go');
  const portNum = parseInt(body.port, 10);
  if (!portNum || portNum < 1024 || portNum > 65535) throw new Error('Port must be 1024–65535');
  if (sites.some((s) => s.port === portNum)) throw new Error('Port is already used by another website');
  const full = safePath(body.path || '.');
  const st = await fsp.stat(full).catch(() => null);
  if (!st) throw new Error('Path not found');
  if (type === 'node' && !st.isFile()) throw new Error('For Node.js, path must be a file (e.g. server.js)');
  if (type === 'php' && !st.isDirectory()) throw new Error('For PHP, path must be a document root folder');
  if (type === 'static' && !st.isDirectory()) throw new Error('For Static, path must be a folder');
  if (type === 'go' && !st.isDirectory()) throw new Error('For Go, path must be a project folder');
  const site = {
    id: crypto.randomBytes(8).toString('hex'),
    name, type, path: relOf(full), port: portNum, created: Date.now(),
    autoStart: false, // jadi true saat site di-Start (Start = auto-start saat panel restart)
  };
  sites.push(site);
  saveSites();
  sendJson(res, 200, { ok: true, site });
}

async function doSiteStart(site) {
  const id = site.id;
  if (running.has(id)) throw new Error('Already running');
  const full = safePath(site.path);
  if (site.type === 'static') {
    const hasPy = await execCheck('command -v python3 >/dev/null 2>&1');
    if (!hasPy) throw new Error('Install python first via the Store menu');
  }
  if (site.type === 'go') {
    const hasGo = await execCheck('command -v go >/dev/null 2>&1');
    if (!hasGo) throw new Error('Install Go first via the Store menu');
  }
  let child;
  if (site.type === 'node') {
    child = spawn('node', [full], {
      cwd: path.dirname(full),
      env: Object.assign({}, process.env, { PORT: String(site.port) }),
    });
  } else if (site.type === 'php') {
    child = spawn('php', ['-S', '127.0.0.1:' + site.port, '-t', full], { cwd: full });
  } else if (site.type === 'static') {
    child = spawn('python3', ['-m', 'http.server', String(site.port), '--directory', full], {
      cwd: full,
      env: Object.assign({}, process.env, { PORT: String(site.port) }),
    });
  } else {
    child = spawn('go', ['run', '.'], {
      cwd: full,
      env: Object.assign({}, process.env, { PORT: String(site.port) }),
    });
  }
  running.set(id, { child, logs: [], type: site.type, started: Date.now() });
  deadLogs.delete(id);
  pushLog(id, '--- start (' + site.type + ') port ' + site.port + ' ---\n');
  child.stdout.on('data', (d) => pushLog(id, d.toString('utf8')));
  child.stderr.on('data', (d) => pushLog(id, d.toString('utf8')));
  const finish = () => {
    const r = running.get(id);
    if (r) deadLogs.set(id, r.logs.join(''));
    running.delete(id);
    // Site mati (crash/exit) = tunnel-nya ikut mati, tapi flag enabled
    // dipertahankan supaya site yang di-Restart kembali men-tunnel.
    try { stopSiteTunnel(id, false); } catch {}
  };
  child.on('exit', (code) => { pushLog(id, '--- berhenti (exit ' + code + ') ---\n'); finish(); });
  child.on('error', (e) => { pushLog(id, '--- failed to start: ' + e.message + ' ---\n'); finish(); });
}

async function apiSiteStart(req, res, id) {
  const site = siteById(id);
  if (!site) throw new Error('Website not found');
  await doSiteStart(site);
  site.autoStart = true; saveSites();
  if (site.tunnel && site.tunnel.enabled) {
    try { await startSiteTunnel(site); }
    catch (e) { console.log('Site tunnel failed (' + site.name + '): ' + e.message); }
  }
  sendJson(res, 200, { ok: true });
}

async function apiSiteStop(req, res, id) {
  const site = siteById(id);
  if (!site) throw new Error('Website not found');
  const rec = running.get(id);
  if (!rec) throw new Error('Not running');
  try { rec.child.kill(); } catch { /* ignore */ }
  running.delete(id);
  site.autoStart = false; saveSites();
  try { stopSiteTunnel(id, false); } catch {}
  sendJson(res, 200, { ok: true });
}

async function apiSiteRestart(req, res, id) {
  const rec = running.get(id);
  if (rec) {
    try { rec.child.kill(); } catch { /* ignore */ }
    running.delete(id);
    await new Promise((r) => setTimeout(r, 500));
  }
  return apiSiteStart(req, res, id);
}

async function apiSiteDelete(req, res, id) {
  try { stopSiteTunnel(id, true); } catch {}
  // Site mode auto: cabut route + DNS-nya dari Cloudflare (best-effort).
  const delSite = siteById(id);
  if (delSite && delSite.tunnel && delSite.tunnel.mode === 'auto' && delSite.tunnel.hostname) {
    try { await cfUnpublishSiteDomain(delSite); } catch (e) { console.log('CF unpublish on delete failed: ' + e.message); }
  }
  const rec = running.get(id);
  if (rec) {
    try { rec.child.kill(); } catch { /* ignore */ }
    running.delete(id);
  }
  sites = sites.filter((s) => s.id !== id);
  deadLogs.delete(id);
  saveSites();
  sendJson(res, 200, { ok: true });
}

function apiSiteLogs(res, id) {
  const rec = running.get(id);
  sendJson(res, 200, {
    logs: rec ? rec.logs.join('') : (deadLogs.get(id) || ''),
    running: !!rec,
  });
}

// ================= Install Center =================
// Install Termux packages via pkg/npm, logs stream live to the frontend.
const INSTALL_ITEMS = [
  { id: 'nginx', name: 'Nginx', desc: 'Web server & reverse proxy', bin: 'nginx', cmd: 'pkg install -y nginx' },
  { id: 'nodejs', name: 'Node.js', desc: 'Runtime JavaScript', bin: 'node', cmd: 'pkg install -y nodejs', forcedInstalled: true },
  { id: 'nvm', name: 'NVM', desc: 'Node Version Manager', check: '[ -f "$HOME/.nvm/nvm.sh" ]', cmd: 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash' },
  { id: 'pm2', name: 'PM2', desc: 'Process manager Node.js', bin: 'pm2', cmd: 'npm install -g pm2' },
  { id: 'mysql', name: 'MySQL (MariaDB)', desc: 'Database server MySQL', bin: 'mysqld', cmd: 'pkg install -y mariadb' },
  { id: 'postgres', name: 'PostgreSQL', desc: 'Database server PostgreSQL', bin: 'postgres', cmd: 'pkg install -y postgresql' },
  { id: 'php', name: 'PHP', desc: 'Interpreter PHP', bin: 'php', cmd: 'pkg install -y php' },
  { id: 'bun', name: 'Bun', desc: 'Fast JS runtime', check: 'command -v bun >/dev/null 2>&1 || [ -f "$HOME/.bun/bin/bun" ]', cmd: 'curl -fsSL https:/' + '/bun.sh/install | bash' },
  { id: 'redis', name: 'Redis', desc: 'In-memory database & cache', bin: 'redis-server', cmd: 'pkg install -y redis' },
  { id: 'python', name: 'Python', desc: 'Interpreter Python', bin: 'python', cmd: 'pkg install -y python' },
  { id: 'golang', name: 'Go', desc: 'Go programming language', bin: 'go', cmd: 'pkg install -y golang' },
  { id: 'cronie', name: 'Cronie', desc: 'Cron daemon (scheduled jobs)', bin: 'crond', cmd: 'pkg install -y cronie' },
  { id: '9router', name: '9Router', desc: 'AI model gateway (OpenAI-compatible)', bin: '9router', cmd: 'npm install -g 9router' },
  { id: 'hermes', name: 'Hermes Agent', desc: 'AI coding agent CLI', bin: 'hermes', cmd: 'curl -fsSL https://hermes-agent.' + 'nousresearch.com/install.sh | bash' },
  { id: 'cloudflared', name: 'Cloudflared', desc: 'Cloudflare Tunnel', bin: 'cloudflared', cmd: 'pkg install -y cloudflared' },
  { id: 'zip', name: 'Zip', desc: 'ZIP archives (used by file manager & backup)', bin: 'zip', cmd: 'pkg install -y zip' },
  { id: 'unzip', name: 'Unzip', desc: 'Extract ZIP (used by file manager & backup)', bin: 'unzip', cmd: 'pkg install -y unzip' },
  { id: 'openssh', name: 'OpenSSH', desc: 'SSH server & client (sshd port 8022)', bin: 'sshd', cmd: 'pkg install -y openssh' },
  { id: 'termux-api', name: 'Termux:API', desc: 'Phone sensors & features (battery, notifications)', bin: 'termux-battery-status', cmd: 'pkg install -y termux-api' },
  { id: 'git', name: 'Git', desc: 'Version control system', bin: 'git', cmd: 'pkg install -y git' },
  { id: 'tmux', name: 'Tmux', desc: 'Terminal multiplexer', bin: 'tmux', cmd: 'pkg install -y tmux' },
  { id: 'composer', name: 'Composer', desc: 'Package manager PHP', bin: 'composer', cmd: 'pkg install -y composer' },
  { id: 'sqlite', name: 'SQLite', desc: 'Lightweight serverless database', bin: 'sqlite3', cmd: 'pkg install -y sqlite' },
  { id: 'ffmpeg', name: 'FFmpeg', desc: 'Video & audio processing', bin: 'ffmpeg', cmd: 'pkg install -y ffmpeg' },
  { id: 'yt-dlp', name: 'yt-dlp', desc: 'Video & audio downloader', bin: 'yt-dlp', cmd: 'pkg install -y yt-dlp' },
  { id: 'rsync', name: 'Rsync', desc: 'File sync & backup', bin: 'rsync', cmd: 'pkg install -y rsync' },
];
const installRuns = new Map(); // id -> { child, logs[], running, exitCode }
function execCheck(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { shell: SHELL, env: EXEC_ENV, timeout: 8000 }, (err) => resolve(!err));
  });
}

async function apiInstallList(res) {
  const items = [];
  for (const it of INSTALL_ITEMS) {
    const installed = it.forcedInstalled ? true : await execCheck(it.check || ('command -v ' + it.bin + ' >/dev/null 2>&1'));
    const rec = installRuns.get(it.id);
    items.push({ id: it.id, name: it.name, desc: it.desc, installed,
      installing: !!(rec && rec.running) });
  }
  sendJson(res, 200, { items });
}

async function apiInstallStart(req, res, id) {
  const item = INSTALL_ITEMS.find((x) => x.id === id);
  if (!item) throw new Error('Unknown package');
  const rec = installRuns.get(id);
  if (rec && rec.running) throw new Error('Installation already running');
  const child = spawn('bash', ['-c', item.cmd], { cwd: HOME });
  const nr = { child, logs: [], running: true, exitCode: null };
  installRuns.set(id, nr);
  const push = (s) => { nr.logs.push(s); if (nr.logs.length > 500) nr.logs.splice(0, nr.logs.length - 500); };
  push('$ ' + item.cmd + '\n');
  child.stdout.on('data', (d) => push(d.toString('utf8')));
  child.stderr.on('data', (d) => push(d.toString('utf8')));
  child.on('exit', (code) => { nr.running = false; nr.exitCode = code; push('\n--- selesai (exit ' + code + ') ---\n'); sendTelegram((code === 0 ? '✅' : '❌') + ' Install ' + item.name + ' finished (exit ' + code + ')'); });
  child.on('error', (e) => { nr.running = false; nr.exitCode = -1; push('\n--- failed: ' + e.message + ' ---\n'); });
  sendJson(res, 200, { ok: true });
}

function apiInstallLog(res, id) {
  const rec = installRuns.get(id);
  sendJson(res, 200, rec
    ? { logs: rec.logs.join(''), running: rec.running, exitCode: rec.exitCode }
    : { logs: '', running: false, exitCode: null });
}

// ================= Database manager (MySQL & PostgreSQL) =================
const DB_FILE = path.join(DATA_DIR, 'db.json');
const dbConns = {}; // type -> { kind, conn }

function dbValidType(t) {
  if (t !== 'mysql' && t !== 'postgres') throw new Error('Invalid database type');
}

function dbLib(t) {
  try {
    return t === 'mysql' ? require('mysql2/promise') : require('pg');
  } catch {
    throw new Error('Database module not installed. Run: npm install');
  }
}
function loadDbConfigs() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return {}; }
}
function saveDbConfigs(cfgs) {
  fs.writeFileSync(DB_FILE, JSON.stringify(cfgs, null, 2), { mode: 0o600 });
}
function pgIdent(s) {
  return '"' + String(s).replace(/"/g, '""') + '"';
}
function safeRow(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (Buffer.isBuffer(v)) out[k] = v.toString('utf8');
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = v;
  }
  return out;
}
function dbDefaultCfg(t) {
  return t === 'mysql'
    ? { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: '' }
    : { host: '127.0.0.1', port: 5432, user: 'postgres', password: '', database: '' };
}
function normCfg(t, body) {
  const d = dbDefaultCfg(t);
  return {
    host: String(body.host || d.host),
    port: parseInt(body.port, 10) || d.port,
    user: String(body.user || d.user),
    password: body.password != null ? String(body.password) : '',
    database: body.database ? String(body.database) : '',
  };
}
function dbDisconnect(t) {
  const rec = dbConns[t];
  if (!rec) return;
  delete dbConns[t];
  (async () => { try { await rec.conn.end(); } catch { /* ignore */ } })();
}
async function dbQuery(t, sql, params) {
  const rec = dbConns[t];
  if (!rec) throw new Error('Not connected');
  if (rec.kind === 'mysql') {
    const [rows, fields] = await rec.conn.query(sql, params || []);
    return {
      rows: Array.isArray(rows) ? rows.map(safeRow) : [],
      fields: (fields || []).map((f) => f.name),
      affected: rows.affectedRows != null ? rows.affectedRows : null,
    };
  }
  const r = await rec.conn.query(sql, params || []);
  return {
    rows: r.rows.map(safeRow),
    fields: r.fields.map((f) => f.name),
    affected: r.rowCount != null ? r.rowCount : null,
  };
}
async function withPgDb(t, cfg, db, fn) {
  const pg = dbLib(t);
  const client = new pg.Client({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: db, connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try { return await fn(client); }
  finally { try { await client.end(); } catch { /* ignore */ } }
}
async function dbListDatabases(t) {
  if (!dbConns[t]) throw new Error('Not connected');
  if (t === 'mysql') {
    const r = await dbQuery(t, 'SHOW DATABASES');
    return r.rows.map((x) => x.Database);
  }
  const r = await dbQuery(t, 'SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY datname');
  return r.rows.map((x) => x.datname);
}
async function apiDbConfigGet(res, t) {
  dbValidType(t);
  const cfgs = loadDbConfigs();
  sendJson(res, 200, { config: Object.assign(dbDefaultCfg(t), cfgs[t] || {}), connected: !!dbConns[t] });
}
async function apiDbConfigSave(req, res, t) {
  dbValidType(t);
  const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const cfgs = loadDbConfigs();
  cfgs[t] = normCfg(t, body);
  saveDbConfigs(cfgs);
  sendJson(res, 200, { ok: true });
}
async function apiDbTest(req, res, t) {
  dbValidType(t);
  const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const cfg = normCfg(t, body);
  try {
    if (t === 'mysql') {
      const conn = await dbLib(t).createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
        database: cfg.database || undefined, connectTimeout: 5000 });
      await conn.end();
    } else {
      const client = new (dbLib(t).Client)({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
        database: cfg.database || 'postgres', connectionTimeoutMillis: 5000 });
      await client.connect();
      await client.end();
    }
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 200, { ok: false, error: e.message || 'Connection failed' });
  }
}
async function connectDb(t, cfg) {
  dbDisconnect(t);
  try {
    if (t === 'mysql') {
      const conn = await dbLib(t).createConnection({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
        database: cfg.database || undefined, connectTimeout: 8000 });
      dbConns[t] = { kind: 'mysql', conn };
    } else {
      const client = new (dbLib(t).Client)({
        host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
        database: cfg.database || 'postgres', connectionTimeoutMillis: 8000 });
      await client.connect();
      dbConns[t] = { kind: 'postgres', conn: client };
    }
  } catch (e) {
    dbDisconnect(t);
    throw e;
  }
  return dbConns[t];
}
async function apiDbConnect(req, res, t) {
  dbValidType(t);
  const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const cfg = normCfg(t, body);
  const cfgs = loadDbConfigs();
  cfgs[t] = cfg;
  saveDbConfigs(cfgs);
  dbAutoOff[t] = false; // connect manual mengaktifkan lagi auto-connect
  try {
    await connectDb(t, cfg);
  } catch (e) {
    return sendJson(res, 400, { error: 'Connection failed: ' + (e.message || 'unknown') });
  }
  sendJson(res, 200, { ok: true, databases: await dbListDatabases(t) });
}
function apiDbDisconnect(res, t) {
  dbValidType(t);
  dbDisconnect(t);
  dbAutoOff[t] = true; // Disconnect manual dihormati: retry tidak menyalakan lagi
  sendJson(res, 200, { ok: true });
}
// ================= Auto-connect database saat panel dijalankan =================
// Hanya untuk tipe yang config-nya pernah disimpan lewat Save & Connect
// (tidak menebak-nebak kredensial default untuk database yang belum pernah
// dipakai). Gagal di awal tidak menghentikan panel: dicoba lagi tiap 30 detik
// sampai server databasenya hidup (mis. panel start duluan sebelum mysqld).
// Kegagalan hanya dilog sekali per tipe sampai berhasil, supaya log tidak spam.
const dbAutoOff = {};
const dbAutoLoggedFail = {};
let dbAutoBusy = false;
async function autoConnectDb() {
  if (dbAutoBusy) return;
  dbAutoBusy = true;
  try {
    const cfgs = loadDbConfigs();
    for (const t of ['mysql', 'postgres']) {
      if (dbConns[t] || dbAutoOff[t] || !cfgs[t]) continue;
      try {
        await connectDb(t, normCfg(t, cfgs[t]));
        delete dbAutoLoggedFail[t];
        console.log('Auto-connected database (' + t + ')');
      } catch (e) {
        if (!dbAutoLoggedFail[t]) {
          dbAutoLoggedFail[t] = true;
          console.log('Auto-connect database (' + t + ') failed: ' + (e.message || 'unknown') + ' (will retry)');
        }
      }
    }
  } finally {
    dbAutoBusy = false;
  }
}
async function apiDbDatabases(res, t) {
  dbValidType(t);
  sendJson(res, 200, { databases: await dbListDatabases(t) });
}
async function apiDbCreate(req, res, t) {
  dbValidType(t);
  const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const name = (body.name || '').trim();
  // Nama identifier aman untuk di-quote langsung: huruf/underscore pembuka,
  // lalu huruf/angka/underscore, maks 64 karakter (batas MySQL & Postgres).
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new Error('Nama database tidak valid (huruf, angka, underscore; diawali huruf/underscore; maks 64 karakter)');
  }
  // Validasi user SEKALIAN di sini, sebelum CREATE DATABASE, supaya database
  // tidak terlanjur dibuat bila password/host user ternyata tidak valid.
  const preUser = (body.user || '').trim();
  const preHost = t === 'mysql' ? ((body.host || 'localhost').trim() || 'localhost') : '-';
  if (preUser) {
    if (!dbIdentValid(preUser)) throw new Error('Nama user tidak valid');
    if (!body.password || body.password.length < 8) throw new Error('Password minimal 8 karakter');
    if (t === 'mysql' && !dbHostValid(preHost)) throw new Error('Host tidak valid');
  }
  if (!dbConns[t]) throw new Error('Not connected');
  if (t === 'mysql') {
    await dbQuery(t, 'CREATE DATABASE `' + name + '`');
  } else {
    // Postgres: CREATE DATABASE tidak bisa jalan di dalam transaksi; koneksi
    // panel tidak membuka transaksi eksplisit, jadi query langsung aman.
    await dbQuery(t, 'CREATE DATABASE ' + pgIdent(name));
  }
  // Gaya aaPanel: bila username diisi, sekalian buat user + grant ke database ini.
  const newUser = (body.user || '').trim();
  if (newUser) {
    const newHost = t === 'mysql' ? ((body.host || 'localhost').trim() || 'localhost') : '-';
    await dbCreateUser(t, newUser, body.password || '', newHost);
    await dbGrant(t, newUser, newHost, name);
  }
  sendJson(res, 200, { ok: true, database: name, databases: await dbListDatabases(t) });
}

// ================= Manajemen database ala aaPanel =================
// Tabel database (nama, jumlah tabel, ukuran), hapus database,
// kelola user (tambah/hapus/ganti password/grant per database),
// backup (mysqldump/pg_dump) + restore dari file backup.
// Semua identifier divalidasi ketat (huruf/angka/underscore) dan password
// di-escape (' -> '') sebelum masuk ke string literal SQL, jadi tidak ada
// injeksi lewat nama user/database maupun password.
function dbIdentValid(name) { return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(String(name || '')); }
function dbHostValid(h) { return h === '%' || h === 'localhost' || /^[A-Za-z0-9.-]{1,253}$/.test(String(h || '')); }
function sqlStr(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }
function dbCfgFor(t) { const cfgs = loadDbConfigs(); return normCfg(t, cfgs[t] || {}); }
async function dbCreateUser(t, user, password, host) {
  if (!dbIdentValid(user)) throw new Error('Nama user tidak valid');
  if (!password || password.length < 8) throw new Error('Password minimal 8 karakter');
  if (t === 'mysql') {
    if (!dbHostValid(host)) throw new Error('Host tidak valid (localhost, %, atau IP/hostname)');
    await dbQuery(t, 'CREATE USER ' + sqlStr(user) + '@' + sqlStr(host) + ' IDENTIFIED BY ' + sqlStr(password));
  } else {
    await dbQuery(t, 'CREATE ROLE ' + pgIdent(user) + ' LOGIN PASSWORD ' + sqlStr(password));
  }
}
async function dbGrant(t, user, host, database) {
  if (!dbIdentValid(user) || !dbIdentValid(database)) throw new Error('Nama user/database tidak valid');
  if (t === 'mysql') {
    if (!dbHostValid(host)) throw new Error('Host tidak valid');
    await dbQuery(t, 'GRANT ALL PRIVILEGES ON `' + database + '`.* TO ' + sqlStr(user) + '@' + sqlStr(host));
    await dbQuery(t, 'FLUSH PRIVILEGES');
  } else {
    await dbQuery(t, 'GRANT ALL PRIVILEGES ON DATABASE ' + pgIdent(database) + ' TO ' + pgIdent(user));
  }
}
async function dbRevoke(t, user, host, database) {
  if (!dbIdentValid(user) || !dbIdentValid(database)) throw new Error('Nama user/database tidak valid');
  if (t === 'mysql') {
    if (!dbHostValid(host)) throw new Error('Host tidak valid');
    await dbQuery(t, 'REVOKE ALL PRIVILEGES ON `' + database + '`.* FROM ' + sqlStr(user) + '@' + sqlStr(host));
    await dbQuery(t, 'FLUSH PRIVILEGES');
  } else {
    await dbQuery(t, 'REVOKE ALL PRIVILEGES ON DATABASE ' + pgIdent(database) + ' FROM ' + pgIdent(user));
  }
}
async function apiDbDetails(res, t) {
  dbValidType(t);
  if (!dbConns[t]) throw new Error('Not connected');
  const dbs = await dbListDatabases(t);
  if (t === 'mysql') {
    const r = await dbQuery(t, 'SELECT table_schema AS s, COUNT(*) AS c, COALESCE(SUM(data_length+index_length),0) AS sz FROM information_schema.tables GROUP BY table_schema');
    const m = {};
    for (const row of r.rows) m[row.s] = { tables: Number(row.c), size: Number(row.sz) };
    sendJson(res, 200, { databases: dbs.map((d) => ({ name: d, tables: (m[d] || {}).tables || 0, size: (m[d] || {}).size || 0 })) });
    return;
  }
  const r = await dbQuery(t, 'SELECT datname, pg_database_size(datname) AS sz FROM pg_database WHERE datistemplate=false ORDER BY datname');
  const sz = {};
  for (const row of r.rows) sz[row.datname] = Number(row.sz);
  const out = [];
  for (const d of dbs) {
    let tables = 0;
    try {
      tables = await withPgDb(t, dbCfgFor(t), d, async (c) => {
        const q = await c.query("SELECT COUNT(*) AS c FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')");
        return Number(q.rows[0].c);
      });
    } catch { /* database yang tidak bisa dibuka: hitung 0 */ }
    out.push({ name: d, tables, size: sz[d] || 0 });
  }
  sendJson(res, 200, { databases: out });
}
async function apiDbDelete(req, res, t, name) {
  dbValidType(t);
  if (!dbIdentValid(name)) throw new Error('Nama database tidak valid');
  if (!dbConns[t]) throw new Error('Not connected');
  if (t === 'mysql') await dbQuery(t, 'DROP DATABASE `' + name + '`');
  else await dbQuery(t, 'DROP DATABASE ' + pgIdent(name));
  sendJson(res, 200, { ok: true, databases: await dbListDatabases(t) });
}
async function apiDbUsers(res, t) {
  dbValidType(t);
  if (!dbConns[t]) throw new Error('Not connected');
  if (t === 'mysql') {
    const r = await dbQuery(t, 'SELECT User AS user, Host AS host FROM mysql.user ORDER BY User, Host');
    sendJson(res, 200, { users: r.rows });
    return;
  }
  const r = await dbQuery(t, 'SELECT usename AS user FROM pg_roles WHERE rolcanlogin ORDER BY usename');
  sendJson(res, 200, { users: r.rows.map((x) => ({ user: x.user, host: '-' })) });
}
async function apiDbUserCreate(req, res, t) {
  dbValidType(t);
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const user = (b.username || '').trim();
  const host = t === 'mysql' ? ((b.host || 'localhost').trim() || 'localhost') : '-';
  if (!dbIdentValid(user)) throw new Error('Nama user tidak valid');
  if (!b.password || b.password.length < 8) throw new Error('Password minimal 8 karakter');
  if (t === 'mysql' && !dbHostValid(host)) throw new Error('Host tidak valid');
  if (b.database && !dbIdentValid((b.database || '').trim())) throw new Error('Nama database tidak valid');
  if (!dbConns[t]) throw new Error('Not connected');
  await dbCreateUser(t, user, b.password || '', host);
  if (b.database) await dbGrant(t, user, host, (b.database || '').trim());
  sendJson(res, 200, { ok: true });
}
async function apiDbUserDelete(req, res, t) {
  dbValidType(t);
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const user = (b.user || '').trim();
  const host = t === 'mysql' ? ((b.host || 'localhost').trim() || 'localhost') : '-';
  if (!dbIdentValid(user)) throw new Error('Nama user tidak valid');
  if (t === 'mysql' && !dbHostValid(host)) throw new Error('Host tidak valid');
  if (!dbConns[t]) throw new Error('Not connected');
  if (t === 'mysql') {
    if (!dbHostValid(host)) throw new Error('Host tidak valid');
    await dbQuery(t, 'DROP USER ' + sqlStr(user) + '@' + sqlStr(host));
  } else {
    await dbQuery(t, 'DROP ROLE ' + pgIdent(user));
  }
  sendJson(res, 200, { ok: true });
}
async function apiDbUserPassword(req, res, t) {
  dbValidType(t);
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const user = (b.user || '').trim();
  const host = t === 'mysql' ? ((b.host || 'localhost').trim() || 'localhost') : '-';
  if (!dbIdentValid(user)) throw new Error('Nama user tidak valid');
  if (!b.password || b.password.length < 8) throw new Error('Password minimal 8 karakter');
  if (t === 'mysql' && !dbHostValid(host)) throw new Error('Host tidak valid');
  if (!dbConns[t]) throw new Error('Not connected');
  if (t === 'mysql') {
    if (!dbHostValid(host)) throw new Error('Host tidak valid');
    await dbQuery(t, 'ALTER USER ' + sqlStr(user) + '@' + sqlStr(host) + ' IDENTIFIED BY ' + sqlStr(b.password));
  } else {
    await dbQuery(t, 'ALTER ROLE ' + pgIdent(user) + ' WITH PASSWORD ' + sqlStr(b.password));
  }
  sendJson(res, 200, { ok: true });
}
async function apiDbUserGrant(req, res, t) {
  dbValidType(t);
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const user = (b.user || '').trim();
  const host = t === 'mysql' ? ((b.host || 'localhost').trim() || 'localhost') : '-';
  const database = (b.database || '').trim();
  if (!dbIdentValid(user) || !dbIdentValid(database)) throw new Error('Nama user/database tidak valid');
  if (t === 'mysql' && !dbHostValid(host)) throw new Error('Host tidak valid');
  if (b.action !== 'grant' && b.action !== 'revoke') throw new Error('Action harus grant atau revoke');
  if (!dbConns[t]) throw new Error('Not connected');
  if (b.action === 'grant') await dbGrant(t, user, host, database);
  else if (b.action === 'revoke') await dbRevoke(t, user, host, database);
  else throw new Error('Action harus grant atau revoke');
  sendJson(res, 200, { ok: true });
}
function dbBackupDir() { return path.join(DATA_DIR, 'db-backups'); }
async function apiDbBackups(res) {
  const dir = dbBackupDir();
  let files = [];
  try {
    const names = await fsp.readdir(dir);
    for (const n of names.sort().reverse()) {
      try { const st = await fsp.stat(path.join(dir, n)); if (st.isFile()) files.push({ file: n, size: st.size, mtime: st.mtimeMs }); } catch {}
    }
  } catch { /* belum ada backup: daftar kosong */ }
  sendJson(res, 200, { backups: files });
}
function runDump(bin, args, env, outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: Object.assign({}, process.env, env) });
    const out = fs.createWriteStream(outFile);
    let err = '';
    child.stdout.pipe(out);
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => reject(new Error(bin + ' tidak ditemukan: ' + e.message)));
    child.on('exit', (code) => {
      out.end();
      if (code === 0) resolve();
      else reject(new Error(bin + ' gagal (exit ' + code + '): ' + err.slice(-500)));
    });
  });
}
async function apiDbBackup(req, res, t, name) {
  dbValidType(t);
  if (!dbIdentValid(name)) throw new Error('Nama database tidak valid');
  if (!dbConns[t]) throw new Error('Not connected');
  const cfg = dbCfgFor(t);
  const dir = dbBackupDir();
  await fsp.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = name + '-' + ts + '.sql';
  try {
    if (t === 'mysql') {
      await runDump('mysqldump', ['--host', cfg.host, '--port', String(cfg.port), '--user', cfg.user, '--databases', name, '--single-transaction', '--routines', '--events'], { MYSQL_PWD: cfg.password || '' }, path.join(dir, file));
    } else {
      await runDump('pg_dump', ['--host', cfg.host, '--port', String(cfg.port), '--username', cfg.user, '--dbname', name, '--clean', '--if-exists'], { PGPASSWORD: cfg.password || '' }, path.join(dir, file));
    }
  } catch (e) {
    try { await fsp.unlink(path.join(dir, file)); } catch {}
    throw e;
  }
  const st = await fsp.stat(path.join(dir, file));
  sendJson(res, 200, { ok: true, file, size: st.size });
}
async function apiDbRestore(req, res, t, name) {
  dbValidType(t);
  if (!dbIdentValid(name)) throw new Error('Nama database tidak valid');
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const file = b.file || '';
  if (!/^[A-Za-z0-9_.-]+$/.test(file) || file.includes('..')) throw new Error('Nama file backup tidak valid');
  if (!dbConns[t]) throw new Error('Not connected');
  const full = path.join(dbBackupDir(), file);
  const st = await fsp.stat(full).catch(() => null);
  if (!st || !st.isFile()) throw new Error('File backup tidak ditemukan');
  const cfg = dbCfgFor(t);
  if (t === 'postgres') {
    const existing = await dbListDatabases(t);
    if (!existing.includes(name)) await dbQuery(t, 'CREATE DATABASE ' + pgIdent(name));
  }
  await new Promise((resolve, reject) => {
    let child, err = '';
    if (t === 'mysql') {
      child = spawn('mysql', ['--host', cfg.host, '--port', String(cfg.port), '--user', cfg.user], { env: Object.assign({}, process.env, { MYSQL_PWD: cfg.password || '' }) });
    } else {
      child = spawn('psql', ['--host', cfg.host, '--port', String(cfg.port), '--username', cfg.user, '--dbname', name], { env: Object.assign({}, process.env, { PGPASSWORD: cfg.password || '' }) });
    }
    fs.createReadStream(full).pipe(child.stdin);
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => reject(new Error('Client database tidak ditemukan: ' + e.message)));
    child.on('exit', (code) => { if (code === 0) resolve(); else reject(new Error('Restore gagal (exit ' + code + '): ' + err.slice(-500))); });
  });
  sendJson(res, 200, { ok: true });
}


// ================= AI Chat (ala opencode CLI) =================
// Settings OpenAI-compatible: endpoint, apiKey, model. Disimpan di
// ~/.termux-panel/ai.json (0600). API TIDAK PERNAH mengembalikan apiKey,
// hanya hasKey — pola yang sama dengan Settings AI Perisai (key tak pernah
// ke browser). Fetch models + chat memakai fetch Node (undici).
// Chat di-stream: backend meneruskan SSE upstream apa adanya ke browser,
// dan frontend mengurai delta-nya (termasuk bungkus {"data": ...} ala
// 9Router dan trailer "data: [DONE]").
const AI_CFG_FILE = path.join(DATA_DIR, 'ai.json');
function loadAiConfig() { try { return JSON.parse(fs.readFileSync(AI_CFG_FILE, 'utf8')); } catch { return {}; } }
function saveAiConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(AI_CFG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
function aiNormBase(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('Endpoint harus URL http(s), mis. https://ai.skyzo.biz.id/v1');
  return /\/v1$/.test(base) ? base : base + '/v1';
}
function aiPublic(cfg) { return { endpoint: cfg.endpoint || '', model: cfg.model || '', hasKey: !!cfg.apiKey }; }
async function apiAiConfigGet(res) { sendJson(res, 200, aiPublic(loadAiConfig())); }
async function apiAiConfigSave(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const endpoint = aiNormBase(b.endpoint || '');
  const model = String(b.model || '').trim();
  if (!model) throw new Error('Model wajib dipilih atau diketik');
  const cur = loadAiConfig();
  const key = String(b.apiKey || '').trim();
  const cfg = { endpoint, model, apiKey: key ? key : (cur.apiKey || '') };
  if (!cfg.apiKey) throw new Error('API key wajib diisi (belum ada key tersimpan)');
  saveAiConfig(cfg);
  sendJson(res, 200, Object.assign({ ok: true }, aiPublic(cfg)));
}
async function apiAiModels(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const cur = loadAiConfig();
  const endpoint = aiNormBase(b.endpoint || cur.endpoint || '');
  const key = String(b.apiKey || '').trim() || cur.apiKey || '';
  if (!key) throw new Error('API key belum diatur');
  const r = await fetch(endpoint + '/models', { headers: { Authorization: 'Bearer ' + key } });
  const txt = await r.text();
  if (!r.ok) throw new Error('Fetch models gagal (' + r.status + '): ' + txt.slice(0, 300));
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error('Respons models bukan JSON'); }
  const data = j.data || j.models || [];
  const models = data.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean).sort();
  sendJson(res, 200, { models });
}

// ================= AI Agent mode (ala opencode) =================
// Loop: model -> tool_call -> eksekusi di Termux -> hasil kembali ke model.
// Tool baca (list_dir, read_file) jalan otomatis; tool tulis/eksekusi
// (write_file, exec) SELALU minta approval user dulu — backend menyimpan
// state run yang tertunda di memori (hilang bila panel restart) dan
// menghentikan stream SSE-nya dengan event approval; frontend melanjutkan
// lewat POST /api/ai/agent/approve yang membuka stream SSE baru.
// Semua path file dikurung safePath (PANEL_ROOT, default $HOME) — sama
// seperti File Manager. exec dibatasi 30 detik & output 20 KB, cwd default
// PANEL_ROOT dan juga dikurung safePath.
const AI_AGENT_SYSTEM = 'Kamu adalah AI agent yang berjalan di dalam panel Terwo di Termux/Android. Jawab dalam Bahasa Indonesia. Kamu punya tool: exec (jalankan perintah shell), read_file, write_file, list_dir. Semua file hanya di dalam home user. Gunakan tool untuk menyelesaikan tugas, jangan hanya menjelaskan. Setelah tool selesai, rangkum hasilnya dengan singkat. Bila tool ditolak user, jangan mengulang tool yang sama tanpa mengubah pendekatan.';
const AI_AGENT_MAX_STEPS = 12;
const aiAgentRuns = new Map();
let aiAgentSeq = 0;
function aiToolDefs() {
  return [
    { type: 'function', function: { name: 'exec', description: 'Jalankan perintah shell di Termux (bash -c). Output dibatasi 20 KB, timeout 30 detik.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string', description: 'Direktori kerja, relatif terhadap home (default home)' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'read_file', description: 'Baca isi file teks (maks 100 KB, selebihnya dipotong). Path relatif terhadap home atau absolut di dalam home.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'write_file', description: 'Tulis/overwrite file teks. Path relatif terhadap home atau absolut di dalam home.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'list_dir', description: 'Daftar isi direktori (maks 200 entri). Path relatif terhadap home atau absolut di dalam home.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } } },
  ];
}
function aiSse(res, obj) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} }
// Ambil objek JSON pertama yang lengkap dari teks, mengabaikan apa pun yang
// menempel setelahnya (mis. trailer SSE "data: [DONE]" yang ditempel 9Router
// di belakang JSON chat completion — pola yang membuat JSON.parse gagal
// padahal JSON-nya sendiri valid).
function aiFirstJsonValue(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
async function aiCallAgentUpstream(cfg, messages) {
  const r = await fetch(aiNormBase(cfg.endpoint) + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model, messages, tools: aiToolDefs(), tool_choice: 'auto' }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('Agent gagal (' + r.status + '): ' + txt.slice(0, 300));
  // Router non-standar (termasuk 9Router) bisa mengembalikan: JSON biasa,
  // JSON berbungkus {"data": ...}, atau SSE padahal stream:false — semuanya
  // harus bisa diurai, bukan langsung gagal "bukan JSON".
  const clean = txt.replace(/^\uFEFF/, '').trim();
  const msgFrom = (d) => {
    if (!d) return null;
    if (d.error) throw new Error('Upstream error: ' + JSON.stringify(d.error).slice(0, 300));
    const ch = d.choices && d.choices[0];
    if (!ch) return null;
    if (ch.message) return ch.message;
    // JSON utuh tapi berisi delta (bukan message): rakit jadi satu pesan.
    if (ch.delta) {
      const msg = { role: 'assistant', content: ch.delta.content || null };
      if (ch.delta.tool_calls) msg.tool_calls = ch.delta.tool_calls;
      return msg;
    }
    return null;
  };
  try {
    const msg = msgFrom(JSON.parse(clean).data || JSON.parse(clean));
    if (msg) return msg;
  } catch (e) {
    if (e.message && e.message.startsWith('Upstream error:')) throw e;
    // JSON.parse gagal: kemungkinan ada trailer SSE / teks tambahan setelah
    // JSON-nya — ambil objek JSON pertama yang lengkap dan abaikan sisanya.
    const j = aiFirstJsonValue(clean);
    if (j) {
      const msg = msgFrom(j.data || j);
      if (msg) return msg;
    }
    // Lanjut ke parsing SSE di bawah; bila itu pun gagal, error akhir
    // menyertakan cuplikan balasan upstream agar bisa didiagnosis.
  }
  if (clean.startsWith('data:')) {
    let content = '';
    const toolMap = new Map();
    let lastMsg = null;
    for (const line of clean.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let pj;
      try { pj = JSON.parse(payload); } catch { pj = aiFirstJsonValue(payload); }
      if (!pj) continue;
      const d = pj.data || pj;
      if (d.error) throw new Error('Upstream error: ' + JSON.stringify(d.error).slice(0, 300));
      const ch = d.choices && d.choices[0];
      if (!ch) continue;
      if (ch.message) lastMsg = ch.message;
      if (ch.delta) {
        if (ch.delta.content) content += ch.delta.content;
        // Tool call streaming terpecah per delta (index-based): rakit kembali
        // nama + argumen dari fragmen-fragmennya.
        for (const t of (ch.delta.tool_calls || [])) {
          const idx = (t.index === undefined || t.index === null) ? 0 : t.index;
          const cur = toolMap.get(idx) || { id: t.id || ('call_sse_' + idx), type: 'function', function: { name: '', arguments: '' } };
          if (t.id) cur.id = t.id;
          if (t.function) {
            if (t.function.name) cur.function.name += t.function.name;
            if (t.function.arguments) cur.function.arguments += t.function.arguments;
          }
          toolMap.set(idx, cur);
        }
      }
    }
    if (lastMsg) return lastMsg;
    if (content || toolMap.size) {
      const msg = { role: 'assistant', content: content || null };
      if (toolMap.size) msg.tool_calls = [...toolMap.values()];
      return msg;
    }
  }
  throw new Error('Respons agent bukan JSON. Upstream mengembalikan: ' + (clean.slice(0, 300) || '(kosong)'));
}
function aiExecTool(name, args) {
  return new Promise((resolve) => {
    try {
      if (name === 'list_dir') {
        const full = safePath(args.path || '.');
        const names = fs.readdirSync(full, { withFileTypes: true }).slice(0, 200);
        resolve(JSON.stringify(names.map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }))));
        return;
      }
      if (name === 'read_file') {
        const full = safePath(args.path || '');
        const buf = fs.readFileSync(full);
        const text = buf.toString('utf8');
        resolve(text.length > 100000 ? text.slice(0, 100000) + '\n... [dipotong, file lebih dari 100 KB]' : text);
        return;
      }
      if (name === 'write_file') {
        const full = safePath(args.path || '');
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, String(args.content || ''));
        resolve('OK, ' + Buffer.byteLength(String(args.content || '')) + ' byte ditulis ke ' + args.path);
        return;
      }
      if (name === 'exec') {
        const cwd = safePath(args.cwd || '.');
        const child = spawn('bash', ['-c', String(args.command || '')], { cwd });
        let out = '', err = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 30000);
        child.stdout.on('data', (d) => { out += d.toString('utf8'); });
        child.stderr.on('data', (d) => { err += d.toString('utf8'); });
        child.on('error', (e) => { clearTimeout(timer); resolve('exec error: ' + e.message); });
        child.on('exit', (code) => {
          clearTimeout(timer);
          let combined = out;
          if (err) combined += (combined ? '\n[stderr]\n' : '') + err;
          if (combined.length > 20000) combined = combined.slice(0, 20000) + '\n... [output dipotong 20 KB]';
          resolve('exit code ' + code + (combined ? '\n' + combined : ' (tanpa output)'));
        });
        return;
      }
      resolve('Tool tidak dikenal: ' + name);
    } catch (e) { resolve('Tool ' + name + ' gagal: ' + e.message); }
  });
}
async function aiAgentLoop(res, state) {
  while (state.steps < AI_AGENT_MAX_STEPS) {
    let toolCalls = state.queue || null;
    state.queue = null;
    if (!toolCalls) {
      const msg = await aiCallAgentUpstream(state.cfg, state.messages);
      state.messages.push(msg);
      if (msg.content) aiSse(res, { type: 'text', content: msg.content });
      toolCalls = msg.tool_calls || [];
      if (!toolCalls.length) { aiSse(res, { type: 'done' }); return; }
      state.steps++;
    }
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const tname = (tc.function && tc.function.name) || '';
      let targs = {};
      try { targs = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch {}
      if (tname === 'list_dir' || tname === 'read_file') {
        const result = await aiExecTool(tname, targs);
        state.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        aiSse(res, { type: 'tool', tool: tname, args: targs, result });
      } else if (tname === 'exec' || tname === 'write_file') {
        state.queue = toolCalls.slice(i + 1);
        state.pending = tc;
        aiAgentRuns.set(state.runId, state);
        aiSse(res, { type: 'approval', runId: state.runId, tool: tname, args: targs });
        return;
      } else {
        state.messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Tool tidak dikenal: ' + tname });
        aiSse(res, { type: 'tool', tool: tname, args: targs, result: 'Tool tidak dikenal' });
      }
    }
  }
  aiSse(res, { type: 'done', note: 'Batas ' + AI_AGENT_MAX_STEPS + ' langkah tercapai' });
}
async function apiAiAgent(req, res) {
  const cfg = loadAiConfig();
  if (!cfg.endpoint || !cfg.apiKey || !cfg.model) throw new Error('AI belum diatur: isi endpoint, API key, dan model di Settings AI dulu');
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const msgs = (Array.isArray(b.messages) ? b.messages : [])
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .slice(-50);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new Error('Pesan terakhir harus dari user');
  const state = { runId: 'ai' + (++aiAgentSeq) + '-' + Date.now(), cfg, messages: [{ role: 'system', content: AI_AGENT_SYSTEM }, ...msgs], steps: 0, queue: null, pending: null };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  try { await aiAgentLoop(res, state); } catch (e) { aiSse(res, { type: 'error', error: e.message }); }
  res.end();
}
async function apiAiAgentApprove(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const state = aiAgentRuns.get(b.runId || '');
  if (!state || !state.pending) throw new Error('Run agent tidak ditemukan (mungkin panel sudah restart atau approval sudah dijawab)');
  aiAgentRuns.delete(b.runId);
  const tc = state.pending;
  state.pending = null;
  const tname = (tc.function && tc.function.name) || '';
  let targs = {};
  try { targs = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch {}
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  try {
    if (b.approved) {
      const result = await aiExecTool(tname, targs);
      state.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      aiSse(res, { type: 'tool', tool: tname, args: targs, result });
    } else {
      state.messages.push({ role: 'tool', tool_call_id: tc.id, content: 'User menolak menjalankan tool ini.' });
      aiSse(res, { type: 'tool', tool: tname, args: targs, result: 'DITOLAK user' });
    }
    await aiAgentLoop(res, state);
  } catch (e) { aiSse(res, { type: 'error', error: e.message }); }
  res.end();
}

async function apiAiChat(req, res) {
  const cfg = loadAiConfig();
  if (!cfg.endpoint || !cfg.apiKey || !cfg.model) throw new Error('AI belum diatur: isi endpoint, API key, dan model di Settings AI dulu');
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const msgs = (Array.isArray(b.messages) ? b.messages : [])
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
    .slice(-50);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') throw new Error('Pesan terakhir harus dari user');
  const r = await fetch(aiNormBase(cfg.endpoint) + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model, messages: msgs, stream: true }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Chat gagal (' + r.status + '): ' + txt.slice(0, 300));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  try {
    for await (const chunk of r.body) res.write(chunk);
  } catch (e) {
    try { res.write('data: ' + JSON.stringify({ error: 'Stream terputus: ' + e.message }) + '\n\n'); } catch {}
  }
  res.end();
}

async function apiDbTables(url, res, t) {
  dbValidType(t);
  const db = url.searchParams.get('db');
  if (!db) throw new Error('Database must be selected');
  if (t === 'mysql') {
    const r = await dbQuery(t, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema=? ORDER BY table_name', [db]);
    sendJson(res, 200, { tables: r.rows.map((x) => x.t) });
    return;
  }
  const cfgs = loadDbConfigs();
  const tables = await withPgDb(t, normCfg(t, cfgs[t] || {}), db, async (client) => {
    const r = await client.query("SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY tablename");
    return r.rows.map((x) => x.tablename);
  });
  sendJson(res, 200, { tables });
}
async function apiDbRows(url, res, t) {
  dbValidType(t);
  const db = url.searchParams.get('db');
  const table = url.searchParams.get('table');
  if (!db || !table) throw new Error('Database and table are required');
  if (db.length > 128 || table.length > 128) throw new Error('Name too long');
  if (t === 'mysql') {
    const r = await dbQuery(t, 'SELECT * FROM ??.?? LIMIT 50', [db, table]);
    sendJson(res, 200, { fields: r.fields, rows: r.rows });
    return;
  }
  const cfgs = loadDbConfigs();
  const r = await withPgDb(t, normCfg(t, cfgs[t] || {}), db, async (client) => {
    const q = await client.query('SELECT * FROM ' + pgIdent(table) + ' LIMIT 50');
    return { fields: q.fields.map((f) => f.name), rows: q.rows.map(safeRow) };
  });
  sendJson(res, 200, { fields: r.fields, rows: r.rows });
}
async function apiDbQuery(req, res, t) {
  dbValidType(t);
  const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const sql = (body.sql || '').trim();
  if (!sql) throw new Error('SQL is empty');
  if (sql.length > 20000) throw new Error('SQL too long');
  const r = await dbQuery(t, sql);
  sendJson(res, 200, { fields: r.fields, rows: r.rows, affected: r.affected });
}
// ================= Settings & Telegram =================
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return { telegram: { botToken: '', chatId: '', enabled: false, commandsEnabled: true } }; }
}
function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function telegramSend(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const host = ['api', 'telegram', 'org'].join('.');
    const data = JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) });
    const req = https.request({
      hostname: host, path: '/bot' + botToken + '/sendMessage', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 10000,
    }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => {
        try { const j = JSON.parse(b); j.ok ? resolve() : reject(new Error(j.description || 'Failed to send')); }
        catch { reject(new Error('Invalid Telegram response')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    const hard = setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, 10000);
    req.on('close', () => clearTimeout(hard));
    req.write(data);
    req.end();
  });
}
function sendTelegram(text) {
  try {
    const tg = loadSettings().telegram || {};
    if (!tg.enabled || !tg.botToken || !tg.chatId) return;
    telegramSend(tg.botToken, tg.chatId, text).catch((e) => console.log('Telegram failed:', e.message));
  } catch (e) { console.log('Telegram failed:', e.message); }
}
async function apiSettingsGet(res) {
  const s = loadSettings();
  sendJson(res, 200, { username: config.username, telegram: s.telegram || {}, version: VERSION });
}
async function apiSettingsPost(req, res) {
  const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const s = loadSettings();
  const tg = body.telegram || {};
  s.telegram = { botToken: String(tg.botToken || ''), chatId: String(tg.chatId || ''),
    enabled: !!tg.enabled, commandsEnabled: tg.commandsEnabled === undefined ? true : !!tg.commandsEnabled };
  saveSettings(s);
  try { startTelegramPoll(); } catch { /* ignore */ }
  sendJson(res, 200, { ok: true });
}
async function apiTelegramTest(res) {
  const tg = loadSettings().telegram || {};
  if (!tg.enabled || !tg.botToken || !tg.chatId) {
    return sendJson(res, 400, { ok: false, error: 'Fill in bot token & chat ID and enable it first' });
  }
  try {
    await telegramSend(tg.botToken, tg.chatId, 'Terwo notification test successful!');
    sendJson(res, 200, { ok: true });
  } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
}
// ================= Telegram bot commands (polling) =================
let tgPollTimer = null, tgPollOffset = 0;
function tgApiGet(botToken, apiPath) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const host = ['api', 'telegram', 'org'].join('.');
    const req = https.request({ hostname: host, path: '/bot' + botToken + apiPath,
      method: 'GET', timeout: 10000 }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => {
        try { const j = JSON.parse(b); j.ok ? resolve(j) : reject(new Error(j.description || 'API failed')); }
        catch { reject(new Error('Invalid response')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    const hard = setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, 10000);
    req.on('close', () => clearTimeout(hard));
    req.end();
  });
}
function fmtUptime(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  const p = [];
  if (d) p.push(d + 'h'); if (h) p.push(h + 'j'); if (m || !p.length) p.push(m + 'm');
  return p.join(' ');
}
function mb(b) { return Math.round(b / 1048576); }
async function tgReply(tg, cmd) {
  const s = await getStatsData();
  const run = s.sites.filter((x) => x.running).length;
  switch (cmd) {
    case '/help':
      return 'Bot commands:\n/status summary\n/ram RAM details\n/cpu CPU details\n/battery battery info\n/sites list websites';
    case '/status': {
      const bat = s.battery ? s.battery.percentage + '%' : 'n/a';
      return '🖥 ' + s.hostname + ' | ⏱ ' + fmtUptime(s.uptime) + '\n' +
        '⚙️ CPU load ' + s.cpu.load1 + ' (' + s.cpu.cores + ' core)\n' +
        '🧠 RAM ' + mb(s.mem.used) + '/' + mb(s.mem.total) + ' MB (' + s.mem.percent + '%)\n' +
        '💾 Disk ' + (s.disk ? s.disk.percent + '%' : 'n/a') + ' | 🔋 ' + bat + '\n' +
        '🌐 Website ' + run + '/' + s.sites.length + ' running';
    }
    case '/ram':
      return '🧠 RAM — Total ' + mb(s.mem.total) + ' MB, used ' + mb(s.mem.used) + ' MB (' + s.mem.percent + '%), free ' + mb(s.mem.free) + ' MB';
    case '/cpu':
      return '⚙️ CPU (' + s.cpu.cores + ' core) — load ' + s.cpu.load1 + '/' + s.cpu.load5 + '/' + s.cpu.load15 + ', uptime ' + fmtUptime(s.uptime);
    case '/battery': case '/bat':
      return s.battery ? '🔋 Battery ' + s.battery.percentage + '% (' + s.battery.status + ')' : '🔋 Battery unavailable (needs Termux:API)';
    case '/sites':
      return s.sites.length ? '🌐 Website:\n' + s.sites.map((x) => (x.running ? '🟢' : '🔴') + ' ' + x.name + ' (' + x.type + ') :' + x.port).join('\n') : 'No websites yet';
    default: return 'Unknown command. Type /help.';
  }
}
async function tgPollOnce() {
  const tg = loadSettings().telegram || {};
  if (!(tg.enabled && tg.botToken && tg.chatId && tg.commandsEnabled !== false)) return;
  let j;
  try { j = await tgApiGet(tg.botToken, '/getUpdates?offset=' + tgPollOffset + '&timeout=5'); }
  catch (e) { console.log('Telegram poll:', e.message); return; }
  for (const u of (j.result || [])) {
    tgPollOffset = Math.max(tgPollOffset, (u.update_id || 0) + 1);
    const m = u.message;
    if (!m || typeof m.text !== 'string') continue;
    if (String(m.chat && m.chat.id) !== String(tg.chatId)) { console.log('Telegram: message from unknown chat ignored'); continue; }
    const cmd = m.text.trim().split(' ')[0].split('@')[0].toLowerCase();
    try {
      const reply = await tgReply(tg, cmd);
      await telegramSend(tg.botToken, tg.chatId, reply);
    } catch (e) { console.log('Telegram reply failed:', e.message); }
  }
}
function stopTelegramPoll() {
  if (tgPollTimer) { clearInterval(tgPollTimer); tgPollTimer = null; }
}
function startTelegramPoll() {
  stopTelegramPoll();
  const tg = loadSettings().telegram || {};
  if (!(tg.enabled && tg.botToken && tg.chatId && tg.commandsEnabled !== false)) return;
  tgApiGet(tg.botToken, '/getUpdates?timeout=0').then((j) => {
    const r = j.result || [];
    if (r.length) tgPollOffset = Math.max.apply(null, r.map((u) => u.update_id)) + 1;
  }).catch((e) => console.log('Telegram poll:', e.message));
  tgPollTimer = setInterval(() => { tgPollOnce().catch((e) => console.log('Telegram poll:', e.message)); }, 10000);
}
// ================= Auth lanjutan =================
function validUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_-]{3,32}$/.test(u);
}
async function apiChangeUsername(req, res) {
  const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  if (!validUsername(body.username)) throw new Error('Username 3-32 karakter (huruf/angka/_/-)');
  config.username = body.username;
  saveConfig();
  sendJson(res, 200, { ok: true, username: config.username });
}
async function apiChangePassword2(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  if (!b.currentPassword || hashPassword(b.currentPassword, config.salt) !== config.hash) {
    return sendJson(res, 400, { error: 'Password lama salah' });
  }
  if (!b.newPassword || b.newPassword.length < 6) {
    return sendJson(res, 400, { error: 'Password baru minimal 6 karakter' });
  }
  if (b.newPassword !== b.confirmPassword) {
    return sendJson(res, 400, { error: 'Password confirmation does not match' });
  }
  config.salt = crypto.randomBytes(16).toString('hex');
  config.hash = hashPassword(b.newPassword, config.salt);
  saveConfig();
  sessions.clear();
  sendJson(res, 200, { ok: true });
}
function apiLogoutAll(res) {
  sessions.clear();
  sendJson(res, 200, { ok: true });
}
// ================= Helper exec umum =================
const TERMUX_PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
// bash tidak selalu ada di Termux; pakai bash bila tersedia, kalau tidak sh bawaan
const SHELL = (function () {
  const cands = ['/bin/bash', TERMUX_PREFIX + '/bin/bash'];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return undefined; // fallback: /bin/sh bawaan exec
})();
// pm2 (apalagi saat start otomatis waktu boot) kerap kehilangan PATH Termux,
// sehingga termux-battery-status dkk "not found" padahal sudah terpasang.
const EXEC_ENV = (function () {
  const env = Object.assign({}, process.env);
  const want = [TERMUX_PREFIX + '/bin', '/system/bin', '/system/xbin'];
  const cur = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of want) if (!cur.includes(d)) cur.push(d);
  env.PATH = cur.join(path.delimiter);
  return env;
})();
function sq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
function execOk(cmd, timeout) {
  return new Promise((resolve) => {
    exec(cmd, { shell: SHELL, env: EXEC_ENV, timeout: timeout || 10000 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout || '') + (err ? err.message : '') });
    });
  });
}
function execTimeout(cmd, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    exec(cmd, {
      shell: SHELL, env: EXEC_ENV, timeout: opts.timeout || 30000, cwd: opts.cwd || HOME, maxBuffer: 50 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message || 'Failed').slice(-800)));
      else resolve(String(stdout || ''));
    });
  });
}
async function mustBin(bin, msg) {
  const r = await execOk('command -v ' + bin + ' >/dev/null 2>&1', 8000);
  if (!r.ok) throw new Error(msg);
}
// ================= Dashboard: /api/stats =================
// os.cpus() kerap mengembalikan array kosong di Termux/Android -> jatuh ke nproc/cpuinfo
let cpuCoresCache = 0;
function cpuCores() {
  if (cpuCoresCache) return cpuCoresCache;
  try { const n = os.cpus().length; if (n) return (cpuCoresCache = n); } catch (e) {}
  try {
    const list = fs.readdirSync('/sys/devices/system/cpu').filter((f) => /^cpu[0-9]+$/.test(f));
    if (list.length) return (cpuCoresCache = list.length);
  } catch (e) {}
  try {
    const n = (fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^processor\s*:/gm) || []).length;
    if (n) return (cpuCoresCache = n);
  } catch (e) {}
  return 0;
}
// Butuh paket termux-api DAN aplikasi Termux:API terpasang.
// Kalau perintahnya belum ada kita berhenti mencoba sebentar (biar tidak spawn
// proses gagal tiap 5 detik), tapi WAJIB dicoba lagi berkala supaya instalasi
// baru langsung terdeteksi tanpa perlu restart panel.
const BATTERY_RETRY_MS = 60 * 1000;
let batteryRetryAt = 0;
let batteryLastError = '';   // alasan terakhir, dipakai /api/battery/debug
// Panggil lewat jalur absolut bila ada, supaya tidak bergantung pada PATH
function batteryCmd() {
  const abs = TERMUX_PREFIX + '/bin/termux-battery-status';
  try { if (fs.existsSync(abs)) return sq(abs); } catch (e) {}
  return 'termux-battery-status';
}
async function getBattery() {
  // tetap kembalikan alasannya, jangan null polos
  if (batteryRetryAt && Date.now() < batteryRetryAt) {
    return { error: batteryLastError || 'pkg install termux-api' };
  }
  try {
    // 8 dtk: panggilan pertama bisa lambat karena menunggu izin Android
    const raw = await execTimeout(batteryCmd(), { timeout: 8000 });
    const b = JSON.parse(raw);
    if (b && b.percentage != null) {
      batteryRetryAt = 0;
      batteryLastError = '';
      return { percentage: b.percentage, status: b.status || '' };
    }
    batteryLastError = 'Termux:API tidak merespons';
    return { error: batteryLastError };
  } catch (e) {
    const msg = String((e && e.message) || '');
    // command not found -> jangan coba lagi tiap 5 detik
    if (/not found|not recognized|ENOENT|command not found/i.test(msg)) {
      batteryRetryAt = Date.now() + BATTERY_RETRY_MS;
      // Kalau binari-nya ADA tapi tetap "not found", yang salah PATH-nya
      // (panel dijalankan tanpa environment Termux), bukan paketnya.
      let ada = false;
      try { ada = fs.existsSync(TERMUX_PREFIX + '/bin/termux-battery-status'); } catch (e) {}
      batteryLastError = ada ? 'PATH Termux tidak terbaca — restart via pm2' : 'pkg install termux-api';
      return { error: batteryLastError };
    }
    // terpasang tapi app Termux:API belum ada / izin ditolak -> perintah menggantung lalu timeout
    batteryLastError = /timed out|ETIMEDOUT/i.test(msg) ? 'Butuh app Termux:API' : ('Gagal: ' + msg.slice(0, 120));
    return { error: batteryLastError };
  }
}
// Diagnostik baterai: jalankan tiap langkah dan laporkan apa adanya
async function apiBatteryDebug(res) {
  const steps = [];
  const run = async (label, cmd, timeout) => {
    const t0 = Date.now();
    try {
      const out = await execTimeout(cmd, { timeout: timeout || 8000 });
      steps.push({ step: label, cmd, ok: true, ms: Date.now() - t0, out: String(out).slice(0, 400).trim() });
      return out;
    } catch (e) {
      steps.push({ step: label, cmd, ok: false, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 400).trim() });
      return null;
    }
  };

  await run('1. Paket termux-api terpasang?', 'command -v termux-battery-status || echo TIDAK_ADA');
  await run('2. Daftar paket', 'pkg list-installed 2>/dev/null | grep -i termux-api || echo TIDAK_TERPASANG');
  await run('3. Ambil status baterai (10 dtk)', 'termux-battery-status', 10000);
  await run('4. Aplikasi Termux:API terpasang?',
    'pm list packages 2>/dev/null | grep com.termux.api || echo APP_TIDAK_ADA');

  sendJson(res, 200, {
    shell: SHELL || '/bin/sh (default)',
    batteryRetryAt: batteryRetryAt ? new Date(batteryRetryAt).toISOString() : null,
    batteryLastError,
    hasil: await getBattery(),
    steps,
    petunjuk: [
      'Langkah 1/2 gagal -> jalankan: pkg install termux-api',
      'Langkah 4 APP_TIDAK_ADA -> pasang APK Termux:API dari F-Droid (HARUS sumber yang sama dengan Termux)',
      'Langkah 3 menggantung/timeout -> buka Termux, jalankan termux-battery-status manual lalu izinkan popup permission',
    ],
  });
}

async function getStatsData() {
  const load = os.loadavg();
  const total = os.totalmem(), free = os.freemem();
  let disk = null;
  try {
    const out = await execTimeout('df -k ' + sq(ROOT), { timeout: 5000 });
    const cols = out.trim().split('\n').pop().split(/\s+/);
    if (cols.length >= 6) {
      const tot = parseInt(cols[1], 10) * 1024, used = parseInt(cols[2], 10) * 1024, av = parseInt(cols[3], 10) * 1024;
      disk = { total: tot, used, free: av, percent: tot ? Math.round((used / tot) * 100) : 0 };
    }
  } catch { /* ignore */ }
  const battery = await getBattery();
  return {
    hostname: os.hostname(), uptime: Math.floor(os.uptime()), time: Date.now(),
    cpu: { load1: +load[0].toFixed(2), load5: +load[1].toFixed(2), load15: +load[2].toFixed(2), cores: cpuCores() },
    mem: { total, free, used: total - free, percent: total ? Math.round(((total - free) / total) * 100) : 0 },
    disk, battery,
    sites: sites.map((s) => ({ name: s.name, type: s.type, port: s.port, running: running.has(s.id) })),
  };
}
async function apiStats(res) {
  sendJson(res, 200, await getStatsData());
}
// ================= Nginx reverse proxy =================
const NGINX_FILE = path.join(DATA_DIR, 'nginx.json');
const NGINX_SITES_DIR = path.join(DATA_DIR, 'nginx', 'sites');
let nginxProxies = [];
function loadNginx() {
  try { nginxProxies = JSON.parse(fs.readFileSync(NGINX_FILE, 'utf8')).proxies || []; }
  catch { nginxProxies = []; }
}
function saveNginx() {
  fs.writeFileSync(NGINX_FILE, JSON.stringify({ proxies: nginxProxies }, null, 2), { mode: 0o600 });
}
loadNginx();
function termuxPrefix() { return process.env.PREFIX || '/data/data/com.termux/files/usr'; }
function nginxConfBlock(p) {
  return 'server {\n' +
    '    listen ' + p.listenPort + ';\n' +
    '    server_name ' + (p.domain || '_') + ';\n' +
    '    location / {\n' +
    '        proxy_pass http://127.0.0.1:' + p.targetPort + ';\n' +
    '        proxy_set_header Host $host;\n' +
    '        proxy_set_header X-Real-IP $remote_addr;\n' +
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n' +
    '    }\n}\n';
}
function ensureNginxInclude() {
  const confPath = path.join(termuxPrefix(), 'etc', 'nginx', 'nginx.conf');
  if (!fs.existsSync(confPath)) throw new Error('nginx.conf not found. Install nginx first via the Store menu.');
  let txt = fs.readFileSync(confPath, 'utf8');
  if (txt.includes(NGINX_SITES_DIR)) return;
  const hi = txt.indexOf('http {');
  if (hi === -1) throw new Error('http block not found in nginx.conf');
  let depth = 0, i = txt.indexOf('{', hi);
  for (; i < txt.length; i++) {
    if (txt[i] === '{') depth++;
    else if (txt[i] === '}') { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error('nginx.conf rusak (kurung tak seimbang)');
  const line = '    include ' + NGINX_SITES_DIR + '/*.conf;\n';
  fs.writeFileSync(confPath, txt.slice(0, i) + line + txt.slice(i), 'utf8');
}
async function nginxWriteAll() {
  fs.mkdirSync(NGINX_SITES_DIR, { recursive: true });
  for (const f of fs.readdirSync(NGINX_SITES_DIR)) {
    if (f.startsWith('panel-') && f.endsWith('.conf')) fs.unlinkSync(path.join(NGINX_SITES_DIR, f));
  }
  for (const p of nginxProxies) {
    fs.writeFileSync(path.join(NGINX_SITES_DIR, 'panel-' + p.id + '.conf'), nginxConfBlock(p));
  }
  ensureNginxInclude();
  const t = await execOk('nginx -t', 15000);
  if (!t.ok) throw new Error('nginx -t failed: ' + t.out.slice(-500));
}
async function nginxTryReload() {
  const r = await execOk('nginx -s reload', 10000);
  return r.ok;
}
async function apiNginxStatus(res) {
  const r = await execOk('pgrep -x nginx >/dev/null 2>&1', 5000);
  sendJson(res, 200, { running: r.ok });
}
async function apiNginxService(req, res) {
  const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const act = body.action;
  if (act === 'start') {
    await mustBin('nginx', 'nginx is not installed. Install it first via the Store menu.');
    const r = await execOk('nginx', 10000);
    if (!r.ok) throw new Error('Failed to start nginx: ' + r.out.slice(-500));
  } else if (act === 'stop') {
    const r = await execOk('nginx -s stop', 10000);
    if (!r.ok) throw new Error('Failed to stop nginx: ' + r.out.slice(-500));
  } else if (act === 'reload') {
    await mustBin('nginx', 'nginx is not installed. Install it first via the Store menu.');
    const t = await execOk('nginx -t', 15000);
    if (!t.ok) throw new Error('nginx -t failed: ' + t.out.slice(-500));
    await execOk('nginx -s reload', 10000);
  } else throw new Error('Unknown action');
  sendJson(res, 200, { ok: true });
}
function apiNginxList(res) {
  sendJson(res, 200, { proxies: nginxProxies });
}
async function apiNginxCreate(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const name = (b.name || '').trim();
  if (!name) throw new Error('Name is required');
  const listenPort = parseInt(b.listenPort, 10);
  if (!listenPort || listenPort < 1024 || listenPort > 65535) {
    throw new Error('Listen port must be 1024-65535 (Termux cannot bind <1024 without root)');
  }
  const targetPort = parseInt(b.targetPort, 10);
  if (!targetPort || targetPort < 1 || targetPort > 65535) throw new Error('Invalid target port');
  const domain = (b.domain || '').trim();
  if (domain && !/^[a-zA-Z0-9.*_-]+$/.test(domain)) throw new Error('Invalid domain');
  if (nginxProxies.some((p) => p.listenPort === listenPort)) throw new Error('Listen port is already used by another proxy');
  const p = { id: crypto.randomBytes(4).toString('hex'), name, listenPort, domain, targetPort, created: Date.now() };
  nginxProxies.push(p);
  saveNginx();
  try { await nginxWriteAll(); } catch (e) { nginxProxies = nginxProxies.filter((x) => x.id !== p.id); saveNginx(); throw e; }
  await nginxTryReload();
  sendJson(res, 200, { ok: true, proxy: p });
}
async function apiNginxDelete(res, id) {
  nginxProxies = nginxProxies.filter((p) => p.id !== id);
  saveNginx();
  try { await nginxWriteAll(); } catch { /* ignore, conf already deleted */ }
  await nginxTryReload();
  sendJson(res, 200, { ok: true });
}
// ================= Cron scheduler =================
function cronSpawnWrite(lines) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', 'crontab -']);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('crontab failed: ' + err.slice(-300))));
    child.stdin.write(lines.join('\n') + '\n');
    child.stdin.end();
  });
}
async function cronLines() {
  const r = await execOk('crontab -l', 8000);
  if (!r.ok) return [];
  return r.out.split('\n');
}
function cronParseLine(line) {
  let enabled = true, s = line;
  if (s.trimStart().startsWith('#')) {
    enabled = false;
    s = s.replace(/^(\s*)#/, '$1');
  }
  const m = s.match(/#\s*panel:([0-9a-f]+):(.*)$/);
  if (!m) return null;
  const head = s.slice(0, m.index).trim().split(/\s+/);
  if (head.length < 6) return null;
  return { id: m[1], name: (m[2] || '').trim(), schedule: head.slice(0, 5).join(' '), command: head.slice(5).join(' '), enabled };
}
function cronJobLine(j) {
  return j.schedule + ' ' + j.command + ' # panel:' + j.id + ':' + j.name.replace(/[\r\n#]/g, ' ');
}
async function apiCronStatus(res) {
  const r = await execOk('pgrep -x crond >/dev/null 2>&1', 5000);
  sendJson(res, 200, { running: r.ok });
}
async function apiCronService(req, res) {
  const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  if (body.action === 'start') {
    await mustBin('crond', 'crond is not installed. Install Cronie via the Store menu.');
    const child = spawn('crond', [], { detached: true, stdio: 'ignore' });
    child.unref();
    sendJson(res, 200, { ok: true });
  } else if (body.action === 'stop') {
    await execOk('pkill -x crond', 5000);
    sendJson(res, 200, { ok: true });
  } else throw new Error('Unknown action');
}
async function apiCronJobs(res) {
  const jobs = [];
  for (const l of await cronLines()) {
    const j = cronParseLine(l);
    if (j) jobs.push(j);
  }
  sendJson(res, 200, { jobs });
}
async function apiCronAdd(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const name = (b.name || '').trim() || 'job';
  const schedule = (b.schedule || '').trim();
  const command = (b.command || '').trim();
  if (!/^(\S+\s+){4}\S+$/.test(schedule)) throw new Error('Jadwal harus 5 field cron');
  if (!command) throw new Error('Command wajib diisi');
  await mustBin('crontab', 'crontab is not available on this system');
  const lines = await cronLines();
  const job = { id: crypto.randomBytes(4).toString('hex'), name, schedule, command };
  lines.push(cronJobLine(job));
  await cronSpawnWrite(lines);
  sendJson(res, 200, { ok: true, job });
}
async function apiCronDelete(res, id) {
  const lines = await cronLines();
  const kept = lines.filter((l) => { const j = cronParseLine(l); return !j || j.id !== id; });
  await cronSpawnWrite(kept);
  sendJson(res, 200, { ok: true });
}
async function apiCronToggle(res, id) {
  const lines = await cronLines();
  const out = lines.map((l) => {
    const j = cronParseLine(l);
    if (!j || j.id !== id) return l;
    if (j.enabled) return '#' + l;
    return l.replace(/^(\s*)#/, '$1');
  });
  await cronSpawnWrite(out);
  sendJson(res, 200, { ok: true });
}
// ================= Backup & restore =================
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
function backupStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function backupMeta(name) {
  try { return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, name + '.json'), 'utf8')); }
  catch { return null; }
}
async function apiBackupList(res) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf8'));
      const st = fs.statSync(path.join(BACKUP_DIR, meta.file));
      out.push({ name: meta.name, file: meta.file, type: meta.type, source: meta.source, size: st.size, mtime: st.mtimeMs, created: meta.created });
    } catch { /* ignore */ }
  }
  out.sort((a, b) => b.created - a.created);
  sendJson(res, 200, { backups: out });
}
async function apiBackupCreate(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const type = b.type;
  if (type !== 'folder' && type !== 'mysql' && type !== 'postgres') throw new Error('Invalid type');
  let name = (b.name || '').trim() || ('backup-' + backupStamp());
  name = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!name) throw new Error('Invalid name');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (backupMeta(name)) throw new Error('Backup name already taken');
  let file, source;
  if (type === 'folder') {
    const src = safePath(b.source || '.');
    const st = await fsp.stat(src).catch(() => null);
    if (!st) throw new Error('Source not found');
    await mustBin('zip', 'Package "zip" is not installed — install it first via the Store menu');
    file = name + '.zip';
    source = relOf(src);
    await execTimeout('zip -rq ' + sq(path.join(BACKUP_DIR, file)) + ' .', { cwd: src, timeout: 120000 });
  } else {
    const dbName = (b.source || '').trim();
    if (!dbName) throw new Error('Nama database wajib diisi');
    const cfg = normCfg(type, (loadDbConfigs()[type]) || {});
    source = dbName;
    file = name + '.sql';
    const dest = path.join(BACKUP_DIR, file);
    if (type === 'mysql') {
      await mustBin('mysqldump', 'mysqldump not found. Install mysql via the Store menu.');
      const pw = cfg.password ? ' --password=' + sq(cfg.password) : '';
      await execTimeout('mysqldump -h ' + sq(cfg.host) + ' -P ' + cfg.port + ' -u ' + sq(cfg.user) + pw + ' ' + sq(dbName) + ' > ' + sq(dest), { timeout: 120000 });
    } else {
      await mustBin('pg_dump', 'pg_dump not found. Install postgres via the Store menu.');
      await execTimeout('PGPASSWORD=' + sq(cfg.password) + ' pg_dump -h ' + sq(cfg.host) + ' -p ' + cfg.port + ' -U ' + sq(cfg.user) + ' -d ' + sq(dbName) + ' > ' + sq(dest), { timeout: 120000 });
    }
  }
  fs.writeFileSync(path.join(BACKUP_DIR, name + '.json'), JSON.stringify({ name, file, type, source, created: Date.now() }, null, 2), { mode: 0o600 });
  sendJson(res, 200, { ok: true, name });
}
function apiBackupDownload(res, name) {
  const meta = backupMeta(name);
  if (!meta || /[^a-zA-Z0-9._-]/.test(name)) throw new Error('Backup not found');
  const full = path.join(BACKUP_DIR, meta.file);
  const st = fs.statSync(full);
  if (!st.isFile()) throw new Error('File backup hilang');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': 'attachment; filename="' + meta.file.replace(/"/g, '') + '"',
  });
  fs.createReadStream(full).pipe(res);
}
function apiBackupDelete(res, name) {
  const meta = backupMeta(name);
  if (!meta || /[^a-zA-Z0-9._-]/.test(name)) throw new Error('Backup not found');
  try { fs.unlinkSync(path.join(BACKUP_DIR, meta.file)); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(BACKUP_DIR, name + '.json')); } catch { /* ignore */ }
  sendJson(res, 200, { ok: true });
}
async function apiBackupRestore(req, res, name) {
  const meta = backupMeta(name);
  if (!meta || /[^a-zA-Z0-9._-]/.test(name)) throw new Error('Backup not found');
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const full = path.join(BACKUP_DIR, meta.file);
  if (meta.type === 'folder') {
    const target = safePath(b.targetPath || meta.source || '.');
    await mustBin('unzip', 'Package "unzip" is not installed — install it first via the Store menu');
    fs.mkdirSync(target, { recursive: true });
    await execTimeout('unzip -o ' + sq(full) + ' -d ' + sq(target), { timeout: 120000 });
  } else {
    const cfg = normCfg(meta.type, (loadDbConfigs()[meta.type]) || {});
    if (meta.type === 'mysql') {
      await mustBin('mysql', 'mysql not found. Install mysql via the Store menu.');
      const pw = cfg.password ? ' --password=' + sq(cfg.password) : '';
      await execTimeout('mysql -h ' + sq(cfg.host) + ' -P ' + cfg.port + ' -u ' + sq(cfg.user) + pw + ' ' + sq(meta.source) + ' < ' + sq(full), { timeout: 120000 });
    } else {
      await mustBin('psql', 'psql not found. Install postgres via the Store menu.');
      await execTimeout('PGPASSWORD=' + sq(cfg.password) + ' psql -h ' + sq(cfg.host) + ' -p ' + cfg.port + ' -U ' + sq(cfg.user) + ' -d ' + sq(meta.source) + ' < ' + sq(full), { timeout: 120000 });
    }
  }
  sendJson(res, 200, { ok: true });
}
// ================= File manager tambahan =================
async function apiFileZip(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const full = safePath(b.path || '');
  if (full === ROOT) throw new Error('Cannot zip root');
  await mustBin('zip', 'Package "zip" is not installed — install it first via the Store menu');
  await execTimeout('zip -rq ' + sq(full + '.zip') + ' ' + sq(path.basename(full)), { cwd: path.dirname(full), timeout: 60000 });
  sendJson(res, 200, { ok: true, zipPath: relOf(full + '.zip') });
}
async function apiFileUnzip(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const full = safePath(b.path || '');
  if (!/\.zip$/i.test(full)) throw new Error('Bukan file zip');
  await mustBin('unzip', 'Package "unzip" is not installed — install it first via the Store menu');
  await execTimeout('unzip -o ' + sq(full) + ' -d ' + sq(path.dirname(full)), { timeout: 60000 });
  sendJson(res, 200, { ok: true });
}
const PREVIEW_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
async function apiFilePreview(url, res) {
  const full = safePath(url.searchParams.get('path') || '');
  const mime = PREVIEW_MIME[path.extname(full).toLowerCase()];
  if (!mime) throw new Error('Preview hanya untuk gambar');
  const st = await fsp.stat(full);
  if (!st.isFile() || st.size > 20 * 1024 * 1024) throw new Error('Invalid file');
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size });
  fs.createReadStream(full).pipe(res);
}
// ================= Health check website + notif =================
const siteHealth = new Map();
function healthCheckOnce() {
  for (const s of sites) {
    if (!running.has(s.id)) { siteHealth.delete(s.id); continue; }
    const req = http.get({ host: '127.0.0.1', port: s.port, path: '/', timeout: 5000 }, (r) => {
      r.resume();
      if (siteHealth.get(s.id)) sendTelegram('Website "' + s.name + '" recovered (port ' + s.port + ')');
      siteHealth.set(s.id, false);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {
      if (!siteHealth.get(s.id)) sendTelegram('Website "' + s.name + '" DOWN (port ' + s.port + ')');
      siteHealth.set(s.id, true);
    });
  }
}
setInterval(() => { try { healthCheckOnce(); } catch (e) { console.log('Health check failed:', e.message); } }, 60000);

// ================= Cloudflare Tunnel (auto tunneling) =================
// Satu saklar di UI = tunnel langsung jalan + diingat, sehingga panel yang
// restart (mis. via PM2 resurrect) otomatis menyalakan lagi tunnel yang sama.
// Dua mode:
//   - quick: `cloudflared tunnel --url ...` tanpa akun Cloudflare; URL
//     *.trycloudflare.com acak, berubah tiap tunnel restart.
//   - token: tunnel bernama dari dashboard Cloudflare (Zero Trust);
//     tempel token tunnel-nya, hostname tetap sesuai konfigurasi di CF.
// Token TIDAK PERNAH dikembalikan lewat API; yang disimpan di disk pun
// memakai mode 0600 seperti config panel lainnya.
const TUNNEL_FILE = path.join(DATA_DIR, 'tunnel.json');
function loadTunnelCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8'));
    return { enabled: !!c.enabled, mode: c.mode === 'token' ? 'token' : 'quick',
      targetPort: parseInt(c.targetPort, 10) || PORT,
      token: String(c.token || ''), hostname: String(c.hostname || '') };
  } catch { return { enabled: false, mode: 'quick', targetPort: PORT, token: '', hostname: '' }; }
}
function saveTunnelCfg(c) {
  fs.writeFileSync(TUNNEL_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}
let tunnelCfg = loadTunnelCfg();
let tunnelProc = null, tunnelUrl = '', tunnelLogs = [], tunnelStartedAt = 0;
let tunnelConnected = false; // true sejak log "Registered tunnel connection" sampai tunnel berhenti
let tunnelStopping = false, tunnelRestartTimer = null;
function tunnelPushLog(line) {
  tunnelLogs.push(line);
  if (tunnelLogs.length > 200) tunnelLogs.splice(0, tunnelLogs.length - 200);
}
function tunnelPublic() {
  return { running: !!tunnelProc, enabled: tunnelCfg.enabled, mode: tunnelCfg.mode,
    targetPort: tunnelCfg.targetPort, hostname: tunnelCfg.hostname,
    hasToken: !!tunnelCfg.token, url: tunnelUrl, connected: tunnelConnected,
    startedAt: tunnelStartedAt, logs: tunnelLogs.join('').slice(-4000) };
}
async function startTunnel(cfg) {
  if (tunnelProc) return tunnelPublic();
  await mustBin('cloudflared', 'cloudflared is not installed. Install it first via the Store menu.');
  const targetPort = parseInt(cfg.targetPort, 10);
  if (!targetPort || targetPort < 1 || targetPort > 65535) throw new Error('Target port must be 1-65535');
  let args;
  if (cfg.mode === 'token') {
    const token = String(cfg.token || '').trim();
    if (!token || !/^[A-Za-z0-9._-]+$/.test(token)) {
      throw new Error('Token Cloudflare wajib diisi (tempel token tunnel dari dashboard Cloudflare Zero Trust)');
    }
    args = ['tunnel', '--no-autoupdate', 'run', '--token', token];
  } else {
    args = ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + targetPort];
  }
  tunnelCfg = { enabled: true, mode: cfg.mode, targetPort, token: cfg.token || '', hostname: cfg.hostname || '' };
  saveTunnelCfg(tunnelCfg);
  tunnelStopping = false;
  if (tunnelRestartTimer) { clearTimeout(tunnelRestartTimer); tunnelRestartTimer = null; }
  tunnelUrl = ''; tunnelConnected = false; tunnelStartedAt = Date.now();
  const child = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  tunnelProc = child;
  let buf = '';
  const onData = (d) => {
    buf += d.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      tunnelPushLog(line + '\n');
      if (line.includes('Registered tunnel connection')) tunnelConnected = true;
      if (!tunnelUrl) {
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) tunnelUrl = m[0];
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => {
    tunnelPushLog('--- tunnel failed to start: ' + e.message + ' ---\n');
    tunnelProc = null; tunnelConnected = false;
    tunnelCfg.enabled = false; saveTunnelCfg(tunnelCfg);
  });
  child.on('exit', (code) => {
    tunnelPushLog('--- tunnel stopped (exit ' + code + ') ---\n');
    tunnelProc = null; tunnelConnected = false;
    // Auto-reconnect: kalau saklar masih ON (bukan stop manual), nyalakan lagi.
    if (!tunnelStopping && tunnelCfg.enabled && !tunnelRestartTimer) {
      tunnelRestartTimer = setTimeout(() => {
        tunnelRestartTimer = null;
        if (tunnelCfg.enabled && !tunnelProc) {
          startTunnel(tunnelCfg).catch((e) => tunnelPushLog('--- auto-restart failed: ' + e.message + ' ---\n'));
        }
      }, 5000);
    }
  });
  return tunnelPublic();
}
function stopTunnel() {
  tunnelStopping = true;
  if (tunnelRestartTimer) { clearTimeout(tunnelRestartTimer); tunnelRestartTimer = null; }
  tunnelCfg.enabled = false; saveTunnelCfg(tunnelCfg);
  if (tunnelProc) { try { tunnelProc.kill(); } catch { /* ignore */ } tunnelProc = null; }
  tunnelUrl = ''; tunnelConnected = false;
  tunnelPushLog('--- tunnel stopped by user ---\n');
  return tunnelPublic();
}
async function apiTunnelGet(res) {
  sendJson(res, 200, tunnelPublic());
}
async function apiTunnelStart(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const mode = b.mode === 'token' ? 'token' : 'quick';
  // Token kosong = pakai token yang sudah tersimpan (kalau ada).
  const token = (b.token || '').trim() || (mode === 'token' ? tunnelCfg.token : '');
  const cfg = { mode,
    targetPort: b.targetPort ? parseInt(b.targetPort, 10) : (mode === tunnelCfg.mode ? tunnelCfg.targetPort : PORT),
    token, hostname: (b.hostname || '').trim() || tunnelCfg.hostname };
  sendJson(res, 200, Object.assign({ ok: true }, await startTunnel(cfg)));
}
function apiTunnelStop(res) {
  sendJson(res, 200, Object.assign({ ok: true }, stopTunnel()));
}



// ================= phpMyAdmin (ala aaPanel) =================
// phpMyAdmin dikelola panel sebagai service lokal, sama polanya dengan
// situs PHP: diunduh sekali (zip "latest" resmi dari phpmyadmin.net),
// diekstrak ke ~/.termux-panel/phpmyadmin, lalu dijalankan dengan
// `php -S 127.0.0.1:<port> -t <dir>`. Login OTOMATIS: config.inc.php
// ditulis panel dari kredensial MySQL yang tersimpan di panel (auth_type
// config), jadi tombol phpMyAdmin per database langsung membuka
// <url>/index.php?db=<nama> tanpa halaman login.
// Keamanan: bind HANYA 127.0.0.1. Domain phpMyAdmin via tunnel (pmaDomain)
// adalah SATU-SATUNYA pengecualian yang disengaja: selama domain itu aktif,
// pmaWriteConfig() menulis auth_type='cookie' (form login, tanpa kredensial
// tersimpan) menggantikan auto-login — karena URL publik + auto-login root
// = siapa pun langsung jadi admin DB. Nonaktifkan domain = kembali ke
// auth config (auto-login lokal) dan route + DNS dihapus.
const PMA_FILE = path.join(DATA_DIR, 'phpmyadmin.json');
const PMA_DIR = path.join(DATA_DIR, 'phpmyadmin');
const PMA_ZIP_URL = process.env.PMA_ZIP_URL || 'https://www.phpmyadmin.net/downloads/phpMyAdmin-latest-all-languages.zip';
function loadPmaCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(PMA_FILE, 'utf8'));
    return { port: parseInt(c.port, 10) || 8081, autoStart: !!c.autoStart,
      blowfish: typeof c.blowfish === 'string' && c.blowfish ? c.blowfish : '' };
  } catch { return { port: 8081, autoStart: false, blowfish: '' }; }
}
function savePmaCfg() {
  fs.writeFileSync(PMA_FILE, JSON.stringify(pmaCfg, null, 2), { mode: 0o600 });
}
let pmaCfg = loadPmaCfg();
let pmaProc = null, pmaStartedAt = 0;
function pmaInstalled() {
  try { return fs.statSync(path.join(PMA_DIR, 'index.php')).isFile(); }
  catch { return false; }
}
function pmaPublic() {
  return { installed: pmaInstalled(), running: !!pmaProc,
    url: 'http://127.0.0.1:' + pmaCfg.port, port: pmaCfg.port,
    autoStart: pmaCfg.autoStart, startedAt: pmaStartedAt };
}
function phpEscape(v) {
  return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function pmaWriteConfig() {
  // Kredensial diambil dari config MySQL panel saat ini (bukan hardcode),
  // jadi kalau user mengubah kredensial DB lalu me-restart phpMyAdmin,
  // login otomatisnya ikut berubah. Blowfish dibuat sekali dan disimpan.
  // PENGECUALIAN: selama domain phpMyAdmin via tunnel aktif, pakai
  // auth_type='cookie' (form login, kredensial TIDAK ditulis ke file) —
  // php -S membaca ulang config.inc.php tiap request, jadi pergantian mode
  // ini berlaku seketika tanpa restart phpMyAdmin.
  if (!pmaCfg.blowfish) { pmaCfg.blowfish = crypto.randomBytes(16).toString('hex'); savePmaCfg(); }
  const cfg = dbCfgFor('mysql');
  const tunneled = !!(cfCfg && cfCfg.pmaDomain && cfCfg.pmaDomain.enabled);
  const lines = [
    '<?php',
    "$cfg['blowfish_secret'] = '" + phpEscape(pmaCfg.blowfish) + "';",
    '$i = 0;',
    '$i++;',
    "$cfg['Servers'][$i]['auth_type'] = '" + (tunneled ? 'cookie' : 'config') + "';",
    "$cfg['Servers'][$i]['host'] = '" + phpEscape(cfg.host || '127.0.0.1') + "';",
    "$cfg['Servers'][$i]['port'] = '" + phpEscape(cfg.port || 3306) + "';",
  ];
  if (!tunneled) {
    lines.push(
      "$cfg['Servers'][$i]['user'] = '" + phpEscape(cfg.user || 'root') + "';",
      "$cfg['Servers'][$i]['password'] = '" + phpEscape(cfg.password || '') + "';",
      "$cfg['Servers'][$i]['AllowNoPassword'] = true;",
    );
  } else {
    lines.push("$cfg['Servers'][$i]['AllowNoPassword'] = false;");
  }
  lines.push("$cfg['Servers'][$i]['compress'] = false;");
  fs.writeFileSync(path.join(PMA_DIR, 'config.inc.php'), lines.join('\n') + '\n', { mode: 0o600 });
}
function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: EXEC_ENV });
    let out = '', errOut = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error((errOut || ('exit ' + code)).trim().slice(0, 500)));
    });
  });
}
async function pmaStart() {
  if (pmaProc) return pmaPublic();
  if (!pmaInstalled()) throw new Error('phpMyAdmin belum terpasang — klik Pasang dulu');
  const hasPhp = await execCheck('command -v php >/dev/null 2>&1');
  if (!hasPhp) throw new Error('PHP belum terpasang — pasang dulu lewat Store (pkg install php)');
  pmaWriteConfig();
  const child = spawn('php', ['-S', '127.0.0.1:' + pmaCfg.port, '-t', PMA_DIR], { cwd: PMA_DIR, env: EXEC_ENV });
  pmaProc = child; pmaStartedAt = Date.now();
  child.on('exit', () => { if (pmaProc === child) pmaProc = null; });
  child.on('error', () => { if (pmaProc === child) pmaProc = null; });
  return pmaPublic();
}
function pmaStop() {
  if (pmaProc) { try { pmaProc.kill(); } catch { /* ignore */ } pmaProc = null; }
  return pmaPublic();
}
async function pmaInstall() {
  if (pmaInstalled()) throw new Error('phpMyAdmin sudah terpasang');
  const hasPhp = await execCheck('command -v php >/dev/null 2>&1');
  if (!hasPhp) throw new Error('PHP belum terpasang — pasang dulu lewat Store (pkg install php)');
  const hasUnzip = await execCheck('command -v unzip >/dev/null 2>&1');
  if (!hasUnzip) throw new Error('unzip belum terpasang — pasang dulu lewat Store (pkg install unzip)');
  const warnings = [];
  try {
    const mods = await runCmd('php', ['-m']);
    if (!/\bmysqli\b/.test(mods)) warnings.push('Ekstensi PHP mysqli tidak terdeteksi — phpMyAdmin mungkin gagal konek ke MariaDB.');
    if (!/\bmbstring\b/.test(mods)) warnings.push('Ekstensi PHP mbstring tidak terdeteksi — phpMyAdmin mungkin error.');
  } catch { /* cek ekstensi best-effort saja */ }
  // Unduh -> ekstrak ke folder sementara -> pindahkan ke PMA_DIR hanya
  // bila sukses, supaya instalasi gagal tidak meninggalkan folder setengah.
  const zipPath = path.join(DATA_DIR, 'phpmyadmin.zip');
  const tmpDir = path.join(DATA_DIR, 'phpmyadmin-tmp');
  try {
    const r = await fetch(PMA_ZIP_URL);
    if (!r.ok) throw new Error('Unduhan gagal (HTTP ' + r.status + ')');
    fs.writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    await runCmd('unzip', ['-q', zipPath, '-d', tmpDir]);
    const inner = fs.readdirSync(tmpDir).find((d) => d.startsWith('phpMyAdmin-') && fs.statSync(path.join(tmpDir, d)).isDirectory());
    const src = inner ? path.join(tmpDir, inner) : tmpDir;
    if (!fs.existsSync(path.join(src, 'index.php'))) throw new Error('Zip phpMyAdmin tidak berisi index.php');
    fs.rmSync(PMA_DIR, { recursive: true, force: true });
    fs.renameSync(src, PMA_DIR);
  } finally {
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  pmaWriteConfig();
  pmaCfg.autoStart = true; savePmaCfg();
  await pmaStart();
  return Object.assign({ ok: true, warnings }, pmaPublic());
}
async function apiPmaGet(res) { sendJson(res, 200, Object.assign({ ok: true }, pmaPublic())); }
async function apiPmaInstall(req, res) {
  try { sendJson(res, 200, await pmaInstall()); }
  catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
}
async function apiPmaStart(req, res) {
  try { sendJson(res, 200, Object.assign({ ok: true }, await pmaStart())); }
  catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
}
function apiPmaStop(res) { sendJson(res, 200, Object.assign({ ok: true }, pmaStop())); }
async function apiPmaConfig(req, res) {
  try {
    const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
    const port = parseInt(b.port, 10);
    if (!port || port < 1024 || port > 65535) throw new Error('Port harus 1024–65535');
    if (port === PORT) throw new Error('Port bentrok dengan port panel');
    const wasRunning = !!pmaProc;
    const portChanged = port !== pmaCfg.port;
    pmaCfg.port = port; pmaCfg.autoStart = !!b.autoStart; savePmaCfg();
    if (wasRunning && portChanged) { pmaStop(); await pmaStart(); }
    // Port berubah sementara domain tunnel aktif: route-nya harus ikut
    // pindah, kalau tidak tunnel tetap mengarah ke port lama (mati).
    // Gagal republish tidak menggagalkan simpan config — tapi dilaporkan
    // sebagai peringatan supaya user bisa toggle domain off/on.
    let warnings = [];
    if (portChanged && pmaDomainCfg().enabled && pmaDomainCfg().hostname) {
      try { await cfPublishRouteResilient(pmaDomainCfg().hostname, 'http://127.0.0.1:' + pmaCfg.port); }
      catch (e) { warnings.push('Route tunnel phpMyAdmin gagal diperbarui ke port baru (' + e.message + ') — nonaktifkan lalu aktifkan lagi domainnya.'); }
    }
    sendJson(res, 200, Object.assign({ ok: true, warnings }, pmaPublic()));
  } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
}


// ================= Cloudflare API: domain otomatis =================
// Mode tunnel per-site keempat (selain quick/token): 'auto'. Sekali
// konfigurasi API disimpan di Settings, tiap site cukup ketik subdomain —
// panel yang membuat/memperbarui route + DNS CNAME di Cloudflare lewat
// API v4, lalu menjalankan SATU tunnel bersama bernama `tunnelName`
// (default "terwo") untuk semua site mode auto. Satu tunnel, banyak
// hostname: ingress di CF di-merge (rule hostname lain dipertahankan,
// catch-all selalu terakhir), bukan ditimpa buta.
// Kredensial disimpan di cloudflare.json (0600) dan TIDAK PERNAH
// dikembalikan lewat API (hanya flag hasApiToken/hasTunnelToken).
// Env CF_API_BASE_URL hanya untuk pengujian (server CF API palsu lokal);
// default-nya api.cloudflare.com resmi.
const CF_FILE = path.join(DATA_DIR, 'cloudflare.json');
function loadCfCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(CF_FILE, 'utf8'));
    return { apiToken: String(c.apiToken || ''), accountId: String(c.accountId || ''),
      zoneId: String(c.zoneId || ''), domain: String(c.domain || ''),
      tunnelId: String(c.tunnelId || ''), tunnelToken: String(c.tunnelToken || ''),
      tunnelName: String(c.tunnelName || 'terwo'),
      // panelDomain WAJIB ikut dimuat: kalau tidak, restart panel akan
      // menghilangkan domain panel yang aktif (runner tak ikut nyala lagi).
      // pmaDomain sama wajibnya, dengan alasan yang sama.
      panelDomain: (c.panelDomain && typeof c.panelDomain === 'object')
        ? { enabled: !!c.panelDomain.enabled, hostname: String(c.panelDomain.hostname || '') }
        : { enabled: false, hostname: '' },
      pmaDomain: (c.pmaDomain && typeof c.pmaDomain === 'object')
        ? { enabled: !!c.pmaDomain.enabled, hostname: String(c.pmaDomain.hostname || '') }
        : { enabled: false, hostname: '' } };
  } catch { return { apiToken: '', accountId: '', zoneId: '', domain: '', tunnelId: '', tunnelToken: '', tunnelName: 'terwo', panelDomain: { enabled: false, hostname: '' }, pmaDomain: { enabled: false, hostname: '' } }; }
}
function saveCfCfg() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CF_FILE, JSON.stringify(cfCfg, null, 2), { mode: 0o600 });
}
let cfCfg = loadCfCfg();
function cfPublic() {
  return { configured: !!(cfCfg.apiToken && cfCfg.accountId && cfCfg.zoneId && cfCfg.domain),
    hasApiToken: !!cfCfg.apiToken, accountId: cfCfg.accountId, zoneId: cfCfg.zoneId,
    domain: cfCfg.domain, tunnelName: cfCfg.tunnelName || 'terwo', tunnelId: cfCfg.tunnelId,
    hasTunnelToken: !!cfCfg.tunnelToken, tunnelReady: !!(cfCfg.tunnelId && cfCfg.tunnelToken) };
}
function cfApi(method, p, body) {
  return new Promise((resolve, reject) => {
    const base = new URL((process.env.CF_API_BASE_URL || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, ''));
    const lib = base.protocol === 'http:' ? require('http') : require('https');
    const data = body ? JSON.stringify(body) : null;
    const req = lib.request({ hostname: base.hostname, port: base.port || (base.protocol === 'http:' ? 80 : 443),
      path: (base.pathname.replace(/\/+$/, '') || '') + p, method,
      headers: Object.assign({ Authorization: 'Bearer ' + cfCfg.apiToken, 'Content-Type': 'application/json' },
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(raw); } catch { return reject(new Error('Cloudflare API: respons bukan JSON (HTTP ' + res.statusCode + ')')); }
        if (res.statusCode >= 400 || j.success === false) {
          const msgs = Array.isArray(j.errors) && j.errors.length ? j.errors.map((e) => e.message).join('; ') : ('HTTP ' + res.statusCode);
          const codes = Array.isArray(j.errors) && j.errors.length ? j.errors.map((e) => e.code).filter((c) => c !== undefined).join(',') : '';
          return reject(new Error('Cloudflare API (' + msgs + ')' + (codes ? ' [code ' + codes + ']' : '') + ' (HTTP ' + res.statusCode + ')'));
        }
        resolve(j.result);
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Cloudflare API: timeout 20 detik')));
    if (data) req.write(data);
    req.end();
  });
}
function cfNormalizeHostname(input, domain) {
  let h = String(input || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '');
  if (!h) throw new Error('Subdomain wajib diisi untuk mode Domain Otomatis (mis. app2, atau app2.' + domain + ')');
  if (!h.includes('.')) h = h + '.' + domain;
  return h;
}
function cfValidateHostname(h, domain) {
  if (h === domain) throw new Error('Domain utama (' + domain + ') tidak boleh dipakai mode Domain Otomatis — pakai subdomain (mis. app2.' + domain + ')');
  if (!h.endsWith('.' + domain)) throw new Error('Hostname ' + h + ' bukan subdomain dari ' + domain);
  if (h.length > 253) throw new Error('Hostname terlalu panjang');
  for (const label of h.split('.')) {
    if (!label || label.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) throw new Error('Hostname tidak valid: ' + h);
  }
}
async function cfEnsureTunnel() {
  if (!cfCfg.apiToken || !cfCfg.accountId) throw new Error('Konfigurasi Cloudflare belum lengkap — isi API token + Account ID di Settings dulu');
  if (cfCfg.tunnelId) {
    try { await cfApi('GET', '/accounts/' + cfCfg.accountId + '/cfd_tunnel/' + cfCfg.tunnelId); }
    catch (e) {
      if (!/\(HTTP 404\)/.test(e.message)) throw e;
      cfCfg.tunnelId = ''; cfCfg.tunnelToken = ''; saveCfCfg();
    }
  }
  if (!cfCfg.tunnelId) {
    const created = await cfApi('POST', '/accounts/' + cfCfg.accountId + '/cfd_tunnel',
      { name: cfCfg.tunnelName || 'terwo', config_src: 'cloudflare' });
    if (!created || !created.id) throw new Error('Cloudflare tidak mengembalikan tunnel ID saat membuat tunnel');
    cfCfg.tunnelId = created.id; saveCfCfg();
  }
  if (!cfCfg.tunnelToken) {
    const tok = await cfApi('GET', '/accounts/' + cfCfg.accountId + '/cfd_tunnel/' + cfCfg.tunnelId + '/token');
    if (!tok || typeof tok !== 'string') throw new Error('Cloudflare tidak mengembalikan token tunnel');
    cfCfg.tunnelToken = tok; saveCfCfg();
  }
  return cfCfg;
}
async function cfGetIngress() {
  try {
    const r = await cfApi('GET', '/accounts/' + cfCfg.accountId + '/cfd_tunnel/' + cfCfg.tunnelId + '/configurations');
    const cfg = (r && r.config) ? r.config : (r || {});
    return { config: cfg, ingress: Array.isArray(cfg.ingress) ? cfg.ingress.slice() : [] };
  } catch (e) {
    if (/\(HTTP 404\)/.test(e.message)) return { config: {}, ingress: [] };
    throw e;
  }
}
async function cfPutIngress(ingress, baseConfig) {
  await cfApi('PUT', '/accounts/' + cfCfg.accountId + '/cfd_tunnel/' + cfCfg.tunnelId + '/configurations',
    { config: Object.assign({}, baseConfig || {}, { ingress }) });
}
async function cfUpsertDns(hostname) {
  const target = cfCfg.tunnelId + '.cfargotunnel.com';
  const list = await cfApi('GET', '/zones/' + cfCfg.zoneId + '/dns_records?type=CNAME&name=' + encodeURIComponent(hostname));
  const arr = Array.isArray(list) ? list : [];
  if (arr.length) {
    const rec = arr[0];
    if (rec.content === target && rec.proxied) return;
    await cfApi('PUT', '/zones/' + cfCfg.zoneId + '/dns_records/' + rec.id,
      { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 });
  } else {
    await cfApi('POST', '/zones/' + cfCfg.zoneId + '/dns_records',
      { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 });
  }
}
// Tulis satu rule ingress + DNS CNAME untuk hostname (dipakai site auto dan
// domain panel). Gagal DNS me-rollback ingress; gagal tulis konfigurasi
// karena tunnel hilang ditangani pemanggil (cfPublishRouteResilient).
async function cfPublishRoute(hostname, service) {
  await cfEnsureTunnel();
  const { config, ingress } = await cfGetIngress();
  const orig = ingress.slice();
  const catchAll = ingress.find((r) => !r.hostname) || { service: 'http_status:404' };
  const rules = ingress.filter((r) => r.hostname && r.hostname !== hostname);
  rules.push({ hostname, service });
  rules.push(catchAll);
  await cfPutIngress(rules, config);
  try { await cfUpsertDns(hostname); }
  catch (e) {
    try { await cfPutIngress(orig.length ? orig : [{ service: 'http_status:404' }], config); } catch {}
    throw new Error('DNS Cloudflare gagal (' + e.message + ') — route dibatalkan');
  }
  return hostname;
}
function cfIsTunnelNotFound(e) {
  const m = e && e.message ? e.message : '';
  return /Tunnel not found/.test(m) || (/\(HTTP 404\)/.test(m) && /code 1002/.test(m));
}
// Perbaikan v1.20.5 (celah v1.20.4): tunnel tersimpan bisa hilang di tengah
// jalan (mis. dihapus di dashboard) — panggilan CEK tunnel yang 404 memang
// dibuat ulang oleh cfEnsureTunnel, tapi panggilan TULIS konfigurasi yang
// 404 dulu lolos mentah ke user. Di sini: bila tulis gagal karena tunnel
// tidak ditemukan, buang ID tunnel tersimpan, buat tunnel baru, coba sekali
// lagi. Gagal kedua (atau gagal bukan karena tunnel hilang) diteruskan apa adanya.
async function cfPublishRouteResilient(hostname, service) {
  try { return await cfPublishRoute(hostname, service); }
  catch (e) {
    if (!cfIsTunnelNotFound(e)) throw e;
    cfCfg.tunnelId = ''; cfCfg.tunnelToken = ''; saveCfCfg();
    return await cfPublishRoute(hostname, service);
  }
}
async function cfPublishSiteDomain(site, hostnameInput) {
  if (!cfCfg.apiToken || !cfCfg.accountId || !cfCfg.zoneId || !cfCfg.domain) {
    throw new Error('Konfigurasi Cloudflare belum lengkap — isi API token, Account ID, Zone ID, dan domain di Settings dulu');
  }
  const hostname = cfNormalizeHostname(hostnameInput, cfCfg.domain);
  cfValidateHostname(hostname, cfCfg.domain);
  const clash = sites.find((s) => s.id !== site.id && s.tunnel && s.tunnel.hostname === hostname);
  if (clash) throw new Error('Hostname ' + hostname + ' sudah dipakai site lain (' + clash.name + ')');
  return cfPublishRouteResilient(hostname, 'http://127.0.0.1:' + site.port);
}
async function cfUnpublishSiteDomain(site) {
  const hostname = site.tunnel && site.tunnel.hostname;
  if (!hostname || !cfCfg.tunnelId || !cfCfg.apiToken || !cfCfg.accountId || !cfCfg.zoneId) return;
  try {
    const { config, ingress } = await cfGetIngress();
    const kept = ingress.filter((r) => r.hostname !== hostname);
    if (!kept.some((r) => !r.hostname)) kept.push({ service: 'http_status:404' });
    await cfPutIngress(kept, config);
  } catch (e) { console.log('CF unpublish route failed (' + site.name + '): ' + e.message); }
  try {
    const list = await cfApi('GET', '/zones/' + cfCfg.zoneId + '/dns_records?type=CNAME&name=' + encodeURIComponent(hostname));
    for (const rec of (Array.isArray(list) ? list : [])) {
      try { await cfApi('DELETE', '/zones/' + cfCfg.zoneId + '/dns_records/' + rec.id); } catch {}
    }
  } catch (e) { console.log('CF unpublish DNS failed (' + site.name + '): ' + e.message); }
}
function apiCfGet(res) { sendJson(res, 200, Object.assign({ ok: true }, cfPublic())); }
async function apiCfConfig(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const apiToken = (b.apiToken || '').trim() || cfCfg.apiToken;
  const accountId = (b.accountId || '').trim() || cfCfg.accountId;
  const zoneId = (b.zoneId || '').trim() || cfCfg.zoneId;
  let domain = String(b.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/\.$/, '') || cfCfg.domain;
  const tunnelName = (b.tunnelName || '').trim() || cfCfg.tunnelName || 'terwo';
  if (apiToken && !/^[A-Za-z0-9._-]+$/.test(apiToken)) throw new Error('API token Cloudflare tidak valid');
  if (accountId && !/^[0-9a-f]{32}$/i.test(accountId)) throw new Error('Account ID harus 32 karakter hex (lihat dashboard Cloudflare, kolom Account ID)');
  if (zoneId && !/^[0-9a-f]{32}$/i.test(zoneId)) throw new Error('Zone ID harus 32 karakter hex (dashboard domain → Overview, kanan bawah)');
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error('Domain tidak valid (mis. flaznexa.cloud)');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(tunnelName)) throw new Error('Nama tunnel tidak valid');
  // Tunnel milik akun lama tidak berlaku bila akun diganti.
  if (accountId !== cfCfg.accountId) { cfCfg.tunnelId = ''; cfCfg.tunnelToken = ''; }
  cfCfg.apiToken = apiToken; cfCfg.accountId = accountId; cfCfg.zoneId = zoneId;
  cfCfg.domain = domain; cfCfg.tunnelName = tunnelName;
  saveCfCfg();
  sendJson(res, 200, Object.assign({ ok: true }, cfPublic()));
}
// Setup & Uji jalan 3 langkah berurutan; tiap langkah dibungkus dengan labelnya
// sendiri, karena pesan mentah Cloudflare ("Authentication error", HTTP 403)
// tidak memberi tahu langkah mana yang gagal — persis keluhan "error tanpa
// log yang jelas". Hint hanya ditambahkan untuk 403, bukan untuk error lain.
function cfStepErr(step, hint403, e) {
  const m = e && e.message ? e.message : String(e);
  return new Error(step + ' gagal: ' + m + (/\(HTTP 403\)/.test(m) ? ' — ' + hint403 : ''));
}
async function apiCfSetup(req, res) {
  if (!cfCfg.apiToken || !cfCfg.accountId || !cfCfg.zoneId || !cfCfg.domain) {
    throw new Error('Lengkapi dulu API token, Account ID, Zone ID, dan domain di Settings, lalu Simpan');
  }
  let v;
  try { v = await cfApi('GET', '/user/tokens/verify'); }
  catch (e) { throw cfStepErr('Langkah 1/3 (verifikasi token)', 'Cloudflare menolak token ini: token tidak valid, kedaluwarsa, atau sudah dicabut. Buat token baru lalu tempel + Simpan lagi', e); }
  if (v && v.status && v.status !== 'active') throw new Error('API token Cloudflare tidak aktif (status: ' + v.status + ')');
  let z;
  try { z = await cfApi('GET', '/zones/' + cfCfg.zoneId); }
  catch (e) { throw cfStepErr('Langkah 2/3 (cek zone)', 'token tidak punya akses ke Zone ID ini (scope zone token beda dengan zone yang diisi) atau Zone ID salah', e); }
  if (z && z.name && z.name.toLowerCase() !== cfCfg.domain) {
    throw new Error('Zone ID ini milik domain ' + z.name + ', bukan ' + cfCfg.domain + ' — periksa Zone ID/domain');
  }
  try { await cfEnsureTunnel(); }
  catch (e) { throw cfStepErr('Langkah 3/3 (buat/cek tunnel)', 'token butuh permission Account → Cloudflare Tunnel → Edit dan Account ID harus sesuai scope token', e); }
  sendJson(res, 200, Object.assign({ ok: true, verified: true, zoneName: z && z.name ? z.name : cfCfg.domain }, cfPublic()));
}
async function apiCfRemoveDomain(req, res, id) {
  const site = siteById(id);
  if (!site) throw new Error('Website not found');
  if (site.tunnel && site.tunnel.mode === 'auto' && site.tunnel.hostname) {
    await cfUnpublishSiteDomain(site);
  }
  stopSiteTunnel(id, true);
  site.tunnel = { enabled: false, mode: 'auto', hostname: '', token: '' };
  saveSites();
  sendJson(res, 200, { ok: true, tunnel: siteTunnelPublic(site) });
}

// ================= Domain Panel Otomatis (v1.20.4) =================
// Panel Terwo sendiri bisa punya domain (mis. panel.flaznexa.cloud) TANPA
// buka dashboard Cloudflare: memakai konfigurasi Domain Otomatis yang sama
// (token + akun + zone + domain di Settings) dan tunnel bersama yang sama.
// Bedanya dengan tunnel panel Named: routing di sini diatur Terwo lewat API
// (ingress + DNS CNAME), bukan manual di dashboard Zero Trust. Runner-nya
// proses cloudflared sendiri untuk tunnel bersama — boleh jalan berdampingan
// dengan runner site auto (satu tunnel boleh punya beberapa connector).
// Nonaktifkan sengaja MENGHAPUS route + DNS (beda dengan site: Stop site
// mempertahankan route) supaya halaman login panel tidak menggantung publik.
let panelDomainProc = null, panelDomainStopping = false, panelDomainRestartTimer = null;
function panelDomainCfg() {
  const c = cfCfg.panelDomain;
  return (c && typeof c === 'object') ? c : { enabled: false, hostname: '' };
}
function panelDomainPublic() {
  const c = panelDomainCfg();
  return { enabled: !!c.enabled, hostname: c.hostname || '',
    running: !!panelDomainProc, url: (c.enabled && c.hostname) ? 'https://' + c.hostname : '' };
}
async function startPanelDomainRunner() {
  if (panelDomainProc) return;
  await mustBin('cloudflared', 'cloudflared is not installed. Install it first via the Store menu.');
  const token = String(cfCfg.tunnelToken || '').trim();
  if (!token) throw new Error('Tunnel otomatis belum siap — isi konfigurasi Cloudflare di Settings, lalu Setup & Uji, kemudian aktifkan lagi domain panel ini');
  panelDomainStopping = false;
  if (panelDomainRestartTimer) { clearTimeout(panelDomainRestartTimer); panelDomainRestartTimer = null; }
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run', '--token', token],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  panelDomainProc = child;
  child.on('error', (e) => {
    console.log('Panel domain runner failed:', e.message);
    panelDomainProc = null;
  });
  child.on('exit', () => {
    panelDomainProc = null;
    // Auto-reconnect selama domain panel masih aktif (bukan stop manual).
    if (!panelDomainStopping && panelDomainCfg().enabled && !panelDomainRestartTimer) {
      panelDomainRestartTimer = setTimeout(() => {
        panelDomainRestartTimer = null;
        if (panelDomainCfg().enabled && !panelDomainProc) {
          startPanelDomainRunner().catch((e) => console.log('Panel domain auto-restart failed:', e.message));
        }
      }, 5000);
    }
  });
}
function stopPanelDomainRunner() {
  panelDomainStopping = true;
  if (panelDomainRestartTimer) { clearTimeout(panelDomainRestartTimer); panelDomainRestartTimer = null; }
  if (panelDomainProc) { try { panelDomainProc.kill(); } catch {} panelDomainProc = null; }
}
async function cfPublishPanelDomain(hostnameInput) {
  if (!cfCfg.apiToken || !cfCfg.accountId || !cfCfg.zoneId || !cfCfg.domain) {
    throw new Error('Konfigurasi Cloudflare belum lengkap — isi API token, Account ID, Zone ID, dan domain di Settings dulu, lalu Setup & Uji');
  }
  const hostname = cfNormalizeHostname(hostnameInput, cfCfg.domain);
  cfValidateHostname(hostname, cfCfg.domain);
  const clash = sites.find((s) => s.tunnel && s.tunnel.hostname === hostname);
  if (clash) throw new Error('Hostname ' + hostname + ' sudah dipakai website ' + clash.name + ' — pakai subdomain lain untuk panel');
  return cfPublishRouteResilient(hostname, 'http://127.0.0.1:' + PORT);
}
async function cfUnpublishPanelDomain(hostname) {
  if (!hostname || !cfCfg.tunnelId || !cfCfg.apiToken || !cfCfg.accountId || !cfCfg.zoneId) return;
  try {
    const { config, ingress } = await cfGetIngress();
    const kept = ingress.filter((r) => r.hostname !== hostname);
    if (!kept.some((r) => !r.hostname)) kept.push({ service: 'http_status:404' });
    await cfPutIngress(kept, config);
  } catch (e) { console.log('CF unpublish panel route failed:', e.message); }
  try {
    const list = await cfApi('GET', '/zones/' + cfCfg.zoneId + '/dns_records?type=CNAME&name=' + encodeURIComponent(hostname));
    for (const rec of (Array.isArray(list) ? list : [])) {
      try { await cfApi('DELETE', '/zones/' + cfCfg.zoneId + '/dns_records/' + rec.id); } catch {}
    }
  } catch (e) { console.log('CF unpublish panel DNS failed:', e.message); }
}
function apiPanelDomainGet(res) { sendJson(res, 200, Object.assign({ ok: true }, panelDomainPublic())); }
async function apiPanelDomainSet(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  if (b.enabled) {
    // Publikasikan dulu SEBELUM enabled disimpan, supaya gagal API tidak
    // meninggalkan domain panel dalam keadaan "aktif" palsu. Error dilabeli
    // fasenya (publish vs connector) supaya tidak mentah seperti v1.20.4.
    let hostname;
    try { hostname = await cfPublishPanelDomain(b.subdomain || b.hostname || 'panel'); }
    catch (e) { throw new Error('Aktifkan domain panel gagal (publish route/DNS): ' + e.message); }
    cfCfg.panelDomain = { enabled: true, hostname }; saveCfCfg();
    try { await startPanelDomainRunner(); }
    catch (e) {
      // Runner gagal nyala (mis. cloudflared belum terinstal): batalkan
      // total supaya tidak ada route publik tanpa connector.
      await cfUnpublishPanelDomain(hostname);
      cfCfg.panelDomain = { enabled: false, hostname: '' }; saveCfCfg();
      throw new Error('Aktifkan domain panel gagal (menjalankan connector): ' + e.message);
    }
    sendJson(res, 200, Object.assign({ ok: true }, panelDomainPublic()));
  } else {
    const c = panelDomainCfg();
    stopPanelDomainRunner();
    if (c.hostname) await cfUnpublishPanelDomain(c.hostname);
    cfCfg.panelDomain = { enabled: false, hostname: '' }; saveCfCfg();
    sendJson(res, 200, Object.assign({ ok: true }, panelDomainPublic()));
  }
}

// ================= Domain phpMyAdmin via tunnel (Cloudflare API) =========
// Pola yang sama persis dengan domain panel (v1.20.4), tapi service-nya
// port phpMyAdmin, bukan port panel — supaya phpMyAdmin bisa dibuka dari
// perangkat lain lewat subdomain (mis. pma.flaznexa.cloud), bukan hanya
// dari HP yang sama. Dua perbedaan penting dari domain panel:
// 1) Keamanan: selama domain aktif, pmaWriteConfig() menulis auth cookie
//    (form login) menggantikan auto-login — URL publik + auto-login root
//    tidak boleh terjadi. Nonaktifkan = kembali ke auto-login lokal.
// 2) phpMyAdmin dinyalakan dulu bila berhenti, supaya tunnel tidak mengarah
//    ke service mati (502). Gagal nyala = rollback total seperti runner.
let pmaDomainProc = null, pmaDomainStopping = false, pmaDomainRestartTimer = null;
function pmaDomainCfg() {
  const c = cfCfg.pmaDomain;
  return (c && typeof c === 'object') ? c : { enabled: false, hostname: '' };
}
function pmaDomainPublic() {
  const c = pmaDomainCfg();
  return { enabled: !!c.enabled, hostname: c.hostname || '',
    running: !!pmaDomainProc, url: (c.enabled && c.hostname) ? 'https://' + c.hostname : '' };
}
async function startPmaDomainRunner() {
  if (pmaDomainProc) return;
  await mustBin('cloudflared', 'cloudflared is not installed. Install it first via the Store menu.');
  const token = String(cfCfg.tunnelToken || '').trim();
  if (!token) throw new Error('Tunnel otomatis belum siap — isi konfigurasi Cloudflare di Settings, lalu Setup & Uji, kemudian aktifkan lagi domain ini');
  pmaDomainStopping = false;
  if (pmaDomainRestartTimer) { clearTimeout(pmaDomainRestartTimer); pmaDomainRestartTimer = null; }
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run', '--token', token],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  pmaDomainProc = child;
  child.on('error', (e) => {
    console.log('PMA domain runner failed:', e.message);
    pmaDomainProc = null;
  });
  child.on('exit', () => {
    pmaDomainProc = null;
    // Auto-reconnect selama domain phpMyAdmin masih aktif (bukan stop manual).
    if (!pmaDomainStopping && pmaDomainCfg().enabled && !pmaDomainRestartTimer) {
      pmaDomainRestartTimer = setTimeout(() => {
        pmaDomainRestartTimer = null;
        if (pmaDomainCfg().enabled && !pmaDomainProc) {
          startPmaDomainRunner().catch((e) => console.log('PMA domain auto-restart failed:', e.message));
        }
      }, 5000);
    }
  });
}
function stopPmaDomainRunner() {
  pmaDomainStopping = true;
  if (pmaDomainRestartTimer) { clearTimeout(pmaDomainRestartTimer); pmaDomainRestartTimer = null; }
  if (pmaDomainProc) { try { pmaDomainProc.kill(); } catch {} pmaDomainProc = null; }
}
async function cfPublishPmaDomain(hostnameInput) {
  if (!cfCfg.apiToken || !cfCfg.accountId || !cfCfg.zoneId || !cfCfg.domain) {
    throw new Error('Konfigurasi Cloudflare belum lengkap — isi API token, Account ID, Zone ID, dan domain di Settings dulu, lalu Setup & Uji');
  }
  if (!pmaInstalled()) throw new Error('phpMyAdmin belum terpasang — klik Pasang dulu di kartu phpMyAdmin');
  const hostname = cfNormalizeHostname(hostnameInput, cfCfg.domain);
  cfValidateHostname(hostname, cfCfg.domain);
  const clash = sites.find((s) => s.tunnel && s.tunnel.hostname === hostname);
  if (clash) throw new Error('Hostname ' + hostname + ' sudah dipakai website ' + clash.name + ' — pakai subdomain lain untuk phpMyAdmin');
  if (panelDomainCfg().enabled && panelDomainCfg().hostname === hostname) {
    throw new Error('Hostname ' + hostname + ' sudah dipakai domain panel — pakai subdomain lain untuk phpMyAdmin');
  }
  return cfPublishRouteResilient(hostname, 'http://127.0.0.1:' + pmaCfg.port);
}
async function cfUnpublishPmaDomain(hostname) {
  if (!hostname || !cfCfg.tunnelId || !cfCfg.apiToken || !cfCfg.accountId || !cfCfg.zoneId) return;
  try {
    const { config, ingress } = await cfGetIngress();
    const kept = ingress.filter((r) => r.hostname !== hostname);
    if (!kept.some((r) => !r.hostname)) kept.push({ service: 'http_status:404' });
    await cfPutIngress(kept, config);
  } catch (e) { console.log('CF unpublish pma route failed:', e.message); }
  try {
    const list = await cfApi('GET', '/zones/' + cfCfg.zoneId + '/dns_records?type=CNAME&name=' + encodeURIComponent(hostname));
    for (const rec of (Array.isArray(list) ? list : [])) {
      try { await cfApi('DELETE', '/zones/' + cfCfg.zoneId + '/dns_records/' + rec.id); } catch {}
    }
  } catch (e) { console.log('CF unpublish pma DNS failed:', e.message); }
}
function apiPmaDomainGet(res) { sendJson(res, 200, Object.assign({ ok: true }, pmaDomainPublic())); }
async function apiPmaDomainSet(req, res) {
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  if (b.enabled) {
    // Publikasikan dulu SEBELUM enabled disimpan (sama seperti domain panel).
    let hostname;
    try { hostname = await cfPublishPmaDomain(b.subdomain || b.hostname || 'pma'); }
    catch (e) { throw new Error('Aktifkan domain phpMyAdmin gagal (publish route/DNS): ' + e.message); }
    cfCfg.pmaDomain = { enabled: true, hostname }; saveCfCfg();
    // Mode auth ikut berubah (cookie) begitu enabled tersimpan — dan
    // phpMyAdmin dinyalakan bila berhenti, supaya tunnel tidak 502.
    try {
      if (pmaInstalled()) pmaWriteConfig();
      if (pmaInstalled() && !pmaProc) await pmaStart();
    } catch (e) {
      await cfUnpublishPmaDomain(hostname);
      cfCfg.pmaDomain = { enabled: false, hostname: '' }; saveCfCfg();
      if (pmaInstalled()) pmaWriteConfig();
      throw new Error('Aktifkan domain phpMyAdmin gagal (menyalakan phpMyAdmin): ' + e.message);
    }
    try { await startPmaDomainRunner(); }
    catch (e) {
      await cfUnpublishPmaDomain(hostname);
      cfCfg.pmaDomain = { enabled: false, hostname: '' }; saveCfCfg();
      if (pmaInstalled()) pmaWriteConfig();
      throw new Error('Aktifkan domain phpMyAdmin gagal (menjalankan connector): ' + e.message);
    }
    sendJson(res, 200, Object.assign({ ok: true }, pmaDomainPublic()));
  } else {
    const c = pmaDomainCfg();
    stopPmaDomainRunner();
    if (c.hostname) await cfUnpublishPmaDomain(c.hostname);
    cfCfg.pmaDomain = { enabled: false, hostname: '' }; saveCfCfg();
    // Kembali ke auto-login lokal (config) begitu domain dimatikan.
    if (pmaInstalled()) pmaWriteConfig();
    sendJson(res, 200, Object.assign({ ok: true }, pmaDomainPublic()));
  }
}

// ================= Cloudflare Tunnel per website =================
// Satu site = satu proses cloudflared sendiri, jadi tiap website punya URL
// publiknya masing-masing (Quick: *.trycloudflare.com acak; Named: token CF).
// Config tunnel per site disimpan di sites.json (mode 0600, sama seperti
// file data panel lain) dan TIDAK PERNAH dikembalikan lewat API (token
// diganti flag hasToken di apiSitesList). Semantik saklar sama seperti
// tunnel panel: enabled=true dipertahankan saat site Stop/Restart, dan
// tunnel ikut nyala lagi saat site di-Start — termasuk saat panel restart
// dan site auto-start. Stop tunnel lewat API (persist=true) yang mematikan
// flag enabled-nya.
const siteTunnels = new Map(); // siteId -> { proc, url, logs[], startedAt, stopping, restartTimer }
// Log terakhir tunnel yang sudah mati (gagal start / berhenti) — dipertahankan
// supaya penyebabnya tetap bisa dibaca, tidak ikut musnah bersama record-nya.
// Dihapus saat tunnel situs itu di-start ulang (log baru menggantikan).
const siteTunnelDeadLogs = new Map(); // siteId -> logs string
function siteTunnelSaveDead(id) {
  const r = siteTunnels.get(id);
  if (r) siteTunnelDeadLogs.set(id, r.logs.join(''));
}
function siteTunnelRunning(id) { return siteTunnels.has(id); }
function siteTunnelUrl(id) { const r = siteTunnels.get(id); return r ? r.url : ''; }
function siteTunnelPublic(site) {
  const r = siteTunnels.get(site.id);
  const t = site.tunnel || {};
  return { enabled: !!t.enabled, mode: t.mode || 'quick', hostname: t.hostname || '',
    hasToken: t.mode === 'auto' ? !!cfCfg.tunnelToken : !!t.token, running: !!r, url: r ? r.url : '', startedAt: r ? r.startedAt : 0 };
}
function siteTunnelPushLog(id, line) {
  const r = siteTunnels.get(id);
  if (!r) return;
  r.logs.push(line);
  if (r.logs.length > 200) r.logs.splice(0, r.logs.length - 200);
}
async function startSiteTunnel(site) {
  const cfg = site.tunnel;
  if (!cfg || !cfg.enabled) return null;
  if (siteTunnels.has(site.id)) return siteTunnelPublic(site);
  await mustBin('cloudflared', 'cloudflared is not installed. Install it first via the Store menu.');
  let args;
  if (cfg.mode === 'auto') {
    const token = String(cfCfg.tunnelToken || '').trim();
    if (!cfg.hostname) throw new Error('Hostname Domain Otomatis belum diisi');
    if (!token) throw new Error('Tunnel otomatis belum siap — simpan konfigurasi Cloudflare di Settings, lalu Setup & Uji, kemudian aktifkan lagi tunnel site ini');
    args = ['tunnel', '--no-autoupdate', 'run', '--token', token];
  } else if (cfg.mode === 'token') {
    const token = String(cfg.token || '').trim();
    if (!token || !/^[A-Za-z0-9._-]+$/.test(token)) {
      throw new Error('Token Cloudflare wajib diisi (tempel token tunnel dari dashboard Cloudflare Zero Trust)');
    }
    args = ['tunnel', '--no-autoupdate', 'run', '--token', token];
  } else {
    args = ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + site.port];
  }
  const child = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { proc: child, url: '', logs: [], startedAt: Date.now(), stopping: false, restartTimer: null };
  siteTunnels.set(site.id, rec);
  siteTunnelDeadLogs.delete(site.id);
  let buf = '';
  const onData = (d) => {
    buf += d.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      siteTunnelPushLog(site.id, line + '\n');
      if (!rec.url) {
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) rec.url = m[0];
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => {
    siteTunnelPushLog(site.id, '--- site tunnel failed to start: ' + e.message + ' ---\n');
    siteTunnelSaveDead(site.id);
    siteTunnels.delete(site.id);
  });
  child.on('exit', (code) => {
    siteTunnelPushLog(site.id, '--- site tunnel stopped (exit ' + code + ') ---\n');
    const wasStopping = rec.stopping;
    siteTunnelSaveDead(site.id);
    siteTunnels.delete(site.id);
    // Auto-reconnect: hanya bila tunnel masih enabled DAN sitenya masih jalan.
    const cur = siteById(site.id);
    if (!wasStopping && cur && cur.tunnel && cur.tunnel.enabled && running.has(site.id)) {
      setTimeout(() => {
        const c2 = siteById(site.id);
        if (c2 && c2.tunnel && c2.tunnel.enabled && running.has(site.id) && !siteTunnels.has(site.id)) {
          startSiteTunnel(c2).catch((e) => console.log('Site tunnel auto-restart failed (' + c2.name + '): ' + e.message));
        }
      }, 5000);
    }
  });
  return siteTunnelPublic(site);
}
function stopSiteTunnel(id, persist) {
  const r = siteTunnels.get(id);
  if (r) {
    r.stopping = true;
    if (r.restartTimer) clearTimeout(r.restartTimer);
    try { r.proc.kill(); } catch {}
    siteTunnelSaveDead(id);
    siteTunnels.delete(id);
  }
  if (persist) {
    const site = siteById(id);
    if (site && site.tunnel) { site.tunnel.enabled = false; saveSites(); }
  }
}
async function apiSiteTunnelStart(req, res, id) {
  const site = siteById(id);
  if (!site) throw new Error('Website not found');
  const b = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
  const mode = b.mode === 'token' ? 'token' : (b.mode === 'auto' ? 'auto' : 'quick');
  const token = (b.token || '').trim() || (site.tunnel ? site.tunnel.token : '');
  // Validasi di sini juga (bukan hanya saat proses tunnel nyala), supaya
  // mode token tanpa token ditolak langsung saat diaktifkan — termasuk
  // saat sitenya belum jalan dan tunnel baru dicatat enabled.
  if (mode === 'token' && (!token || !/^[A-Za-z0-9._-]+$/.test(token))) {
    throw new Error('Token Cloudflare wajib diisi (tempel token tunnel dari dashboard Cloudflare Zero Trust)');
  }
  // Mode auto: publikasikan dulu ke Cloudflare SEBELUM enabled disimpan,
  // supaya gagal API tidak meninggalkan site dalam keadaan "armed" palsu.
  // Route + DNS sengaja TIDAK dihapus saat Stay Local/stop — pencabutan
  // eksplisit lewat tombol Hapus Domain / hapus site (lihat apiCfRemoveDomain).
  let hostname = (b.hostname || '').trim() || (site.tunnel ? site.tunnel.hostname : '');
  if (mode === 'auto') hostname = await cfPublishSiteDomain(site, hostname);
  site.tunnel = { enabled: true, mode, token: mode === 'auto' ? '' : (token || ''), hostname };
  saveSites();
  // Site belum jalan: tunnel dicatat enabled, tapi prosesnya baru nyala
  // saat site di-Start (tunnel ke upstream yang mati hanya akan 502).
  if (running.has(id)) await startSiteTunnel(site);
  sendJson(res, 200, { ok: true, siteRunning: running.has(id), tunnel: siteTunnelPublic(site) });
}
function apiSiteTunnelStop(res, id) {
  const site = siteById(id);
  if (!site) throw new Error('Website not found');
  stopSiteTunnel(id, true);
  sendJson(res, 200, { ok: true, tunnel: siteTunnelPublic(site) });
}
async function apiSiteTunnelLogs(res, id) {
  const site = siteById(id);
  if (!site) throw new Error('Website not found');
  const r = siteTunnels.get(id);
  // Live bila proses jalan; bila tidak, tampilkan log terakhir yang tersimpan
  // (tunnel gagal start / sudah berhenti tetap bisa didiagnosis).
  const logs = r ? r.logs.join('').slice(-4000) : (siteTunnelDeadLogs.get(id) || '').slice(-4000);
  sendJson(res, 200, { ok: true, running: !!r, enabled: !!(site.tunnel && site.tunnel.enabled), logs });
}
function apiTunnelsList(res) {
  sendJson(res, 200, { panel: tunnelPublic(),
    sites: sites.map((s) => ({ id: s.id, name: s.name, port: s.port,
      running: running.has(s.id), tunnel: siteTunnelPublic(s) })) });
}

// ================= HTTP server =================
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    if (!res.headersSent) sendJson(res, 400, { error: (e && e.message) || 'Failed' });
    else { try { res.end(); } catch { /* ignore */ } }
  });
});

// App pages served by clean slugs (no .html). Each slug renders the same
// shell; the client activates the matching tab from the URL path.
const APP_PAGES = new Set(['dashboard', 'website', 'database', 'files', 'cron', 'backup', 'tunnel', 'settings', 'terminal', 'store', 'ai']);

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/') {
      res.writeHead(302, { Location: isAuthed(req) ? '/dashboard' : '/login' });
      return res.end();
    }
    if (p === '/login') return servePublic(res, 'login.html');
    if (p === '/login.html') { res.writeHead(302, { Location: '/login' }); return res.end(); }
    // aset publik untuk halaman login (tanpa auth)
    if (p === '/tailwind.css') return servePublic(res, 'tailwind.css');
    if (p === '/favicon.svg') return servePublic(res, 'favicon.svg');
    if (p === '/vendor/lucide.min.js') return servePublic(res, 'vendor/lucide.min.js');

        if (p === '/api/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 1e6)).toString('utf8'));
      const userOk = timingSafeEq(body.username || '', config.username || '');
      const passOk = body.password && hashPassword(body.password, config.salt) === config.hash;
      if (userOk && passOk) {
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { created: Date.now() });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'tpsid=' + token + '; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400',
        });
        return res.end(JSON.stringify({ ok: true }));
      }
      return sendJson(res, 401, { error: 'Username atau password salah' });
    }

    // ---- semua di bawah ini wajib login ----
    if (!isAuthed(req)) {
      if (p.startsWith('/api/') || p === '/term') return sendJson(res, 401, { error: 'Not logged in' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    if (p === '/app.html') { res.writeHead(302, { Location: '/dashboard' }); return res.end(); }
    if (APP_PAGES.has(p.slice(1))) return servePublic(res, 'app.html');
    if (p === '/app.js') return servePublic(res, 'app.js');
    if (p === '/style.css') return servePublic(res, 'style.css');
    if (p === '/vendor/xterm.js') return servePublic(res, 'vendor/xterm.js');
    if (p === '/vendor/xterm.css') return servePublic(res, 'vendor/xterm.css');
    if (p === '/vendor/xterm-addon-fit.js') return servePublic(res, 'vendor/xterm-addon-fit.js');

    if (p === '/api/logout' && req.method === 'POST') {
      const c = parseCookies(req);
      if (c.tpsid) sessions.delete(c.tpsid);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'tpsid=; HttpOnly; Path=/; Max-Age=0',
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (p === '/api/files') return apiFiles(url, res);
    if (p === '/api/sysinfo') return apiSysinfo(res);
    if (p === '/api/download') return apiDownload(url, res);
    if (req.method === 'POST' && p === '/api/mkdir') return apiMkdir(req, res);
    if (req.method === 'POST' && p === '/api/touch') return apiTouch(req, res);
    if (req.method === 'POST' && p === '/api/rename') return apiRename(req, res);
    if (req.method === 'POST' && p === '/api/delete') return apiDelete(req, res);
    if (req.method === 'POST' && p === '/api/read') return apiRead(req, res);
    if (req.method === 'POST' && p === '/api/write') return apiWrite(req, res);
    if (req.method === 'POST' && p === '/api/upload') return apiUpload(req, res);
    if (req.method === 'POST' && p === '/api/chpasswd') return apiChpasswd(req, res);

    // website hosting
    if (p === '/api/sites' && req.method === 'GET') return apiSitesList(res);
    if (p === '/api/sites' && req.method === 'POST') return apiSiteCreate(req, res);
    const stm = p.match(/^\/api\/sites\/([0-9a-f]{16})\/tunnel\/(start|stop)$/);
    if (stm) {
      if (stm[2] === 'start' && req.method === 'POST') return apiSiteTunnelStart(req, res, stm[1]);
      if (stm[2] === 'stop' && req.method === 'POST') return apiSiteTunnelStop(res, stm[1]);
    }
    const stl = p.match(/^\/api\/sites\/([0-9a-f]{16})\/tunnel\/logs$/);
    if (stl && req.method === 'GET') return apiSiteTunnelLogs(res, stl[1]);
    const cfd = p.match(/^\/api\/sites\/([0-9a-f]{16})\/tunnel\/remove-domain$/);
    if (cfd && req.method === 'POST') return apiCfRemoveDomain(req, res, cfd[1]);
    if (p === '/api/cloudflare' && req.method === 'GET') return apiCfGet(res);
    if (p === '/api/cloudflare/config' && req.method === 'POST') return apiCfConfig(req, res);
    if (p === '/api/cloudflare/setup' && req.method === 'POST') return apiCfSetup(req, res);
    if (p === '/api/panel-domain' && req.method === 'GET') return apiPanelDomainGet(res);
    if (p === '/api/panel-domain' && req.method === 'POST') return apiPanelDomainSet(req, res);
    if (p === '/api/tunnels' && req.method === 'GET') return apiTunnelsList(res);
    const sm = p.match(/^\/api\/sites\/([0-9a-f]{16})\/(start|stop|restart|delete|logs)$/);
    if (sm) {
      const sid = sm[1], act = sm[2];
      if (act === 'start' && req.method === 'POST') return apiSiteStart(req, res, sid);
      if (act === 'stop' && req.method === 'POST') return apiSiteStop(req, res, sid);
      if (act === 'restart' && req.method === 'POST') return apiSiteRestart(req, res, sid);
      if (act === 'delete' && req.method === 'POST') return apiSiteDelete(req, res, sid);
      if (act === 'logs' && req.method === 'GET') return apiSiteLogs(res, sid);
    }

    // install center
    if (p === '/api/install' && req.method === 'GET') return apiInstallList(res);
    const im = p.match(/^\/api\/install\/([a-z0-9-]+)\/(start|log)$/);
    if (im) {
      if (im[2] === 'start' && req.method === 'POST') return apiInstallStart(req, res, im[1]);
      if (im[2] === 'log' && req.method === 'GET') return apiInstallLog(res, im[1]);
    }

    // database manager
    // AI Chat
    if (p === '/api/ai/config' && req.method === 'GET') return apiAiConfigGet(res);
    if (p === '/api/ai/config' && req.method === 'POST') return apiAiConfigSave(req, res);
    if (p === '/api/ai/models' && req.method === 'POST') return apiAiModels(req, res);
    if (p === '/api/ai/chat' && req.method === 'POST') return apiAiChat(req, res);
    if (p === '/api/ai/agent' && req.method === 'POST') return apiAiAgent(req, res);
    if (p === '/api/ai/agent/approve' && req.method === 'POST') return apiAiAgentApprove(req, res);
    // Manajemen database ala aaPanel (detail, hapus, user, backup/restore)
    if (p === '/api/db/backups' && req.method === 'GET') return apiDbBackups(res);
    const ddet = p.match(/^\/api\/db\/(mysql|postgres)\/databases\/details$/);
    if (ddet && req.method === 'GET') return apiDbDetails(res, ddet[1]);
    const ddel = p.match(/^\/api\/db\/(mysql|postgres)\/databases\/([^/]+)$/);
    if (ddel && req.method === 'DELETE') return apiDbDelete(req, res, ddel[1], ddel[2]);
    const dbk = p.match(/^\/api\/db\/(mysql|postgres)\/databases\/([^/]+)\/(backup|restore)$/);
    if (dbk && req.method === 'POST') {
      if (dbk[3] === 'backup') return apiDbBackup(req, res, dbk[1], dbk[2]);
      return apiDbRestore(req, res, dbk[1], dbk[2]);
    }
    const dbu = p.match(/^\/api\/db\/(mysql|postgres)\/users$/);
    if (dbu) {
      if (req.method === 'GET') return apiDbUsers(res, dbu[1]);
      if (req.method === 'POST') return apiDbUserCreate(req, res, dbu[1]);
    }
    const dbu2 = p.match(/^\/api\/db\/(mysql|postgres)\/users\/(password|grant|delete)$/);
    if (dbu2 && req.method === 'POST') {
      if (dbu2[2] === 'password') return apiDbUserPassword(req, res, dbu2[1]);
      if (dbu2[2] === 'grant') return apiDbUserGrant(req, res, dbu2[1]);
      return apiDbUserDelete(req, res, dbu2[1]);
    }
    const dm = p.match(/^\/api\/db\/(mysql|postgres)\/(config|test|connect|disconnect|databases|tables|rows|query)$/);
    if (dm) {
      const dt = dm[1], da = dm[2];
      if (da === 'config' && req.method === 'GET') return apiDbConfigGet(res, dt);
      if (da === 'config' && req.method === 'POST') return apiDbConfigSave(req, res, dt);
      if (da === 'test' && req.method === 'POST') return apiDbTest(req, res, dt);
      if (da === 'connect' && req.method === 'POST') return apiDbConnect(req, res, dt);
      if (da === 'disconnect' && req.method === 'POST') return apiDbDisconnect(res, dt);
      if (da === 'databases' && req.method === 'GET') return apiDbDatabases(res, dt);
      if (da === 'databases' && req.method === 'POST') return apiDbCreate(req, res, dt);
      if (da === 'tables' && req.method === 'GET') return apiDbTables(url, res, dt);
      if (da === 'rows' && req.method === 'GET') return apiDbRows(url, res, dt);
      if (da === 'query' && req.method === 'POST') return apiDbQuery(req, res, dt);
    }
        // auth & settings
    if (req.method === 'POST' && p === '/api/auth/change-username') return apiChangeUsername(req, res);
    if (req.method === 'POST' && p === '/api/auth/change-password') return apiChangePassword2(req, res);
    if (req.method === 'POST' && p === '/api/auth/logout-all') return apiLogoutAll(res);
    if (req.method === 'GET' && p === '/api/settings') return apiSettingsGet(res);
    if (req.method === 'POST' && p === '/api/settings') return apiSettingsPost(req, res);
    if (req.method === 'POST' && p === '/api/settings/test-telegram') return apiTelegramTest(res);
    // dashboard
    if (req.method === 'GET' && p === '/api/stats') return apiStats(res);
    if (req.method === 'GET' && p === '/api/battery/debug') return apiBatteryDebug(res);
    // nginx reverse proxy
    if (req.method === 'GET' && p === '/api/nginx/status') return apiNginxStatus(res);
    if (req.method === 'POST' && p === '/api/nginx/service') return apiNginxService(req, res);
    if (req.method === 'GET' && p === '/api/nginx/proxies') return apiNginxList(res);
    if (req.method === 'POST' && p === '/api/nginx/proxies') return apiNginxCreate(req, res);
    const nxm = p.match(/^\/api\/nginx\/proxies\/([0-9a-f]+)$/);
    if (nxm && req.method === 'DELETE') return apiNginxDelete(res, nxm[1]);
    // cron
    if (req.method === 'GET' && p === '/api/cron/status') return apiCronStatus(res);
    if (req.method === 'POST' && p === '/api/cron/service') return apiCronService(req, res);
    if (req.method === 'GET' && p === '/api/cron/jobs') return apiCronJobs(res);
    if (req.method === 'POST' && p === '/api/cron/jobs') return apiCronAdd(req, res);
    const crm = p.match(/^\/api\/cron\/jobs\/([0-9a-f]+)(\/toggle)?$/);
    if (crm) {
      if (crm[2] && req.method === 'POST') return apiCronToggle(res, crm[1]);
      if (!crm[2] && req.method === 'DELETE') return apiCronDelete(res, crm[1]);
    }
    // backup
    if (req.method === 'GET' && p === '/api/backups') return apiBackupList(res);
    if (req.method === 'POST' && p === '/api/backups') return apiBackupCreate(req, res);
    const bkm = p.match(/^\/api\/backups\/([A-Za-z0-9._-]+)(\/(download|restore))?$/);
    if (bkm) {
      if (bkm[3] === 'download' && req.method === 'GET') return apiBackupDownload(res, bkm[1]);
      if (bkm[3] === 'restore' && req.method === 'POST') return apiBackupRestore(req, res, bkm[1]);
      if (!bkm[3] && req.method === 'DELETE') return apiBackupDelete(res, bkm[1]);
    }
    // phpMyAdmin
    if (req.method === 'GET' && p === '/api/phpmyadmin') return apiPmaGet(res);
    if (req.method === 'POST' && p === '/api/phpmyadmin/install') return apiPmaInstall(req, res);
    if (req.method === 'POST' && p === '/api/phpmyadmin/start') return apiPmaStart(req, res);
    if (req.method === 'POST' && p === '/api/phpmyadmin/stop') return apiPmaStop(res);
    if (req.method === 'POST' && p === '/api/phpmyadmin/config') return apiPmaConfig(req, res);
    if (req.method === 'GET' && p === '/api/pma-domain') return apiPmaDomainGet(res);
    if (req.method === 'POST' && p === '/api/pma-domain') return apiPmaDomainSet(req, res);
    // cloudflare tunnel (auto tunneling)
    if (req.method === 'GET' && p === '/api/tunnel') return apiTunnelGet(res);
    if (req.method === 'POST' && p === '/api/tunnel/start') return apiTunnelStart(req, res);
    if (req.method === 'POST' && p === '/api/tunnel/stop') return apiTunnelStop(res);
    // file manager tambahan
    if (req.method === 'POST' && p === '/api/files/zip') return apiFileZip(req, res);
    if (req.method === 'POST' && p === '/api/files/unzip') return apiFileUnzip(req, res);
    if (req.method === 'GET' && p === '/api/files/preview') return apiFilePreview(url, res);

    sendJson(res, 404, { error: 'Not found' });
  } catch (e) {
    sendJson(res, 400, { error: e.message || 'Failed' });
  }
}

// ================= Terminal via WebSocket (xterm.js + node-pty opsional) =================
let ptyMod = null;
try { ptyMod = require('node-pty'); } catch { /* opsional, fallback ke pipe */ }
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let ok = false;
  try {
    const url = new URL(req.url, 'http://x');
    ok = url.pathname === '/term' && isAuthed(req);
  } catch { /* ignore */ }
  if (!ok) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const shell = process.env.SHELL || SHELL || 'sh';
    const send = (d) => { if (ws.readyState === 1) ws.send(d.toString('utf8')); };
    let writeFn, resizeFn, killFn;
    if (ptyMod) {
      const p = ptyMod.spawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 24,
        cwd: ROOT, env: Object.assign({}, process.env, { TERM: 'xterm-256color' }) });
      p.onData(send);
      writeFn = (d) => { try { p.write(d); } catch {} };
      resizeFn = (c, r) => { try { p.resize(c, r); } catch {} };
      killFn = () => { try { p.kill(); } catch {} };
      p.on('exit', () => { try { ws.close(); } catch {} });
    } else {
      const child = spawn(shell, [], { cwd: ROOT,
        env: Object.assign({}, process.env, { TERM: 'xterm-256color' }) });
      child.stdout.on('data', send);
      child.stderr.on('data', send);
      writeFn = (d) => { try { child.stdin.write(d); } catch {} };
      resizeFn = () => {};
      killFn = () => { try { child.kill(); } catch {} };
      child.on('exit', () => { try { ws.close(); } catch {} });
    }
    ws.on('message', (m) => {
      const s = m.toString();
      let msg = null;
      try { msg = JSON.parse(s); } catch { /* mentah seperti dulu */ }
      if (msg && typeof msg === 'object' && msg.t === 'in') writeFn(msg.d || '');
      else if (msg && typeof msg === 'object' && msg.t === 'rs') resizeFn(msg.c | 0 || 80, msg.r | 0 || 24);
      else writeFn(s);
    });
    ws.on('close', killFn);
    ws.on('error', killFn);
    ws.send('\r\n=== Terminal siap (' + shell + (ptyMod ? ', pty' : ', pipe') + ') ===\r\n');
  });
});

server.listen(PORT, HOST, () => {
  try { startTelegramPoll(); } catch { /* ignore */ }
  // Auto tunneling: saklar yang masih ON sebelum restart langsung jalan lagi.
  if (tunnelCfg.enabled) {
    startTunnel(tunnelCfg).catch((e) => console.log('Auto tunnel failed:', e.message));
  }
  // Domain panel yang masih aktif sebelum restart ikut nyala lagi.
  if (panelDomainCfg().enabled && panelDomainCfg().hostname) {
    startPanelDomainRunner().catch((e) => console.log('Auto-start panel domain failed:', e.message));
  }
  // Domain phpMyAdmin yang masih aktif sebelum restart ikut nyala lagi,
  // dan phpMyAdmin-nya sendiri dinyalakan dulu supaya tunnel tidak 502.
  if (pmaDomainCfg().enabled && pmaDomainCfg().hostname) {
    (async () => {
      try { if (pmaInstalled() && !pmaProc) await pmaStart(); } catch (e) { console.log('Auto-start phpMyAdmin for domain failed:', e.message); }
      try { await startPmaDomainRunner(); } catch (e) { console.log('Auto-start PMA domain failed:', e.message); }
    })();
  }
  // Auto-start semuanya saat panel dijalankan (pm2 start terwo):
  // 1) database yang config-nya pernah disimpan langsung connect,
  //    lalu dicoba lagi tiap 30 detik sampai server DB-nya hidup;
  // 2) website yang autoStart-nya ON (Start = ON, Stop = OFF; site lama
  //    tanpa flag dianggap ON supaya yang sudah jalan balik lagi) nyala;
  // 3) tunnel per website yang enabled ikut nyala setelah sitenya jalan.
  // 4) phpMyAdmin yang autoStart-nya ON ikut nyala (bind 127.0.0.1 saja).
  // Semua best-effort: satu yang gagal tidak menghentikan panel.
  autoConnectDb().catch((e) => console.log('Auto-connect database failed:', e.message));
  setInterval(() => { autoConnectDb().catch(() => {}); }, 30000);
  (async () => {
    for (const site of sites) {
      if (site.autoStart === false) continue;
      try {
        await doSiteStart(site);
        site.autoStart = true; saveSites();
      } catch (e) { console.log('Auto-start website failed (' + site.name + '): ' + e.message); continue; }
      if (site.tunnel && site.tunnel.enabled) {
        try { await startSiteTunnel(site); }
        catch (e) { console.log('Auto-start site tunnel failed (' + site.name + '): ' + e.message); }
      }
    }
  })().catch((e) => console.log('Auto-start websites failed:', e.message));
  if (pmaCfg.autoStart && pmaInstalled()) {
    pmaStart().catch((e) => console.log('Auto-start phpMyAdmin failed:', e.message));
  }
  console.log('Terwo running at http://' + HOST + ':' + PORT);
  console.log('Working directory: ' + ROOT);
  if (HOST === '0.0.0.0') {
    console.log('WARNING: panel is open on all network interfaces. Make sure it is protected!');
  }
});

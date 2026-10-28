# Terwo v1.20.9
**Ter**mux **W**eb **O**peration

A lightweight web panel to manage Termux from your browser: **file manager**,
**terminal**, and **system info**. Written from scratch, clean code with no
obfuscation. Dependencies: `ws`, `mysql2`, `pg` (the last two only for the
Database menu).

## Screenshots

**Dashboard** — live CPU, RAM, disk, battery and uptime stats, refreshed every 5 seconds.

![Terwo dashboard](docs/screenshots/dashboard.png)

**Website** — host Node.js, PHP, Static or Go sites and manage Nginx reverse proxies.

![Terwo website manager](docs/screenshots/website.png)

**Store** — install packages straight from the panel with live streaming logs.

![Terwo store](docs/screenshots/store.png)

The UI uses **Tailwind CSS v4** (built output, `public/tailwind.css` is included)
and local **Lucide** icons (`public/vendor/lucide.min.js`) — no CDN, fully
offline. Developers who change the look can rebuild the CSS with:

```bash
npm run build:css
```

(requires the dev dependency `@tailwindcss/cli`; end users never need to run it)

## Install on Termux

**One line:**
```bash
curl -sL https://raw.githubusercontent.com/willy911/terwo/main/install.sh | bash
```
The installer automatically: checks Node.js → clones the repo → `npm install` →
installs **PM2** → the panel **starts running in the background right away**
(like aaPanel) → `pm2 save`.
The panel binds to `0.0.0.0` so it is reachable from other PCs/phones on the
same network. No need to keep a terminal open.

**Manual:**
```bash
pkg install nodejs -y
cd terwo
npm install
npm install -g pm2
PANEL_HOST=0.0.0.0 pm2 start panel.js --name terwo
pm2 save
```

Then open in your browser: **http://127.0.0.1:8080** (or the phone's IP from another device)

On first run, the panel generates a random username + password and prints them
to the log (`pm2 logs terwo --nostream | grep -A7 "initial access"`).
Log in with them, then change them immediately via the **Settings** menu.

### Manage the panel (PM2)

```bash
pm2 logs terwo     # view panel logs
pm2 restart terwo  # restart panel
pm2 stop terwo     # stop panel
pm2 list           # check status
```

## Settings (optional, via environment variables)

| Variable     | Default        | Description                                        |
|--------------|----------------|----------------------------------------------------|
| `PANEL_PORT` | `8080`         | Port to use                                        |
| `PANEL_HOST` | `127.0.0.1`    | Bind address (installer overrides to `0.0.0.0`)    |
| `PANEL_ROOT` | `$HOME`        | Top directory the file manager may access          |

Example:

```bash
PANEL_PORT=9000 node panel.js
```

## Features

- **Clean URL slugs** — every page has its own slug: `/login`, `/dashboard`,
  `/website`, `/database`, `/files`, `/cron`, `/backup`, `/tunnel`,
  `/settings`, `/terminal`, `/store`. No `.html` extensions anywhere (old
  `.html` URLs redirect to the new slugs).
- **🌩️ Tunnel (auto tunneling)** — menu Tunnel baru: satu saklar, tunnel
  langsung nyala. Mode **Quick** tanpa akun Cloudflare (URL acak
  `*.trycloudflare.com`, berubah tiap restart tunnel) atau mode **Named**
  dengan token tunnel dari dashboard Cloudflare Zero Trust (hostname tetap).
  Target default = panel ini, bisa diarahkan ke port lain (mis. website yang
  di-host panel). Saklar ON tersimpan di `~/.termux-panel/tunnel.json`
  (mode 0600, token tak pernah dikembalikan API) — panel restart (PM2
  resurrect) otomatis menyalakan lagi tunnelnya, dan tunnel yang putus
  otomatis dicoba nyalakan ulang setelah 5 detik. Butuh `cloudflared`
  (install 1-klik dari Store). Perhatian: tunnel membuka panel ke internet
  publik — pastikan password panel kuat sebelum mengaktifkan.
- **Login** — username + password (PBKDF2 hash), HttpOnly session cookie.
- **Dark/light mode** — dark by default, icon-only sun/moon toggle in the
  sidebar header; choice is stored in the browser (terminal is always dark).
  aaPanel-style look: neutral dark surfaces with a green accent.
- **Dashboard** — CPU, RAM, disk, battery (via Termux:API), uptime, website
  status; auto-refreshes every 5 seconds.
- **Settings** — change username/password, Telegram notifications, log out all sessions.
  All destructive actions (logout, delete file/website/proxy/cron job/backup,
  restore backup) ask for confirmation in a styled modal dialog.
- **File manager** — browse folders, upload, download, create folders/files,
  rename, delete, edit text files right in the browser, zip/unzip, image preview.
- **Terminal** — a real terminal emulator (xterm.js, 100% local, no CDN):
  right-click = paste, ⧉ Paste button (mobile-friendly), auto-resize.
  Interactive apps like nano/htop/vim need node-pty (auto-installed if
  compilation succeeds; otherwise the panel keeps working with the legacy
  pipe mode).
- **Website** — mini hosting for Node.js, PHP, Static, and Go projects:
  add websites, start/stop/restart, view logs, open directly from the port number.
  Includes a **Nginx reverse proxy** GUI: add/remove proxy hosts, start/stop/reload nginx.
- **AI Agent mode (ala opencode)** — centang Mode Agent di tab AI Chat:
  model bisa memanggil tool `exec`, `read_file`, `write_file`, `list_dir`
  dalam loop (maks 12 langkah). Tool baca jalan otomatis; `write_file` dan
  `exec` selalu minta approval Allow/Deny/Stop di chat dulu. Semua path
  dikurung di home user (safePath), exec dibatasi 30 detik & output 20 KB.
  Butuh model yang mendukung function calling OpenAI-compatible.
  Parser agent toleran terhadap router non-standar: JSON, JSON berbungkus
  `data`, maupun SSE (termasuk tool_call terpecah per delta); bila tetap
  tidak bisa diurai, pesan error menampilkan cuplikan balasan upstream.
  Parser juga mengambil objek JSON pertama yang lengkap bila ada trailer
  SSE `data: [DONE]` yang menempel di belakang JSON chat completion.
- **AI Chat (ala opencode CLI)** — menu AI dengan chat streaming ke endpoint
  OpenAI-compatible: Settings AI berisi endpoint, API key, tombol Fetch
  Models (GET /v1/models), select model + ketik manual, dan Save. Key
  disimpan di `~/.termux-panel/ai.json` (0600) dan tidak pernah dikembalikan
  ke browser (hanya `hasKey`); chat di-stream token demi token dan riwayat
  tersimpan lokal di browser.
- **Database (ala aaPanel)** — manage MySQL & PostgreSQL: connect, browse
  databases/tables, run SQL, plus tabel database (nama, jumlah tabel,
  ukuran) dengan aksi Open/Backup/Restore/Delete; **Add Database** bisa
  sekalian membuat user + hak penuh (username default = nama database,
  password bisa di-Generate, akses localhost/%/host tertentu untuk MySQL);
  kartu **Users** untuk tambah user, ganti password, grant/revoke hak per
  database, dan hapus user; backup via mysqldump/pg_dump ke
  `~/.termux-panel/db-backups/` (bisa diunduh) dan restore dari file backup
  tersebut. Semua nama divalidasi dan password di-escape sebelum masuk SQL.
  Database yang config-nya pernah disimpan lewat Save & Connect akan
  auto-connect saat panel dijalankan (dicoba lagi tiap 30 detik sampai
  server databasenya hidup); Disconnect manual dihormati, retry tidak
  menyalakannya lagi.
- **Auto-start saat panel dijalankan** (`pm2 start terwo`) — database
  auto-connect, website yang autoStart-nya ON kembali jalan, dan tunnel
  per website yang enabled ikut nyala. Semantik saklar: Start website =
  auto-start ON, Stop website = OFF. Website lama tanpa flag dianggap ON
  pada start pertama setelah update, supaya yang sudah jalan balik lagi.
- **Tunnel per website (di menu Website, bukan tab sendiri)** — tiap
  website punya tunnel Cloudflare-nya sendiri: di tabel Website, kolom
  **Akses** punya opsi eksplisit **Stay Local** (hanya localhost) /
  **Tunneling** (URL publik Cloudflare), plus tombol **Atur** untuk memilih
  mode Quick tanpa akun atau Named pakai token Cloudflare Zero Trust +
  hostname opsional. URL publiknya tampil di bawah opsi Akses. Tunnel
  hanya jalan saat websitenya jalan, ikut mati saat site Stop/crash, dan
  kembali nyala saat site di-Start — termasuk saat panel restart dan site
  auto-start. Tunnel untuk panel itu sendiri (bukan website) ada di menu
  **Tunnel** sendiri (bukan lagi di Settings, sejak v1.20.1); tunnel per
  website tetap di menu Website, kolom Akses.
- **🏪 Store** — 1-click install: nginx, nodejs, nvm, pm2,
  mysql (mariadb), postgresql, php, bun, redis, python, cronie, golang,
  9router, hermes, cloudflared, zip, unzip, openssh, termux-api, git,
  tmux, composer, sqlite, ffmpeg, yt-dlp, rsync.
- **Cron** — schedule commands automatically (crond), add/remove/enable jobs.
- **Backup** — backup folders (zip) & databases (dump), download, restore, delete.
- **Telegram notifications** — get notified when an install finishes & when a
  website goes down/recovers.
- **Telegram bot commands** — ask the bot: `/help`, `/status`, `/ram`,
  `/cpu`, `/battery`, `/sites`. Only the registered chat ID is served
  (set it in Settings → Telegram, enable "Reply to bot commands").
  Uses `getUpdates` polling every 10 seconds, no webhook.
- **System info** — hostname, uptime, memory, load average.

### Website menu
- Tunnel per website: modal Atur kini menampilkan log `cloudflared` (refresh tiap 3 detik selama modal dibuka) — termasuk log terakhir setelah tunnel mati, jadi penyebab gagal start tetap bisa dibaca.
- **Domain Otomatis (Cloudflare API, v1.20.0)** — isi sekali di Settings → kartu Domain Otomatis: API Token (permission Account → Cloudflare Tunnel → Edit dan Zone → DNS → Edit, dibatasi ke akun + zone itu), Account ID, Zone ID, domain, dan nama tunnel (default `terwo`). Setelah itu tiap website mode **Domain Otomatis** cukup ketik subdomain (`app2` atau `app2.domainmu`) — panel membuat tunnel bersama bila belum ada, menambahkan route ingress (`hostname → http://127.0.0.1:<port>`, rule lain dipertahankan, catch-all terakhir), dan membuat/memperbarui DNS CNAME proxied ke `<tunnel-id>.cfargotunnel.com`. API token + token tunnel disimpan di `~/.termux-panel/cloudflare.json` (0600) dan tidak pernah dikembalikan lewat API. Stop/Stay Local **tidak** menghapus route + DNS (supaya aktif lagi instan); pencabutan eksplisit lewat tombol **Hapus Domain** di modal Atur atau saat site dihapus.
- **Bugfix Settings → Tunnel Panel (v1.20.0)** — dulu `loadTunnel` yang dipoll tiap 5 detik selalu menimpa dropdown Mode + baris token dengan mode server, sehingga pilihan Named Tunnel yang baru dipilih kembali jadi Quick dan baris token menghilang sendiri dalam <5 detik. Sekarang mode/baris token hanya disinkronkan saat tab Settings dibuka atau saat mode server benar-benar berubah; field Hostname juga tidak ditimpa saat sedang diketik.
- **Menu Tunnel sendiri (v1.20.1)** — kartu Tunnel Panel dipindah dari Settings ke menu **Tunnel** sendiri (sidebar + mobile, slug `/tunnel`, poll status hanya jalan saat tab Tunnel dibuka). Settings kini hanya berisi Account, Domain Otomatis, Telegram, dan Panel. Tunnel per website TIDAK berubah: tetap di menu Website, kolom Akses + modal Atur.
- **Bugfix kolom Akses website (v1.20.2)** — tunnel Named (token) tidak pernah mencetak URL `trycloudflare` di log cloudflared, jadi `url` selalu kosong dan baris website macet di "Tunnel starting…" walau tunnel sudah tersambung. Sekarang kolom Akses menampilkan link `https://<hostname>` untuk mode Named maupun Domain Otomatis; bila hostname kosong, labelnya jujur: proses Named jalan, domain diatur di dashboard Cloudflare.
- **Error Setup & Uji yang jelas (v1.20.3)** — dulu Setup & Uji hanya menampilkan pesan mentah Cloudflare ("Authentication error", HTTP 403) tanpa menyebut langkah mana yang gagal. Sekarang tiap langkah dilabeli (1/3 verifikasi token, 2/3 cek zone, 3/3 buat/cek tunnel) beserta hint untuk 403, dan kode error Cloudflare ikut ditampilkan bila ada.
- **Domain Panel Otomatis (v1.20.4)** — panel Terwo sendiri bisa punya domain (mis. `panel.flaznexa.cloud`) tanpa buka dashboard Cloudflare: kartu "Domain untuk Panel" di menu Tunnel, ketik subdomain lalu Aktifkan — Terwo memakai konfigurasi Domain Otomatis + tunnel bersama yang sama untuk membuat route ingress (`hostname → http://127.0.0.1:<port panel>`, rule lain dipertahankan, catch-all terakhir) dan DNS CNAME proxied, lalu menjalankan connector cloudflared sendiri untuk tunnel bersama (boleh berdampingan dengan connector site auto; auto-reconnect + auto-start saat panel restart). Nonaktifkan sengaja MENGHAPUS route + DNS (beda dengan site yang Stop-nya mempertahankan route) supaya halaman login panel tidak menggantung publik. Syarat: Domain Otomatis di Settings sudah Setup &amp; Uji (Siap); tanpa itu Aktifkan ditolak dengan pesan jelas. Beda dengan Tunnel Panel Named: di sana routing diatur manual di dashboard Zero Trust, di sini diatur Terwo lewat API.
- **Bugfix publish tahan tunnel hilang (v1.20.5)** — aktivasi Domain Panel di HP gagal mentah "Tunnel not found (404)": tunnel tersimpan bisa hilang di tengah jalan (mis. dihapus di dashboard), dan dulu hanya panggilan *cek* tunnel yang 404 yang dibuat ulang, sementara panggilan *tulis* konfigurasi yang 404 lolos mentah ke user. Sekarang publish route (site auto maupun domain panel) memakai `cfPublishRouteResilient`: bila tulis gagal karena tunnel tidak ditemukan, ID tunnel tersimpan dibuang, tunnel baru dibuat, dan publish dicoba sekali lagi; gagal kedua diteruskan apa adanya. Error Aktifkan domain panel juga dilabeli fasenya (publish route/DNS vs menjalankan connector).
- **Bugfix tombol Copy URL tunnel panel (v1.20.6)** — dulu klik Copy URL diam saja dalam dua keadaan: tidak ada URL yang bisa dicopy (tunnel mati / masih starting / mode token tanpa hostname), dan fallback salinnya tidak pakai focus + setSelectionRange sehingga gagal diam-diam di HP (terutama iOS dan konteks non-HTTPS seperti akses via IP LAN). Sekarang: tanpa URL, tombol menampilkan penjelasan; menyalin memakai clipboard API modern dulu lalu fallback textarea yang benar, dengan umpan balik "Tersalin!" bila berhasil dan pesan tekan-tahan link bila tetap gagal.
- **Chat AI dirapikan (v1.20.7)** — dulu Mode Agent menumpuk output mentah tiap tool (JSON perintah + hasil grep/baca file) sebagai gelembung chat, dan jawaban AI tampil sebagai teks mentah sehingga `**tebal**` dan tabel `| ... |` tidak berubah jadi tampilan rapi. Sekarang: tiap tool hanya tampil satu baris ringkasan ("🔧 exec grep …") dengan detail mentah tersembunyi di balik "Lihat detail"; jawaban AI di-render sebagai markdown (tebal, miring, kode, heading, daftar, tabel, blok kode, tautan) dengan HTML di-escape dulu; dan teks jawaban yang datang bertahap digabung jadi satu gelembung per segmen (bubble baru hanya setelah tool/approval). Berlaku juga untuk chat biasa dan riwayat tersimpan.
- **Badge Tunnel Panel jujur + indikator token (v1.20.9)** — dulu badge Tunnel Panel mentok di "Tunnel starting…" walau tunnel Named sudah terhubung, karena badge hanya berubah jadi aktif bila ada URL terdeteksi dari log — dan URL itu cuma muncul di mode Quick (`*.trycloudflare.com`), tidak pernah di mode Named. Sekarang backend menandai `connected` begitu log menulis "Registered tunnel connection" (direset saat start/stop/exit), dan badge jadi "Tunnel aktif" bila jalan + (ada URL atau sudah connected); bila jalan tapi belum registrasi, badge tetap jujur "Tunnel starting…". Sekalian: kolom token yang selama ini tampil kosong kini placeholder-nya berubah jadi "Token tersimpan ✓ (kosongkan = pakai yang tersimpan)" bila token memang tersimpan (API sudah lama hanya mengembalikan `hasToken`, bukan nilainya; kosong = pakai yang tersimpan).
- **Sesi chat AI di samping (v1.20.8)** — tab AI Chat kini punya daftar sesi di samping (ala daftar chat Muse): tiap sesi = satu percakapan, judul otomatis dari pesan pertama (dipotong 40 karakter), sesi aktif disorot, tombol × per sesi untuk menghapus, dan "New Chat" membuat sesi baru tanpa menghapus yang lama. Di HP, daftar sesi dibuka lewat tombol "Sesi" sebagai drawer dari kiri (backdrop gelap, ketuk di luar untuk menutup). Riwayat tunggal lama dimigrasikan otomatis menjadi sesi pertama saat pertama dibuka setelah update. Pesan tersimpan per gelembung: tiap segmen jawaban agent (dipisah tool/approval) tersimpan sebagai pesan sendiri, jadi tampilan setelah reload sama persis dengan saat live. Catatan: karena Tailwind panel ini hasil compile, sidebar memakai kelas yang sudah ada di CSS (`flex-col`, `w-60`) — bukan `md:flex-col`/`w-56` yang tidak ter-generate (sempat membuat sidebar tampil baris, sudah diperbaiki).

The **🌐 Website** tab has four sub-tabs:

- **Node.js** — register an entry file (e.g. `web/server.js`); the panel runs
  `node <file>` with the `PORT` environment variable auto-filled with the port
  you specify.
- **PHP** — register a document-root folder (e.g. `web/blog`); the panel runs
  `php -S 127.0.0.1:PORT -t <folder>`. Needs `pkg install php` first on Termux.
- **Static** — register a folder (e.g. `web/dist`), served via
  `python3 -m http.server`. Needs `pkg install python` first.
- **Go** — register a Go project folder (e.g. `goapp`); the panel runs
  `go run .` with the `PORT` env auto-filled. Needs `pkg install golang` first.

Each website can be started/stopped/restarted, its logs viewed live from the
panel, and its port number clicked to open the website directly.

## Database
- phpMyAdmin ala aaPanel: kartu phpMyAdmin di tab Database (Pasang sekali dari phpmyadmin.net, Start/Stop, auto-start, port bisa diubah); tombol Open per database membuka `<url>/index.php?db=<nama>` dengan login otomatis dari kredensial MySQL panel (kalau berhenti, Open menyalakannya dulu; kalau belum terpasang, Open mengarahkan ke kartu phpMyAdmin). Klik nama database tetap membuka browser internal panel. Hanya di-bind ke 127.0.0.1 — tidak ikut tunnel panel. Mode Agent: tombol Always Allow di bubble approval — sekali diklik, approval exec/write berikutnya jalan otomatis sampai halaman di-reload (indikator di header chat, klik untuk mematikan).

The **🗄️ Database** menu has two sub-tabs: **MySQL** and **PostgreSQL**.

1. Fill in Host, Port, User, Password, and Database (optional).
2. Click **🔌 Test Connection** to check, then **💾 Save & Connect**.
3. Once connected, pick a database in the left panel to see its tables,
   click a table to see its contents (first 50 rows), or write your own SQL
   and click **▶️ Run**.

Notes:

- Install the database server first via the **🏪 Store** menu.
- **MariaDB**: first time, run `mysql_install_db` once, then `mysqld_safe &`.
  Default user `root` with no password on localhost.
- **PostgreSQL**: first time, `initdb -D $PREFIX/var/lib/postgresql`,
  then `pg_ctl -D $PREFIX/var/lib/postgresql -l logfile start`.
  Default user = your Termux username (see `whoami` output), empty password.

## 🏪 Store

The **🏪 Store** menu shows cards for 26 packages: nginx, nodejs, nvm, pm2,
mysql (mariadb), postgresql, php, bun, redis, python, cronie, golang,
9router, hermes, cloudflared, zip, unzip, openssh, termux-api, git,
tmux, composer, sqlite, ffmpeg, yt-dlp, rsync. Click **Install** and the
installation log streams live in a popup.

Note: the zip/unzip features in the file manager and folder backup need the
`zip`/`unzip` packages — 1-click install them from the Store if missing.

## Termux guide (no systemd)

This panel is designed for Termux: no `systemctl`, every service runs directly
as a process. Consequences:

**Databases are started manually** (once per phone reboot):

```bash
# MariaDB (first time: mysql_install_db)
mysqld_safe &

# PostgreSQL (first time: initdb -D $PREFIX/var/lib/postgresql)
pg_ctl -D $PREFIX/var/lib/postgresql -l logfile start

# Redis
redis-server --daemonize yes
```

**Auto-start the panel on phone reboot** — install the Termux:Boot app, then
create `~/.termux/boot/terwo.sh`:

```bash
#!/data/data/com.termux/files/usr/bin/sh
export PATH=$PATH:/data/data/com.termux/files/usr/bin
termux-wake-lock
pm2 resurrect
```

Don't forget `chmod +x ~/.termux/boot/terwo.sh`.
(The installer already ran `pm2 save`, so `pm2 resurrect` brings the panel
back automatically.)

**Other tips:**

- The battery widget on the Dashboard needs the **Termux:API** app + `pkg install termux-api`.
- To stop Android from killing the panel/websites when the screen is off: run
  `termux-wake-lock`, and disable battery optimization for the Termux app.
- Ports below 1024 cannot be used without root — the panel rejects them automatically.
- The `bun` and `nvm` packages in the Store may fail on Termux
  (no matching official builds); failures show in the log, the panel keeps running.
- The panel already binds to `0.0.0.0` (reachable across the LAN). To lock it
  back to localhost only: `pm2 delete terwo && pm2 start panel.js --name terwo && pm2 save`.

## Security notes — read first

1. **Do not expose this panel directly to the public internet.** The installer
   binds the panel to `0.0.0.0` so it is reachable across the LAN (other
   PCs/phones) — so make sure the password is changed to a strong one, and
   only run it on WiFi you trust. Don't do this on public/busy office WiFi.
2. If you need access from outside, use a safe path: an SSH tunnel
   (`ssh -L 8080:localhost:8080 ...`) or a Cloudflare Tunnel protected by
   Cloudflare Access — not a bare `0.0.0.0` bind.
3. The file manager is restricted to `PANEL_ROOT` (default `$HOME`) — it cannot
   escape that directory.
4. The initial username + password printed in the terminal only appear once.
   If you lose them, delete `~/.termux-panel/config.json` and run again to
   generate new credentials.

## Update from GitHub

Fork repo: **https://github.com/willy911/terwo** (fork dari https://github.com/elkom14a/terwo). To update to the latest version:

```bash
cd ~/terwo
git pull --ff-only
npm install --no-audit --no-fund
pm2 restart terwo
```

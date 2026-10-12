// Guess the Character - zero-dependency Node server.
// Games live in memory; clients get live updates over Server-Sent Events (with polling as a safety net).
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const IMG_DIR = path.join(PUBLIC, 'images');
const MINE_FILE = path.join(__dirname, 'my-categories.json');
const DB_FILE = path.join(__dirname, 'data', 'characters.json');
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(6).toString('hex');
const MAX_GAMES = 20000;              // hard cap on simultaneous games
const GAME_IDLE_MS = 3 * 60 * 60 * 1000;   // games with no activity for 3h are deleted
const GAMES = Object.create(null);          // no prototype, so ids like "__proto__" can never match
let gameCount = 0;
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SNAPSHOT = path.join(DATA_DIR, 'games.json');
const ID_RE = /^[a-f0-9]{5}$/, PID_RE = /^[a-f0-9]{8}$/;
const cleanName = n => String(n).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
let dirty = false;
fs.mkdirSync(IMG_DIR, { recursive: true });

// ---------- Characters ----------
const FALLBACK_CATEGORIES = [
  { clue: 'They are all footballers', items: ['Lionel Messi','Cristiano Ronaldo','Mohamed Salah','Neymar','Kylian Mbappé','Zlatan Ibrahimović','Luka Modrić','Erling Haaland','Kevin De Bruyne','Zinedine Zidane','Ronaldinho','Pelé'] },
  { clue: 'They are all scientists or inventors', items: ['Albert Einstein','Isaac Newton','Marie Curie','Nikola Tesla','Stephen Hawking','Galileo Galilei','Charles Darwin','Leonardo da Vinci','Thomas Edison','Ahmed Zewail','Alexander Graham Bell','Archimedes'] },
  { clue: 'They are all Hollywood actors', items: ['Tom Cruise','Brad Pitt','Leonardo DiCaprio','Will Smith','Johnny Depp','Robert Downey Jr.','Keanu Reeves','Dwayne Johnson','Morgan Freeman','Jackie Chan','Arnold Schwarzenegger','Tom Hanks'] },
  { clue: 'They are all singers', items: ['Michael Jackson','Elvis Presley','Taylor Swift','Beyoncé','Eminem','Rihanna','Shakira','Adele','Justin Bieber','Ed Sheeran','Lady Gaga','Bruno Mars'] },
  { clue: 'They are all Egyptian legends', items: ['Omar Sharif','Adel Emam','Umm Kulthum','Amr Diab','Mohamed Salah','Naguib Mahfouz','Ahmed Zewail','Magdi Yacoub','Anwar Sadat','Gamal Abdel Nasser','Mahmoud El Khatib','Yousra'] },
  { clue: 'They are all cartoon or game characters', items: ['Mickey Mouse','Bugs Bunny','Homer Simpson','SpongeBob SquarePants (character)','Donald Duck','Pikachu','Mario','Sonic the Hedgehog','Scooby-Doo (character)','Winnie-the-Pooh','Shrek (character)','Garfield'] },
  { clue: 'They are all superheroes or villains', items: ['Spider-Man','Batman','Superman','Iron Man','Hulk (comics)','Thor (Marvel Comics)','Wonder Woman','Captain America','Joker (character)','Thanos','Black Panther (comics)','Deadpool'] },
  { clue: 'They are all famous leaders or historic figures', items: ['Cleopatra','Napoleon','Julius Caesar','Alexander the Great','Abraham Lincoln','Winston Churchill','Nelson Mandela','Genghis Khan','Queen Victoria','Mahatma Gandhi','Tutankhamun','Ramesses II'] },
];

const clean = n => String(n).replace(/\s*\(.*\)$/, '');
const slug = n => clean(n).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const nameOf = i => (typeof i === 'object' ? i.name : i);

function scanPhotos() {            // slug -> { file, v }
  const map = {};
  try {
    for (const f of fs.readdirSync(IMG_DIR)) {
      const m = f.match(/^(.+)\.(jpe?g|png|webp)$/i);
      if (m) map[m[1].toLowerCase()] = { file: f, v: Math.floor(fs.statSync(path.join(IMG_DIR, f)).mtimeMs) };
    }
  } catch (e) {}
  return map;
}
function readMine() { try { return JSON.parse(fs.readFileSync(MINE_FILE, 'utf8')); } catch (e) { return []; } }

let ALL_CATEGORIES = [];
function loadCategories() {
  const photos = scanPhotos();
  const cats = [];
  for (const m of readMine()) {                                   // your categories: only characters that have a photo are playable
    const items = [];
    for (const entry of m.items || []) {
      const name = nameOf(entry), p = photos[slug(name)];
      const image = typeof entry === 'object' && entry.image ? entry.image : p ? `/images/${p.file}?v=${p.v}` : null;
      if (image) items.push({ name: clean(name), image });
    }
    if (items.length >= 5) cats.push({ clue: m.clue, items });
  }
  try {                                                           // optional generated database (build-database.js)
    for (const c of JSON.parse(fs.readFileSync(DB_FILE, 'utf8')).categories || [])
      if (c.items && c.items.length >= 5 && !cats.some(x => x.clue === c.clue)) cats.push(c);
  } catch (e) {}
  if (!cats.length) { console.log('No categories with photos yet - using the small built-in list (no photos).'); ALL_CATEGORIES = FALLBACK_CATEGORIES.map(c => ({ clue: c.clue, items: c.items.map(name => ({ name })) })); }
  else ALL_CATEGORIES = cats;
  console.log(`Categories ready to play: ${ALL_CATEGORIES.length}`);
}
loadCategories();
let reloadTimer = null;
const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadCategories, 400); };
try { fs.watch(IMG_DIR, scheduleReload); } catch (e) {}
fs.watchFile(MINE_FILE, { interval: 2000 }, scheduleReload);
fs.watchFile(DB_FILE, { interval: 3000 }, scheduleReload);

// ---------- Helpers ----------
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const uid = (n = 6) => crypto.randomBytes(n).toString('hex').slice(0, n);
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';   // behind Render/Railway/Fly/nginx the real visitor IP is in X-Forwarded-For; set TRUST_PROXY=0 if the server is exposed directly
const clientIp = req => (TRUST_PROXY && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'x';

const buckets = new Map();
function limited(ip, kind, max, windowMs) {
  const k = kind + ip, now = Date.now();
  let b = buckets.get(k);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
  return ++b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function jsonBody(req) { try { return JSON.parse((await readBody(req, 1e5)).toString() || '{}'); } catch (e) { return {}; } }
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

// ---------- Game logic ----------
function startRound(game) {
  game.round++;
  game.phase = 'playing';
  game.winnerIds = [];
  const n = game.players.length;
  if (game.mode === 'random') {                                    // random mode: no shared clue, characters come from any category
    const seen = new Set(game.usedChars || []), pool = new Map();
    for (const c of ALL_CATEGORIES) for (const it of c.items) { const k = it.name.toLowerCase(); if (!pool.has(k)) pool.set(k, it); }
    let all = [...pool.values()];
    if (all.some(i => i.image)) all = all.filter(i => i.image);   // never mix photo-less characters into a round that has photos
    let fresh = all.filter(i => !seen.has(i.name.toLowerCase()));
    if (fresh.length < n) { game.usedChars = []; fresh = all; }   // everything has been played: start over
    const picked = shuffle(fresh);
    game.clue = null;
    game.usedChars = (game.usedChars || []).concat(picked.slice(0, n).map(i => i.name.toLowerCase())).slice(-400);
    game.players.forEach((p, i) => { const c = picked[i % picked.length]; p.character = c.name; p.image = c.image || null; p.status = 'waiting'; p.time = null; p.startedAt = null; });
    return;
  }
  let eligible = ALL_CATEGORIES.map((c, i) => i).filter(i => ALL_CATEGORIES[i].items.length >= n);
  if (!eligible.length) eligible = ALL_CATEGORIES.map((c, i) => i);
  let pool = eligible.filter(i => !game.usedCats.includes(i));
  if (!pool.length) { game.usedCats = []; pool = eligible; }
  const ci = pool[crypto.randomInt(pool.length)];
  game.usedCats.push(ci);
  const cat = ALL_CATEGORIES[ci];
  game.clue = cat.clue;
  const chars = shuffle(cat.items);
  game.players.forEach((p, i) => { const c = chars[i % chars.length]; p.character = c.name; p.image = c.image || null; p.status = 'waiting'; p.time = null; p.startedAt = null; });
}
function finishRound(game) {
  if (game.phase === 'results') return;
  game.phase = 'results';
  const done = game.players.filter(p => p.time != null).sort((a, b) => a.time - b.time);
  if (done.length) { game.scores[done[0].id] = (game.scores[done[0].id] || 0) + 1; game.winnerIds = [done[0].id]; }
}
function view(game, pid) {
  const me = game.players.find(p => p.id === pid);
  if (!me) return null;
  const results = game.phase === 'results';
  const isHost = me.id === game.players[0].id;
  return {
    id: game.id, mode: game.mode || 'clue', round: game.round, phase: game.phase, clue: game.clue, hostName: game.players[0].name, isHost,
    me: { id: me.id, name: me.name, status: me.status, time: me.time, character: me.character, image: me.image },
    winnerIds: game.winnerIds,
    players: game.players.map(p => ({
      id: isHost ? p.id : undefined, isMe: p.id === me.id, name: p.name, status: p.status, wins: game.scores[p.id] || 0,
      time: results ? p.time : null, character: results ? p.character : null, image: results ? p.image : null,
    })),
  };
}
function broadcast(game) {
  for (const s of game.subs) { try { s.res.write(`data: ${JSON.stringify(view(game, s.pid))}\n\n`); } catch (e) {} }
}
function endGame(game) {
  for (const s of game.subs) { try { s.res.write('event: ended\ndata: {}\n\n'); s.res.end(); } catch (e) {} }
  game.subs.clear();
  delete GAMES[game.id]; gameCount--; dirty = true;
}
setInterval(() => {
  const now = Date.now();
  for (const id in GAMES) if (now - GAMES[id].lastActive > GAME_IDLE_MS) endGame(GAMES[id]);
}, 10 * 60 * 1000).unref();

// ---------- Admin (photo manager) ----------
function isAdmin(req, url) {
  const k = String(url.searchParams.get('key') || req.headers['x-admin-key'] || '');
  const a = Buffer.from(k), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
function savePhoto(sl, buf) {
  const ext = sniff(buf);
  if (!ext) throw new Error('That is not a JPG, PNG or WEBP image');
  if (!/^[a-z0-9-]{1,80}$/.test(sl)) throw new Error('Bad name');
  for (const e of ['jpg', 'jpeg', 'png', 'webp']) { try { fs.unlinkSync(path.join(IMG_DIR, `${sl}.${e}`)); } catch (x) {} }
  fs.writeFileSync(path.join(IMG_DIR, `${sl}.${ext}`), buf);
  loadCategories();
  return `${sl}.${ext}`;
}
async function adminApi(req, res, url, parts) {
  if (!isAdmin(req, url)) return json(res, 401, { error: 'Wrong admin key' });
  const action = parts[2];
  try {
    if (action === 'list') {
      const photos = scanPhotos(), seen = new Set();
      const cats = readMine().map(m => ({
        clue: m.clue,
        items: (m.items || []).map(i => {
          const name = nameOf(i), sl = slug(name), p = photos[sl];
          if (p) seen.add(sl);
          return { name: clean(name), slug: sl, image: p ? `/images/${p.file}?v=${p.v}` : null };
        }),
      }));
      const all = new Set(cats.flatMap(c => c.items.map(i => i.slug)));
      return json(res, 200, { categories: cats, playable: ALL_CATEGORIES.length, totalNames: all.size, haveNames: [...all].filter(s => photos[s]).length });
    }
    if (action === 'upload' && req.method === 'POST') {
      const buf = await readBody(req, 6 * 1024 * 1024);
      const file = savePhoto(String(url.searchParams.get('slug') || ''), buf);
      return json(res, 200, { ok: true, image: `/images/${file}?v=${Date.now()}` });
    }
    if (action === 'fetch' && req.method === 'POST') {            // download an image from a pasted link
      const { slug: sl, url: link } = await jsonBody(req);
      if (!/^https?:\/\//i.test(link || '')) throw new Error('That is not a web link');
      const r = await fetch(link, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 GuessTheCharacter' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('The link returned HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 6 * 1024 * 1024) throw new Error('Image is too big');
      const file = savePhoto(sl, buf);
      return json(res, 200, { ok: true, image: `/images/${file}?v=${Date.now()}` });
    }
    if (action === 'delete' && req.method === 'POST') {
      const { slug: sl } = await jsonBody(req);
      if (!/^[a-z0-9-]{1,80}$/.test(sl || '')) throw new Error('Bad name');
      for (const e of ['jpg', 'jpeg', 'png', 'webp']) { try { fs.unlinkSync(path.join(IMG_DIR, `${sl}.${e}`)); } catch (x) {} }
      loadCategories();
      return json(res, 200, { ok: true });
    }
  } catch (e) { return json(res, 400, { error: e.message }); }
  return json(res, 404, { error: 'Not found' });
}

// ---------- Static files ----------
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const textCache = new Map();
function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  rel = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
  const candidates = [path.join(PUBLIC, rel), path.join(__dirname, path.basename(rel))];
  let file = null, st = null;
  for (const c of candidates) {
    if (!c.startsWith(__dirname) || /server\.js$|build-database\.js$|package\.json$|my-categories\.json$/.test(c)) continue;
    try { const s = fs.statSync(c); if (s.isFile() && TYPES[path.extname(c).toLowerCase()]) { file = c; st = s; break; } } catch (e) {}
  }
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
  const type = TYPES[path.extname(file).toLowerCase()], isImg = type.startsWith('image/');
  const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
  const headers = { 'Content-Type': type + (isImg ? '' : '; charset=utf-8'), ETag: etag, 'Cache-Control': isImg ? 'public, max-age=86400' : 'no-cache' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  if (isImg) { res.writeHead(200, { ...headers, 'Content-Length': st.size }); return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res); }
  let c = textCache.get(file);
  if (!c || c.etag !== etag) { const buf = fs.readFileSync(file); c = { etag, buf, gz: zlib.gzipSync(buf) }; textCache.set(file, c); }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': c.gz.length }); return res.end(c.gz); }
  res.writeHead(200, { ...headers, 'Content-Length': c.buf.length }); res.end(c.buf);
}

// ---------- Router ----------
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://en.wikipedia.org; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, games: gameCount, categories: ALL_CATEGORIES.length, uptime: Math.round(process.uptime()) });
    if (parts[0] !== 'api') return serveStatic(req, res, url);

    const ip = clientIp(req);
    if (limited(ip, 'api', 1500, 60000)) return json(res, 429, { error: 'Too many requests, slow down' });
    if (parts[1] === 'admin') return adminApi(req, res, url, parts);

    if (parts[1] === 'info') {
      const lan = [];
      if (!PROD) for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal) lan.push(i.address);
      return json(res, 200, { port: PORT, lan });
    }
    if (req.method === 'POST' && parts[1] === 'create') {
      if (limited(ip, 'create', 40, 10 * 60000)) return json(res, 429, { error: 'Too many new games from your network, try again in a few minutes' });
      if (gameCount >= MAX_GAMES) return json(res, 503, { error: 'Server is full, try again soon' });
      const { names, mode } = await jsonBody(req);
      if (!Array.isArray(names)) return json(res, 400, { error: 'Names are required' });
      const clean2 = names.map(cleanName).filter(Boolean);
      if (clean2.length < 2 || clean2.length > 7) return json(res, 400, { error: 'Need 2-7 players' });
      let gid; do { gid = uid(5); } while (GAMES[gid]);
      const game = { id: gid, mode: mode === 'random' ? 'random' : 'clue', usedChars: [], created: Date.now(), lastActive: Date.now(), round: 0, phase: 'playing', scores: {}, usedCats: [], winnerIds: [], subs: new Set(),
        players: clean2.map(n => ({ id: uid(8), name: n, status: 'waiting', time: null, character: null, image: null })) };
      startRound(game);
      GAMES[game.id] = game; gameCount++; dirty = true;
      return json(res, 200, { gameId: game.id, hostId: game.players[0].id });
    }
    if (parts[1] !== 'game' || !ID_RE.test(parts[2] || '')) return json(res, 404, { error: 'Not found' });
    const game = GAMES[parts[2]];
    if (!game) return json(res, 404, { error: 'Game not found' });
    game.lastActive = Date.now();

    if (req.method === 'GET' && parts[3] === 'events') {                       // live updates (Server-Sent Events)
      const pid = url.searchParams.get('p') || '';
      if (!PID_RE.test(pid) || !view(game, pid)) return json(res, 404, { error: 'Player not found' });
      if (game.subs.size >= 40) return json(res, 429, { error: 'Too many connections' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const sub = { res, pid };
      game.subs.add(sub);
      res.write('retry: 2000\n\n');
      res.write(`data: ${JSON.stringify(view(game, pid))}\n\n`);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 25000);
      req.on('close', () => { clearInterval(hb); game.subs.delete(sub); });
      return;
    }
    if (req.method === 'GET') {
      const v = view(game, url.searchParams.get('p'));
      return v ? json(res, 200, v) : json(res, 404, { error: 'Player not found' });
    }
    if (req.method === 'POST') {
      const b = await jsonBody(req);
      const me = PID_RE.test(String(b.p)) ? game.players.find(p => p.id === b.p) : null;
      if (!me) return json(res, 404, { error: 'Player not found' });
      const isHost = me.id === game.players[0].id;
      if (parts[3] === 'end') {
        if (!isHost) return json(res, 403, { error: 'Only the host can end the game' });
        endGame(game); return json(res, 200, { ended: true });
      }
      if (parts[3] === 'start') {                                         // the photo just appeared on this phone
        if (game.phase === 'playing' && me.status === 'waiting' && !me.startedAt) me.startedAt = Date.now();
        return json(res, 200, { ok: true });
      }
      dirty = true;
      if (parts[3] === 'finish' && game.phase === 'playing' && me.status !== 'done') {
        const client = Math.max(0, Math.min(Number(b.time) || 0, 600000));
        let t = client;
        if (me.startedAt) {                                                  // a phone can only cheat by reporting a SHORTER time than the server measured
          const server = Date.now() - me.startedAt;
          if (client < server - 1000) t = Math.min(server, 600000);          // 1 s of allowance for network delay
        }
        me.time = Math.round(t); me.status = 'done';
        if (game.players.every(p => p.status === 'done')) finishRound(game);
        broadcast(game);
      } else if (parts[3] === 'force' && isHost) { finishRound(game); broadcast(game); }
      else if (parts[3] === 'next' && game.phase === 'results' && b.round === game.round) { startRound(game); broadcast(game); }
      return json(res, 200, view(game, me.id));
    }
    json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    console.error('Request error:', e && e.message);
    try { json(res, 500, { error: 'Server error' }); } catch (x) {}
  }
});
server.keepAliveTimeout = 65000;      // longer than most load balancers' idle timeout
server.headersTimeout = 66000;
server.requestTimeout = 30000;
server.maxHeadersCount = 60;

// ---------- Save running games so a restart/deploy does not kick everyone out ----------
function saveSnapshot() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const list = Object.values(GAMES).map(({ subs, ...g }) => g);
    fs.writeFileSync(SNAPSHOT + '.tmp', JSON.stringify(list));
    fs.renameSync(SNAPSHOT + '.tmp', SNAPSHOT);
    dirty = false;
  } catch (e) { console.error('Could not save games:', e.message); }
}
(function loadSnapshot() {
  try {
    const now = Date.now();
    for (const g of JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')))
      if (g && ID_RE.test(g.id) && Array.isArray(g.players) && now - (g.lastActive || g.created) < GAME_IDLE_MS) { g.subs = new Set(); g.lastActive = now; GAMES[g.id] = g; gameCount++; }
    if (gameCount) console.log(`Restored ${gameCount} running games`);
  } catch (e) { /* first start */ }
})();
setInterval(saveSnapshot, 15000).unref();
function shutdown(sig) {
  console.log(`${sig}: saving games and shutting down...`);
  saveSnapshot();
  for (const g of Object.values(GAMES)) for (const s of g.subs) { try { s.res.end(); } catch (e) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', e => console.error('uncaught:', e));
process.on('unhandledRejection', e => console.error('unhandled:', e));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nGuess the Character is running!\n  This computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log(`  On your Wi-Fi:  http://${i.address}:${PORT}`);
  console.log(`\n  Photo manager:  /admin.html#key=${ADMIN_KEY}` + (process.env.ADMIN_KEY ? '' : '   (random key, changes every restart; set ADMIN_KEY to keep one)') + '\n');
});

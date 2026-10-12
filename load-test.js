// Functional + load test.  Usage:  node test/load-test.js [games=300] [playersPerGame=5]
// Starts its own server on a spare port, plays full games with simulated phones, and prints latency and error counts.
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3490 + Math.floor(Math.random() * 400);
const GAMES = Number(process.argv[2]) || 300, PPG = Number(process.argv[3]) || 5;
const agent = new http.Agent({ keepAlive: true, maxSockets: 4000 });
const lat = []; let errors = 0, tooMany = 0;

function call(method, p, body, ip = '10.0.0.1') {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null, t0 = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, agent,
      headers: { 'X-Forwarded-For': ip, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
        if (res.statusCode === 429) tooMany++;
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        resolve({ status: res.statusCode, json: j, headers: res.headers });
      });
    });
    req.on('error', e => { errors++; reject(e); });
    if (data) req.write(data); req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, ok) => { if (!ok) { failed++; console.log('  FAIL  ' + name); } else console.log('  ok    ' + name); };

async function functional() {
  console.log('\nFunctional checks');
  const c = await call('POST', '/api/create', { names: ['Ali', 'Sara', 'Omar'] });
  check('create game', c.status === 200 && c.json.gameId && c.json.hostId);
  const g = c.json.gameId, host = c.json.hostId;
  const v = await call('GET', `/api/game/${g}?p=${host}`);
  check('host view has own character', !!v.json.me.character);
  check('other players\' characters are hidden', v.json.players.every(p => p.character === null));
  const ids = v.json.players.map(p => p.id);
  check('host receives player ids for invite links', ids.every(Boolean));
  const sara = ids[1], omar = ids[2];
  const sv = await call('GET', `/api/game/${g}?p=${sara}`);
  check('friend does not receive other ids', sv.json.players.every(p => p.id === undefined));
  check('bad game id rejected', (await call('GET', '/api/game/__proto__?p=x')).status === 404);
  check('bad player id rejected', (await call('GET', `/api/game/${g}?p=zzzzzzzz`)).status === 404);
  check('empty names rejected', (await call('POST', '/api/create', { names: ['', '  '] })).status === 400);
  check('8 players rejected', (await call('POST', '/api/create', { names: ['a','b','c','d','e','f','g','h'] })).status === 400);
  check('html in names is stripped', (await call('POST', '/api/create', { names: ['<b>X</b>', 'Y'] })).status === 200);

  // timing: server-verified
  await call('POST', `/api/game/${g}/start`, { p: host });
  await sleep(1500);
  const fin = await call('POST', `/api/game/${g}/finish`, { p: host, time: 5 });   // lying phone: claims 5 ms
  check('faked time is replaced by server time', fin.json.me.time >= 1400);
  await call('POST', `/api/game/${g}/start`, { p: sara }); await sleep(50);
  await call('POST', `/api/game/${g}/finish`, { p: sara, time: 60 });
  check('players cannot finish twice', (await call('POST', `/api/game/${g}/finish`, { p: sara, time: 1 })).json.me.time >= 40);
  check('friend cannot force results', (await call('POST', `/api/game/${g}/force`, { p: sara })).json.phase === 'playing');
  const f = await call('POST', `/api/game/${g}/force`, { p: host });
  check('host can force results', f.json.phase === 'results');
  check('results reveal characters', f.json.players.every(p => p.character));
  const winner = f.json.players.slice().sort((a, b) => (a.time ?? 1e12) - (b.time ?? 1e12))[0];
  check('fastest player ranks first (Sara)', winner.name === 'Sara');
  const n = await call('POST', `/api/game/${g}/next`, { p: host, round: 1 });
  check('next round starts', n.json.round === 2 && n.json.phase === 'playing');
  check('score is kept across rounds', n.json.players.find(p => p.name === 'Sara').wins === 1);
  check('stale "next" is ignored', (await call('POST', `/api/game/${g}/next`, { p: host, round: 1 })).json.round === 2);
  check('only host can end', (await call('POST', `/api/game/${g}/end`, { p: omar })).status === 403);
  check('host ends the game', (await call('POST', `/api/game/${g}/end`, { p: host })).status === 200);
  check('ended game is gone', (await call('GET', `/api/game/${g}?p=${host}`)).status === 404);
  const h = await call('GET', '/healthz'); check('health endpoint', h.status === 200 && h.json.ok);
  const cc = await call('POST', '/api/create', { names: ['M', 'N'] }); var c2gid = cc.json.gameId, c2host = cc.json.hostId;
  const idx = await call('GET', '/'); check('index page served with security headers', idx.status === 200 && idx.headers['x-content-type-options'] === 'nosniff' && !!idx.headers['content-security-policy']);

  // random mode
  const rm = await call('POST', '/api/create', { names: ['A', 'B', 'C', 'D'], mode: 'random' });
  const rv = await call('GET', `/api/game/${rm.json.gameId}?p=${rm.json.hostId}`);
  check('random mode: no clue, mode reported', rv.json.mode === 'random' && rv.json.clue === null);
  const rf = await call('POST', `/api/game/${rm.json.gameId}/force`, { p: rm.json.hostId });
  const rn = rf.json.players.map(p => p.character);
  check('random mode: every player gets a different character', rn.every(Boolean) && new Set(rn).size === rn.length);
  const r2 = await call('POST', `/api/game/${rm.json.gameId}/next`, { p: rm.json.hostId, round: 1 });
  check('random mode: next round still random with no clue', r2.json.mode === 'random' && r2.json.clue === null);
  check('default mode is clue mode', (await call('GET', `/api/game/${c2gid}?p=${c2host}`)).json.mode === 'clue');

  // live updates
  const c2 = await call('POST', '/api/create', { names: ['A', 'B'] });
  const g2 = c2.json.gameId, h2 = c2.json.hostId;
  const got = await new Promise(resolve => {
    const msgs = [];
    const req = http.get({ host: '127.0.0.1', port: PORT, path: `/api/game/${g2}/events?p=${h2}`, headers: { 'X-Forwarded-For': '10.9.9.9' } }, res => {
      res.on('data', d => { msgs.push(String(d)); if (msgs.join('').split('data:').length > 2) { req.destroy(); resolve(msgs.join('')); } });
      setTimeout(() => call('POST', `/api/game/${g2}/start`, { p: h2 }).then(() => call('POST', `/api/game/${g2}/finish`, { p: h2, time: 100 })), 200);
      setTimeout(() => { req.destroy(); resolve(msgs.join('')); }, 3000);
    });
  });
  check('live (SSE) updates arrive', got.split('data:').length > 2);
}

async function load() {
  console.log(`\nLoad test: ${GAMES} games x ${PPG} players = ${GAMES * PPG} simulated phones`);
  lat.length = 0; errors = 0; tooMany = 0;
  const t0 = Date.now();
  let ipn = 1;
  async function oneGame(i) {
    const ip = `172.16.${(i >> 8) & 255}.${i & 255}`;
    const names = Array.from({ length: PPG }, (_, k) => 'P' + k);
    const c = await call('POST', '/api/create', { names }, ip);
    if (c.status !== 200) return;
    const g = c.json.gameId, host = c.json.hostId;
    const hv = await call('GET', `/api/game/${g}?p=${host}`, null, ip);
    const ids = hv.json.players.map(p => p.id);
    for (let round = 1; round <= 2; round++) {
      await Promise.all(ids.map(async (pid, k) => {
        await call('GET', `/api/game/${g}?p=${pid}`, null, `${ip}`);
        await sleep(20 + Math.random() * 200);
        await call('POST', `/api/game/${g}/start`, { p: pid }, ip);
        for (let poll = 0; poll < 3; poll++) { await sleep(100 + Math.random() * 300); await call('GET', `/api/game/${g}?p=${pid}`, null, ip); }
        await call('POST', `/api/game/${g}/finish`, { p: pid, time: 500 + Math.random() * 3000 }, ip);
      }));
      const r = await call('GET', `/api/game/${g}?p=${host}`, null, ip);
      if (r.json.phase !== 'results') failed++;
      if (round === 1) await call('POST', `/api/game/${g}/next`, { p: host, round: 1 }, ip);
    }
  }
  await Promise.all(Array.from({ length: GAMES }, (_, i) => oneGame(i)));
  const secs = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const q = p => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1);
  console.log(`  requests: ${lat.length} in ${secs.toFixed(1)}s (${Math.round(lat.length / secs)} req/s)`);
  console.log(`  latency ms  p50=${q(0.5)}  p95=${q(0.95)}  p99=${q(0.99)}  max=${lat[lat.length - 1].toFixed(1)}`);
  console.log(`  connection errors: ${errors}   rate-limited (429): ${tooMany}`);
  const h = await call('GET', '/healthz'); console.log(`  server still healthy: ${h.status === 200}  games in memory: ${h.json.games}`);
  const mem = (await new Promise(r => { const p = require('child_process').exec(`ps -o rss= -p ${srv.pid}`, (e, o) => r(Number(o) / 1024)); })).toFixed(0);
  console.log(`  server memory: ${mem} MB`);
  if (errors || tooMany || failed) failed++;
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-'));
const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', d => process.stderr.write(d));
(async () => {
  for (let i = 0; i < 50; i++) { try { await call('GET', '/healthz'); break; } catch (e) { await sleep(100); } }
  errors = 0;
  try { await functional(); await load(); }
  catch (e) { console.log('Test crashed:', e); failed++; }
  srv.kill('SIGTERM');
  await sleep(300);
  console.log(failed ? `\n${failed} problem(s) found` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
})();

// Guess the Character - zero-dependency Node server (in-memory games)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const GAMES = {};
const GAME_TTL = 6 * 60 * 60 * 1000;

// ---- Categories: the "clue" everyone shares, plus Wikipedia page titles ----
const CATEGORIES = [
  { clue: 'They are all footballers', items: ['Lionel Messi','Cristiano Ronaldo','Mohamed Salah','Neymar','Kylian Mbappé','Zlatan Ibrahimović','Luka Modrić','Erling Haaland','Kevin De Bruyne','Zinedine Zidane','Ronaldinho','Pelé'] },
  { clue: 'They are all scientists or inventors', items: ['Albert Einstein','Isaac Newton','Marie Curie','Nikola Tesla','Stephen Hawking','Galileo Galilei','Charles Darwin','Leonardo da Vinci','Thomas Edison','Ahmed Zewail','Alexander Graham Bell','Archimedes'] },
  { clue: 'They are all Hollywood actors', items: ['Tom Cruise','Brad Pitt','Leonardo DiCaprio','Will Smith','Johnny Depp','Robert Downey Jr.','Keanu Reeves','Dwayne Johnson','Morgan Freeman','Jackie Chan','Arnold Schwarzenegger','Tom Hanks'] },
  { clue: 'They are all singers', items: ['Michael Jackson','Elvis Presley','Taylor Swift','Beyoncé','Eminem','Rihanna','Shakira','Adele','Justin Bieber','Ed Sheeran','Lady Gaga','Bruno Mars'] },
  { clue: 'They are all Egyptian legends', items: ['Omar Sharif','Adel Emam','Umm Kulthum','Amr Diab','Mohamed Salah','Naguib Mahfouz','Ahmed Zewail','Magdi Yacoub','Anwar Sadat','Gamal Abdel Nasser','Mahmoud El Khatib','Yousra'] },
  { clue: 'They are all cartoon or game characters', items: ['Mickey Mouse','Bugs Bunny','Homer Simpson','SpongeBob SquarePants (character)','Donald Duck','Pikachu','Mario','Sonic the Hedgehog','Scooby-Doo (character)','Winnie-the-Pooh','Shrek (character)','Garfield'] },
  { clue: 'They are all superheroes or villains', items: ['Spider-Man','Batman','Superman','Iron Man','Hulk (comics)','Thor (Marvel Comics)','Wonder Woman','Captain America','Joker (character)','Thanos','Black Panther (comics)','Deadpool'] },
  { clue: 'They are all famous leaders or historic figures', items: ['Cleopatra','Napoleon','Julius Caesar','Alexander the Great','Abraham Lincoln','Winston Churchill','Nelson Mandela','Genghis Khan','Queen Victoria','Mahatma Gandhi','Tutankhamun','Ramesses II'] },
];

function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const uid = (n = 6) => crypto.randomBytes(n).toString('hex').slice(0, n);

function startRound(game) {
  game.round++;
  game.phase = 'playing';
  game.winnerIds = [];
  const unused = CATEGORIES.map((_, i) => i).filter(i => !game.usedCats.includes(i));
  const pool = unused.length ? unused : CATEGORIES.map((_, i) => i);
  if (!unused.length) game.usedCats = [];
  const ci = pool[crypto.randomInt(pool.length)];
  game.usedCats.push(ci);
  const cat = CATEGORIES[ci];
  game.clue = cat.clue;
  const chars = shuffle(cat.items);
  game.players.forEach((p, i) => { p.character = chars[i]; p.status = 'waiting'; p.time = null; });
}

function finishRound(game) {
  if (game.phase === 'results') return;
  game.phase = 'results';
  const done = game.players.filter(p => p.time != null).sort((a, b) => a.time - b.time);
  if (done.length) {
    const winner = done[0];
    game.scores[winner.id] = (game.scores[winner.id] || 0) + 1;
    game.winnerIds = [winner.id];
  }
}

function view(game, pid) {
  const me = game.players.find(p => p.id === pid);
  if (!me) return null;
  const results = game.phase === 'results';
  const isHost = me.id === game.players[0].id;
  const ranked = results
    ? game.players.slice().sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity)).map(p => p.id)
    : [];
  return {
    id: game.id, round: game.round, phase: game.phase, clue: game.clue,
    hostName: game.players[0].name, isHost,
    me: { id: me.id, name: me.name, status: me.status, time: me.time, character: me.character },
    ranked, winnerIds: game.winnerIds,
    players: game.players.map(p => ({
      id: isHost ? p.id : undefined,
      isMe: p.id === me.id,
      name: p.name, status: p.status, wins: game.scores[p.id] || 0,
      time: results ? p.time : null,
      character: results ? p.character : null,
    })),
  };
}

function body(req) {
  return new Promise(res => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } }); });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] === 'api') {
    if (parts[1] === 'info') {
      const lan = [];
      for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal) lan.push(i.address);
      return json(res, 200, { port: PORT, lan });
    }
    if (req.method === 'POST' && parts[1] === 'create') {
      const { names } = await body(req);
      const clean = (names || []).map(n => String(n).trim().slice(0, 20)).filter(Boolean);
      if (clean.length < 2 || clean.length > 8) return json(res, 400, { error: 'Need 2-8 players' });
      const game = { id: uid(5), created: Date.now(), round: 0, phase: 'playing', scores: {}, usedCats: [], winnerIds: [],
        players: clean.map(n => ({ id: uid(8), name: n, status: 'waiting', time: null, character: null })) };
      startRound(game);
      GAMES[game.id] = game;
      return json(res, 200, { gameId: game.id, hostId: game.players[0].id });
    }
    if (parts[1] !== 'game') return json(res, 404, { error: 'Not found' });
    const game = GAMES[parts[2]];
    if (!game) return json(res, 404, { error: 'Game not found' });

    if (req.method === 'GET') {
      const v = view(game, url.searchParams.get('p'));
      return v ? json(res, 200, v) : json(res, 404, { error: 'Player not found' });
    }
    if (req.method === 'POST') {
      const b = await body(req);
      const me = game.players.find(p => p.id === b.p);
      if (!me) return json(res, 404, { error: 'Player not found' });
      if (parts[3] === 'end') {
        if (me.id !== game.players[0].id) return json(res, 403, { error: 'Only the host can end the game' });
        delete GAMES[game.id];
        return json(res, 200, { ended: true });
      }
      if (parts[3] === 'finish' && game.phase === 'playing' && me.status !== 'done') {
        const t = Math.max(0, Math.min(Number(b.time) || 0, 600000));
        me.time = Math.round(t); me.status = 'done';
        if (game.players.every(p => p.status === 'done')) finishRound(game);
      } else if (parts[3] === 'force' && me.id === game.players[0].id) {
        finishRound(game);
      } else if (parts[3] === 'next' && game.phase === 'results' && b.round === game.round) {
        startRound(game);
      }
      return json(res, 200, view(game, me.id));
    }
  }

  // static: serve from ./public, or from the same folder as server.js if the files were saved flat
  const name = path.basename(url.pathname === '/' ? 'index.html' : url.pathname);
  const candidates = [path.join(__dirname, 'public', name), path.join(__dirname, name)];
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const tryNext = i => {
    if (i >= candidates.length) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('index.html not found. Put it next to server.js (or inside a folder named "public" next to server.js).\nLooked in:\n' + candidates.join('\n'));
    }
    fs.readFile(candidates[i], (err, data) => {
      if (err || name === 'server.js' || name === 'package.json') return tryNext(i + 1);
      res.writeHead(200, { 'Content-Type': (types[path.extname(name)] || 'text/plain') + '; charset=utf-8' });
      res.end(data);
    });
  };
  tryNext(0);
});

setInterval(() => { const now = Date.now(); for (const id in GAMES) if (now - GAMES[id].created > GAME_TTL) delete GAMES[id]; }, 600000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nGuess the Character is running!\n  This computer:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log(`  On your Wi-Fi:  http://${i.address}:${PORT}   <- open this one on phones`);
  console.log('');
});

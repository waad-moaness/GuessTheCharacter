// Builds data/characters.json from (1) Wikidata occupation categories and (2) YOUR hand-made list in my-categories.json.
// Every entry is a real person/character together with THEIR OWN official photo (Wikidata property P18),
// so a photo can never belong to the wrong character. Run:  node build-database.js            (both)
//       node build-database.js --mine     (only my-categories.json, fast)
// Requires Node 18+ (built-in fetch). Re-run any time to refresh or after editing the categories below.
const fs = require('fs');
const path = require('path');

// Each category: the clue players see, a Wikidata filter, and a minimum "fame" score (number of Wikipedia languages).
// Higher min = more famous people only. Lower it if a category comes back with too few entries.
const CATEGORIES = [
  { clue: 'They kick a ball for a living',        where: '?item wdt:P106 wd:Q937857.', min: 70 },
  { clue: 'You have seen them on the big screen', where: '?item wdt:P106 wd:Q33999.',  min: 130 },
  { clue: 'They sing for a living',               where: '?item wdt:P106 wd:Q177220.', min: 110 },
  { clue: 'They changed science forever',         where: '?item wdt:P106 wd:Q901.',    min: 90 },
  { clue: 'They are Egyptian screen stars',       where: '?item wdt:P27 wd:Q79; wdt:P106 wd:Q33999.', min: 15 },
  { clue: 'They are Egyptian footballers',        where: '?item wdt:P27 wd:Q79; wdt:P106 wd:Q937857.', min: 12 },
  { clue: 'They are Egyptian singers',            where: '?item wdt:P27 wd:Q79; wdt:P106 wd:Q177220.', min: 12 },
  { clue: 'They dribble and dunk',                where: '?item wdt:P106 wd:Q3665646.', min: 45 },
  { clue: 'They hold a tennis racket',            where: '?item wdt:P106 wd:Q10833314.', min: 45 },
  { clue: 'They wrote music that lasts',          where: '?item wdt:P106 wd:Q36834.',  min: 70 },
  { clue: 'They hold a paintbrush',               where: '?item wdt:P106 wd:Q1028181.', min: 90 },
  { clue: 'They write stories',                   where: '?item wdt:P106 wd:Q36180.',  min: 110 },
  { clue: 'They make people laugh',               where: '?item wdt:P106 wd:Q2259451.', min: 35 },
  { clue: 'They call the shots behind the camera', where: '?item wdt:P106 wd:Q2526255.', min: 90 },
  { clue: 'Capes, masks and secret identities',   where: '?item wdt:P31 wd:Q188784.',  min: 15, fictional: true },
  { clue: 'You know them from TV shows',          where: '?item wdt:P31 wd:Q15773317.', min: 15, fictional: true },
  { clue: 'You know them from video games',       where: '?item wdt:P31 wd:Q1569167.', min: 15, fictional: true },
];
const PER_CATEGORY = 80;     // max entries kept per category
const MIN_ENTRIES = 12;      // categories with fewer valid entries are dropped

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sparql(where, min) {
  const q = `SELECT ?item ?itemLabel ?img ?links WHERE {
    ${where}
    ?item wdt:P18 ?img; wikibase:sitelinks ?links.
    FILTER(?links >= ${min})
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  } ORDER BY DESC(?links) LIMIT ${PER_CATEGORY * 2}`;
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'GuessTheCharacterGame/1.0 (personal party game)', Accept: 'application/sparql-results+json' }, signal: AbortSignal.timeout(70000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).results.bindings;
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(3000 * attempt);
    }
  }
}


// ---------- Part 2: hand-made categories (my-categories.json) ----------
// Each name is a Wikipedia page title. The photo is that page's own lead image, so it matches the character.
const WIKI = 'https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages|pageprops&ppprop=disambiguation&piprop=thumbnail&pithumbsize=700&';
const UA = { 'User-Agent': 'GuessTheCharacterGame/1.0 (personal party game)' };
const clean = n => n.replace(/\s*\(.*\)$/, '');
const words = n => clean(n).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 2);
const usable = p => p && p.thumbnail && !(p.pageprops && 'disambiguation' in p.pageprops);

async function wikiGet(params) {
  const r = await fetch(WIKI + params, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return (await r.json()).query || {};
}

// ---- Your own photos: put files in public/images named after the character, e.g. homer-simpson.jpg ----
const slug = n => clean(n).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const IMG_DIR = path.join(__dirname, 'public', 'images');
function localPhotos() {
  const map = {};
  try { for (const f of fs.readdirSync(IMG_DIR)) { const m = f.match(/^(.+)\.(jpe?g|png|webp)$/i); if (m) map[m[1].toLowerCase()] = f; } } catch (e) {}
  return map;
}

async function apiGet(qs) {
  const r = await fetch('https://en.wikipedia.org/w/api.php?format=json&' + qs, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Step A: free-licence lead images (works for real people) + which pages exist at all
async function resolveBatch(titles) {
  const found = {}, known = {};
  for (let i = 0; i < titles.length; i += 40) {
    const chunk = titles.slice(i, i + 40);
    const q = await wikiGet('titles=' + encodeURIComponent(chunk.join('|')));
    const alias = {};
    for (const t of chunk) alias[t] = t;
    for (const m of [...(q.normalized || []), ...(q.redirects || [])])
      for (const t in alias) if (alias[t] === m.from) alias[t] = m.to;
    const byTitle = {};
    for (const p of Object.values(q.pages || {})) byTitle[p.title] = p;
    for (const t of chunk) {
      const p = byTitle[alias[t]];
      if (usable(p)) found[t] = { title: p.title, image: p.thumbnail.source };
      else if (p && !('missing' in p) && !(p.pageprops && 'disambiguation' in p.pageprops)) known[t] = p.title;   // page exists, no free image
    }
    await sleep(300);
  }
  return { found, known };
}

// Step B: for pages with no free image (fictional characters), take the first real picture on the page = the infobox image
const JUNK = /(icon|logo|symbol|ambox|question|commons|wiki|flag|edit|disambig|portal|stub|padlock|crystal|folder|text_document|increase|decrease|steady|arrow|star_full|star_empty|blue_pencil|nuvola|oojs)/i;
async function infoboxImage(page) {
  try {
    const d = await apiGet('action=parse&redirects=1&prop=images&page=' + encodeURIComponent(page));
    const cand = ((d.parse && d.parse.images) || []).filter(f => /\.(jpe?g|png|webp)$/i.test(f) && !JUNK.test(f)).slice(0, 4);
    if (!cand.length) return null;
    const q = (await apiGet('action=query&prop=imageinfo&iiprop=url|size&iiurlwidth=700&titles=' + encodeURIComponent(cand.map(f => 'File:' + f).join('|')))).query || {};
    const byTitle = {};
    for (const p of Object.values(q.pages || {})) byTitle[p.title] = p;
    for (const f of cand) {
      const p = byTitle['File:' + f.replace(/_/g, ' ')], ii = p && p.imageinfo && p.imageinfo[0];
      if (ii && ii.width >= 150 && ii.height >= 150 && (ii.thumburl || ii.url)) return ii.thumburl || ii.url;
    }
  } catch (e) {}
  return null;
}

// Step C: if the exact title doesn't exist, search; accept only a result whose title shares a word with the name
async function searchTitle(name) {
  try {
    const d = await apiGet('action=query&list=search&srlimit=5&srsearch=' + encodeURIComponent(name));
    const ws = words(name);
    const hit = ((d.query && d.query.search) || []).find(r => ws.some(w => r.title.toLowerCase().includes(w)));
    return hit ? hit.title : null;
  } catch (e) { return null; }
}

async function buildMine() {
  const file = path.join(__dirname, 'my-categories.json');
  if (!fs.existsSync(file)) return [];
  const mine = JSON.parse(fs.readFileSync(file, 'utf8'));
  const local = localPhotos();
  const hasOwn = n => typeof n === 'object' ? !!n.image : !!local[slug(n)];
  const nameOf = n => typeof n === 'object' ? n.name : n;
  const all = [...new Set(mine.flatMap(c => c.items).filter(n => !hasOwn(n)).map(nameOf))];
  console.log(`\nYour own photos found: ${Object.keys(local).length}. Checking ${all.length} other names on Wikipedia...`);
  const { found, known } = all.length ? await resolveBatch(all) : { found: {}, known: {} };
  const cache = {};
  const lookup = async name => {
    if (name in cache) return cache[name];
    let hit = found[name] || null;
    if (!hit) {
      const page = known[name] || await searchTitle(name);
      if (page) { const image = await infoboxImage(page); if (image) hit = { title: page, image }; await sleep(150); }
    }
    return (cache[name] = hit);
  };
  const result = [];
  for (const cat of mine) {
    const items = [], dropped = [];
    for (const entry of cat.items) {
      const name = nameOf(entry);
      let hit;
      if (typeof entry === 'object' && entry.image) hit = { title: '(your photo)', image: entry.image };
      else if (local[slug(name)]) hit = { title: '(your photo)', image: '/images/' + local[slug(name)] };
      else hit = await lookup(name);
      if (hit) items.push({ name: clean(name), image: hit.image, page: hit.title }); else dropped.push(`${name} -> save a photo as ${slug(name)}.jpg`);
    }
    console.log(`${cat.clue}: ${items.length}/${cat.items.length} ok${dropped.length ? '   (missing: ' + dropped.join(' | ') + ')' : ''}`);
    if (items.length >= 6) result.push({ clue: cat.clue, items });
    else console.log('   -> category skipped (fewer than 6 usable entries)');
  }
  return result;
}

// ---------- Review page: look at every photo before playing ----------
function writeReview(cats) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review photos</title>
<style>body{font:14px system-ui;margin:16px;background:#f4f4f4}h2{margin:28px 0 8px}.g{display:flex;flex-wrap:wrap;gap:10px}
figure{margin:0;width:120px;background:#fff;border-radius:8px;padding:6px;text-align:center}img{width:100%;height:130px;object-fit:cover;border-radius:6px;background:#ddd}figcaption{font-size:12px;margin-top:4px}small{color:#888}</style>
<h1>Photo review (${cats.length} categories)</h1><p>If a photo doesn't match its name, remove that name from my-categories.json and re-run the build.</p>` +
    cats.map(c => `<h2>${esc(c.clue)}</h2><div class="g">${c.items.map(i => `<figure><img loading="lazy" src="${esc(i.image)}"><figcaption>${esc(i.name)}${i.page && clean(i.page) !== i.name ? `<br><small>page: ${esc(i.page)}</small>` : ''}</figcaption></figure>`).join('')}</div>`).join('');
  fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'public', 'review.html'), html);
}

(async () => {
  const onlyMine = process.argv.includes('--mine');
  const out = { built: new Date().toISOString(), categories: [] };

  out.categories.push(...await buildMine());

  if (!onlyMine) {
    console.log('\nWikidata categories:');
    for (const cat of CATEGORIES) {
      process.stdout.write(`${cat.clue} ... `);
      try {
        const rows = await sparql(cat.where, cat.min);
        const seen = new Set(), items = [];
        for (const r of rows) {
          const name = r.itemLabel && r.itemLabel.value;
          if (!name || /^Q\d+$/.test(name) || seen.has(r.item.value) || seen.has(name)) continue;
          const img = r.img.value.replace(/^http:/, 'https:');
          if (!/\.(jpe?g|png|webp)$/i.test(img)) continue;
          seen.add(r.item.value); seen.add(name);
          items.push({ name, image: img + (img.includes('?') ? '&' : '?') + 'width=700' });
          if (items.length >= PER_CATEGORY) break;
        }
        if (items.length < MIN_ENTRIES) console.log(`only ${items.length} found, SKIPPED`);
        else { out.categories.push({ clue: cat.clue, items }); console.log(`${items.length} entries`); }
      } catch (e) { console.log('FAILED: ' + e.message); }
      await sleep(1500);
    }
  }

  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'characters.json'), JSON.stringify(out));
  writeReview(out.categories);
  const total = out.categories.reduce((n, c) => n + c.items.length, 0);
  console.log(`\nSaved ${out.categories.length} categories, ${total} characters -> data/characters.json`);
  console.log('Check the photos at  /review.html  (open it on your running game address).');
})();

# Guess the Character

## Run it
```
node server.js                 # http://localhost:3000
node build-database.js --mine  # (re)build data/characters.json with photos, then restart
node build-database.js --mine --no-wikipedia   # fast: GitHub datasets + your own photos only
node test/load-test.js 300 5   # functional checks + 1,500 simulated phones
```

## Where the photos come from (tried in this order)
1. Your own files in `public/images/` named like `homer-simpson.jpg`, or a link written in `my-categories.json`.
2. GitHub datasets: `akabab/superhero-api` (Marvel/DC and others), `PokeAPI/sprites` (all Pokemon), served by jsDelivr.
3. Wikipedia: free pictures for real people, the lead image of character pages for fiction.
4. `akabab/starwars-api` as a last resort.
Anything still missing can be added at `/admin.html#key=YOUR_KEY` (paste a link or upload a file). The key is printed when the server starts; set `ADMIN_KEY` to keep it fixed.
A category is playable once at least 5 of its characters have a photo. Open `/review.html` after a build to eyeball every photo.

## Deploy
The app is one Node process with no dependencies. Game state lives in memory and is saved to `DATA_DIR/games.json` every 15 s and on shutdown, so a restart does not kick players out.

* Environment: `NODE_ENV=production`, `ADMIN_KEY=<long random string>`, optional `PORT`, `DATA_DIR`, `TRUST_PROXY=0` (only if the app is exposed directly, not behind a host's proxy).
* Render / Railway: new Web Service from the repo, start command `node server.js`, health check path `/healthz`.
* Docker: `docker build -t gtc . && docker run -p 3000:3000 -e ADMIN_KEY=secret gtc`.
* Commit `data/characters.json` (and any `public/images/`) before deploying, so the server starts with the photos already linked.
* Run exactly ONE instance. Games are held in that process's memory, so two instances would not see each other's games.
* Free hosting tiers sleep when idle and wipe their disk; use a paid instance (or a volume for `DATA_DIR` and `public/images`) for a game people rely on.

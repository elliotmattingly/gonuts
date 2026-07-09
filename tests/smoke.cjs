// Go Nuts! smoke suite — deliberately CommonJS (DESIGN.md §10).
// ESM `import` ignores NODE_PATH; CJS `require()` honors it, so one file works in both worlds.
//
// Local run:
//   NODE_PATH=/tmp/claude-0/-home-user-gonuts/d0bfbb1e-ed5b-5bd2-9f82-728d039a3aae/scratchpad/node_modules \
//   PW_MODULE=playwright-core \
//   CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//   node tests/smoke.cjs
//
// CI run: cd tests && npm ci && npx playwright install --with-deps chromium && npm test
//
// Rules (DESIGN.md §10): scenarios run sequentially with node:assert — no test-runner
// dependency. Every scenario attaches pageerror + console-error listeners; any event
// fails the scenario. Native confirm() (Reset) is auto-accepted. Forced clicks (the
// Playwright option that skips hit-testing) are BANNED here (CI grep-enforced) — the
// ?test=1 contract kills animations so normal, fully hit-tested clicks get stable boxes. The one sanctioned exception to real clicks: S3 dispatches its
// SECOND activation via page.evaluate(el.click()) to simulate keyboard key-repeat.

const pw = require(process.env.PW_MODULE || 'playwright');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const Q = '?test=1&t=2&fast=1&seed=42';     // the standard test contract (DESIGN.md §10)
const Q_SLOW_COUNTDOWN = '?test=1&t=2&seed=42';  // no &fast: 700ms steps, for mid-countdown clicks

// ---------- tiny static server over the repo root ----------
// (http origin needed for localStorage semantics; file:// stays a product feature, not a test path)
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json',
};
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }  // Chromium auto-request; a 404 here would trip the console-error listener
  const file = path.join(ROOT, path.normalize(pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- page helpers ----------
async function addPlayers(page, names) {
  for (const name of names) {
    await page.fill('#name-input', name);
    await page.click('#add-btn');
  }
}

async function startGame(page, names) {
  await addPlayers(page, names);
  await page.click('#start-btn');
  await page.waitForSelector('#intro-screen.active');
}

// Clicks I'M READY, waits out countdown + the 2s turn, then submits the scripted
// star ratings (one per rater, in rater-queue order).
async function playTurn(page, ratings) {
  await page.click('#begin-turn-btn');
  await page.waitForSelector('#rating-screen.active', { timeout: 15000 });
  for (const stars of ratings) {
    await page.click(`#stars .star:nth-child(${stars})`);
    await page.click('#submit-rating-btn');
  }
}

async function pollFor(predicate, timeoutMs) {   // console events arrive async — poll, don't assert instantly
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 50)); /* raw-timer-ok: node-side test harness */
  }
  return predicate();
}

const state = (page) => page.evaluate(() => window.__gonuts.machine.state);
const timerCount = (page) => page.evaluate(() => window.__gonuts.timers.count());
const text = async (page, sel) => (await page.textContent(sel)).trim();

// ---------- scenarios (DESIGN.md §10 table; phase-1 rows) ----------
const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// S1 — Happy path: 3 players → full game with scripted mixed ratings → winner.
scenario('S1 happy path: totals/avgs/ranking derived correctly', async ({ page, base }) => {
  const names = ['Alice', 'Bob', 'Cara'];
  const ratingsByTurn = [[3, 5], [2, 2], [5, 4]];   // performer order = join order in Phase 1
  await page.goto(base + Q);
  await startGame(page, names);
  for (const ratings of ratingsByTurn) await playTurn(page, ratings);
  await page.waitForSelector('#winner-screen.active');
  assert.strictEqual(await state(page), 'winner');

  // Recompute expectations here, independently of the page (scores are always derived).
  const rows = names.map((name, i) => {
    const r = ratingsByTurn[i];
    const total = r.reduce((a, b) => a + b, 0);
    return { name, total, avg: total / r.length };
  }).sort((a, b) => b.total - a.total);
  const max = rows[0].total;
  const winners = rows.filter(r => r.total === max);
  assert.strictEqual(winners.length, 1, 'S1 script must produce a unique winner');

  assert.strictEqual(await text(page, '#winner-name'), winners[0].name);
  assert.strictEqual(await text(page, '#winner-subtitle'), 'CRAZIEST OF THEM ALL');
  assert.strictEqual(await text(page, '#winner-score'), `${winners[0].total} ⭐ (avg ${winners[0].avg.toFixed(1)})`);
  const lis = await page.$$eval('#final-scores li', els => els.map(el => el.textContent.trim()));
  assert.deepStrictEqual(lis, rows.map(r => `${r.name} — ${r.total} ⭐ (avg ${r.avg.toFixed(1)})`));
});

// S2 — R1 regression: Reset during the 3-2-1 countdown (confirm auto-accepted) must
// land on setup with zero live timers; the dead countdown chain must never fire.
scenario('S2 reset mid-countdown lands on setup, no zombie timers', async ({ page, base }) => {
  await page.goto(base + Q_SLOW_COUNTDOWN);       // 700ms steps: plenty of time to click Reset mid-chain
  await startGame(page, ['Ann', 'Ben']);
  await page.click('#begin-turn-btn');
  await page.waitForSelector('#countdown-screen.active');
  await page.click('#reset-btn');                 // confirm() auto-accepted by the dialog handler
  assert.strictEqual(await state(page), 'setup');
  assert.strictEqual(await timerCount(page), 0);
  await page.waitForTimeout(3000);                // the old chain would have fired by now — errors fail the scenario
  assert.strictEqual(await state(page), 'setup');
  await startGame(page, ['Ann', 'Ben']);          // a new game starts cleanly after the reset
  assert.strictEqual(await state(page), 'intro');
});

// S3 — R2 regression: double-fired begin-turn. The second activation is deliberately
// JS-dispatched (simulating keyboard key-repeat); the machine must reject it, the turn
// must run at 1x speed, and performing must own exactly its two intervals.
scenario('S3 double begin-turn is blocked; timer runs at 1x', async ({ page, base, warnings }) => {
  await page.goto(base + Q_SLOW_COUNTDOWN);       // slow countdown so the 2nd click lands mid-countdown
  await startGame(page, ['Ann', 'Ben']);
  await page.click('#begin-turn-btn');
  await page.evaluate(() => document.getElementById('begin-turn-btn').click());  // sanctioned JS 2nd fire
  const sawBlock = await pollFor(() => warnings.some(w => w.includes('[fsm] blocked')), 3000);
  assert.ok(sawBlock, 'second transition must be rejected (no "[fsm] blocked" warning seen)');
  await page.waitForSelector('#timer-screen.active', { timeout: 5000 });
  assert.strictEqual(await timerCount(page), 2, 'performing owns exactly 2 intervals (repaint + word)');
  await page.waitForTimeout(1000);                // t=2 → after 1s the ring must show ~1s left, not 0
  assert.strictEqual(await state(page), 'performing');
  const ring = parseInt(await text(page, '#ring-num'), 10);
  assert.ok(ring === 1 || ring === 2, `ring shows ${ring}, expected ~1s left (a doubled timer would show 0)`);
  assert.strictEqual(await timerCount(page), 2, 'no leaked interval after the double fire');
});

// S4 — Wall-clock: with t=2 the GO → rating transition happens in 2s ± 400ms.
scenario('S4 wall-clock turn length is honest', async ({ page, base }) => {
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben']);
  await page.click('#begin-turn-btn');
  await page.waitForSelector('#timer-screen.active');
  const t0 = Date.now();
  await page.waitForSelector('#rating-screen.active', { timeout: 5000 });
  const dt = Date.now() - t0;
  assert.ok(Math.abs(dt - 2000) <= 400, `turn ran ${dt}ms, expected 2000 ± 400`);
});

// S5 — Resume: reload mid-rating → banner; Resume restores players/turn/ratings
// (rewound per DESIGN.md §4 — rating resumes as rating in Phase 1); Discard keeps roster.
scenario('S5 reload mid-rating: resume restores, discard keeps roster', async ({ page, base }) => {
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben']);
  await playTurn(page, [4]);                      // Ann performs, Ben rates 4
  await page.waitForSelector('#intro-screen.active');
  await page.click('#begin-turn-btn');            // Ben's turn
  await page.waitForSelector('#rating-screen.active', { timeout: 15000 });

  await page.reload();
  await page.waitForSelector('#setup-screen.active');
  const banner = await page.waitForSelector('#resume-banner:not([hidden])');
  const msg = (await banner.textContent()).trim();
  assert.ok(msg.includes('2 players') && msg.includes('Ben up next'), `unexpected banner: ${msg}`);

  await page.click('#resume-btn');
  await page.waitForSelector('#rating-screen.active');
  assert.strictEqual(await state(page), 'rating');
  assert.strictEqual(await text(page, '#rate-name'), 'Ben');
  assert.ok((await text(page, '#rater-label')).includes('Ann'), 'Ann rates Ben after resume');
  const g = await page.evaluate(() => window.__gonuts.getGame());
  assert.strictEqual(g.turns.length, 2, 'both turn entries survived the reload');
  assert.deepStrictEqual(g.turns[0].ratings, { p2: 4 }, "Ann's recorded rating survived the reload");

  await page.reload();                            // now exercise the Discard path
  await page.waitForSelector('#resume-banner:not([hidden])');
  await page.click('#discard-btn');
  assert.strictEqual(await page.$('#resume-banner:not([hidden])'), null, 'banner gone after discard');
  assert.strictEqual(await state(page), 'setup');
  assert.strictEqual(await page.evaluate(() => window.__gonuts.getGame()), null);
  const roster = await page.$$eval('#player-list li span', els => els.map(el => el.textContent));
  assert.deepStrictEqual(roster, ['Ann', 'Ben'], 'discard keeps the roster');
});

// S6 — Tie (Phase 1 form): a symmetric 2-player game renders co-winners, never sorted[0].
scenario('S6 tie renders co-winners', async ({ page, base }) => {
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben']);
  await playTurn(page, [3]);                      // Ben gives Ann 3
  await page.waitForSelector('#intro-screen.active');
  await playTurn(page, [3]);                      // Ann gives Ben 3 — dead tie
  await page.waitForSelector('#winner-screen.active');
  assert.strictEqual(await text(page, '#winner-subtitle'), 'CO-CRAZIEST OF THEM ALL');
  assert.strictEqual(await text(page, '#winner-name'), 'Ann & Ben');
});

// S7 — Duplicate/empty name feedback: visible message, roster unchanged.
scenario('S7 duplicate/empty name gives feedback', async ({ page, base }) => {
  await page.goto(base + Q);
  await addPlayers(page, ['Sam']);
  await addPlayers(page, ['sam']);                // case-insensitive duplicate
  assert.strictEqual(await text(page, '#name-error'), 'Sam is already playing!');
  assert.strictEqual(await page.$$eval('#player-list li', els => els.length), 1);
  await page.fill('#name-input', '   ');          // whitespace-only
  await page.click('#add-btn');
  assert.strictEqual(await text(page, '#name-error'), 'Type a name first!');
  assert.strictEqual(await page.$$eval('#player-list li', els => els.length), 1);
});

// S9 — Illegal-transition fuzz: every from→to edge NOT in the state table must be a
// guarded no-op (returns false, state unchanged).
scenario('S9 illegal transitions are all blocked', async ({ page, base }) => {
  // Mirror of the Phase 1 STATES table (DESIGN.md §2). A drift between this copy and
  // the page's table surfaces as a fuzz failure — that is intentional.
  const TABLE = {
    setup:      ['intro'],
    intro:      ['countdown', 'setup'],
    countdown:  ['performing', 'setup'],
    performing: ['rating', 'setup'],
    rating:     ['rating', 'intro', 'winner', 'setup'],
    winner:     ['intro', 'setup'],
  };
  await page.goto(base + Q);
  const failures = await page.evaluate((table) => {
    const g = window.__gonuts;
    const out = [];
    const orig = g.machine.state;
    for (const from of Object.keys(table)) {
      for (const to of Object.keys(table)) {
        if (table[from].includes(to)) continue;
        g.machine.state = from;                  // place the machine, then poke the illegal edge
        const r = g.transition(to);
        if (r !== false) out.push(`${from}->${to} returned ${r}`);
        if (g.machine.state !== from) out.push(`${from}->${to} moved state to ${g.machine.state}`);
      }
    }
    g.machine.state = orig;
    return out;
  }, TABLE);
  assert.deepStrictEqual(failures, []);
});

// S10 — Structural lint (no browser): index.html markup has no duplicate DOM ids.
scenario('S10 no duplicate DOM ids in index.html', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const seen = new Set();
  const dupes = ids.filter(id => seen.has(id) ? true : (seen.add(id), false));
  assert.deepStrictEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

// ---------- runner ----------
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  let failed = 0;

  for (const [name, fn] of scenarios) {
    const context = await browser.newContext();   // fresh context per scenario → isolated localStorage
    const page = await context.newPage();
    const errors = [];
    const warnings = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
      if (m.type() === 'warning') warnings.push(m.text());
    });
    page.on('dialog', d => d.accept());           // native confirm() (Reset)
    try {
      await fn({ page, base, errors, warnings });
      assert.deepStrictEqual(errors, [], `page errors during scenario:\n${errors.join('\n')}`);
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${name}`);
      console.error(err && err.stack || err);
      if (errors.length) console.error(`      page errors:\n${errors.map(e => `      ${e}`).join('\n')}`);
    }
    await context.close();
  }

  await browser.close();
  server.close();
  console.log(failed ? `\n${failed} scenario(s) FAILED` : `\nAll ${scenarios.length} scenarios passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

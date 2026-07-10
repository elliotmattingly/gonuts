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
// star ratings (one per rater, in rater-queue order). From Phase 3.4 every rating
// sits behind the pass-the-phone interstitial, so each rater clicks through it.
async function playTurn(page, ratings) {
  await page.click('#begin-turn-btn');
  for (const stars of ratings) {
    await page.waitForSelector('#pass-screen.active', { timeout: 15000 });
    await page.click('#pass-rate-btn');
    await page.waitForSelector('#rating-screen.active');
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
  const ratingsByTurn = [[3, 5], [2, 2], [5, 4]];   // scripted per TURN — the performer order is shuffled from Phase 3
  await page.goto(base + Q);
  await startGame(page, names);
  // Phase 3.2: read the seeded Fisher-Yates order off the page and pair each turn's
  // scripted ratings with its ACTUAL performer (expectations stay independently derived).
  const orderedNames = await page.evaluate(() => {
    const g = window.__gonuts.getGame();
    return g.order.map(id => g.players.find(p => p.id === id).name);
  });
  assert.deepStrictEqual([...orderedNames].sort(), [...names].sort(), 'order is a permutation of the roster');
  for (const ratings of ratingsByTurn) await playTurn(page, ratings);
  await page.waitForSelector('#winner-screen.active');
  assert.strictEqual(await state(page), 'winner');

  // Recompute expectations here, independently of the page (scores are always derived).
  const rows = orderedNames.map((name, i) => {
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

  // Phase 3.6: with 3 players the superlative pills render under the final scoreboard
  // (S1's script always produces all three: a unique best turn, at least one 5⭐, raters).
  assert.ok(await page.$eval('#superlatives', el => !el.hidden), 'superlatives visible with 3 players');
  const sups = await page.$$eval('#superlatives .sup-row', els => els.map(el => el.textContent.trim()));
  assert.strictEqual(sups.length, 3, `expected 3 superlative rows, got ${sups.length}: ${JSON.stringify(sups)}`);
  const bestIdx = ratingsByTurn.findIndex(r => r.reduce((a, b) => a + b, 0) === 9);   // 9⭐ is S1's best single turn
  const bananas = sups.find(s => s.includes('Most Bananas Moment'));
  assert.ok(bananas && bananas.includes(orderedNames[bestIdx]) && bananas.includes('9 ⭐'),
    `bananas award names the 9⭐ performer with the haul (got "${bananas}")`);
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

// S4 — Wall-clock: with t=2 the GO → pass transition (the turn's end, Phase 3.4)
// happens in 2s ± 400ms.
scenario('S4 wall-clock turn length is honest', async ({ page, base }) => {
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben']);
  await page.click('#begin-turn-btn');
  await page.waitForSelector('#timer-screen.active');
  const t0 = Date.now();
  await page.waitForSelector('#pass-screen.active', { timeout: 5000 });
  const dt = Date.now() - t0;
  assert.ok(Math.abs(dt - 2000) <= 400, `turn ran ${dt}ms, expected 2000 ± 400`);
});

// S5 — Resume: reload mid-rating → banner; Resume restores players/turn/ratings
// (rewound per DESIGN.md §4 — from Phase 3.4 a mid-rating reload rewinds to 'pass',
// so the current rater re-enters via the interstitial); Discard keeps roster.
scenario('S5 reload mid-rating: resume rewinds to pass, discard keeps roster', async ({ page, base }) => {
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben']);
  // Phase 3.2: performer order is shuffled — resolve who actually goes first/second.
  const order = await page.evaluate(() => {
    const g = window.__gonuts.getGame();
    return g.order.map(id => ({ id, name: g.players.find(p => p.id === id).name }));
  });
  const [first, second] = order;
  await playTurn(page, [4]);                      // first performs, second rates 4
  await page.waitForSelector('#intro-screen.active');
  await page.click('#begin-turn-btn');            // second player's turn
  await page.waitForSelector('#pass-screen.active', { timeout: 15000 });
  await page.click('#pass-rate-btn');             // first is mid-rating when the reload hits
  await page.waitForSelector('#rating-screen.active');

  await page.reload();
  await page.waitForSelector('#setup-screen.active');
  const banner = await page.waitForSelector('#resume-banner:not([hidden])');
  const msg = (await banner.textContent()).trim();
  assert.ok(msg.includes('2 players') && msg.includes(`${second.name} up next`), `unexpected banner: ${msg}`);

  await page.click('#resume-btn');
  await page.waitForSelector('#pass-screen.active');   // rating rewinds to the interstitial (DESIGN.md §4)
  assert.strictEqual(await state(page), 'pass');
  assert.strictEqual(await text(page, '#pass-name'), first.name, 'the interrupted rater is re-summoned');
  await page.click('#pass-rate-btn');
  await page.waitForSelector('#rating-screen.active');
  assert.strictEqual(await state(page), 'rating');
  assert.strictEqual(await text(page, '#rate-name'), second.name);
  assert.ok((await text(page, '#rater-label')).includes(first.name), `${first.name} rates ${second.name} after resume`);
  const g = await page.evaluate(() => window.__gonuts.getGame());
  assert.strictEqual(g.turns.length, 2, 'both turn entries survived the reload');
  assert.deepStrictEqual(g.turns[0].ratings, { [second.id]: 4 }, 'the recorded rating survived the reload');
  // Phase 3.1: the persisted prompt — every logged turn carries the promptIdx it drew.
  assert.ok(g.turns.every(t => typeof t.promptIdx === 'number'),
    `turn entries record promptIdx (got ${JSON.stringify(g.turns.map(t => t.promptIdx))})`);
  assert.notStrictEqual(g.turns[0].promptIdx, g.turns[1].promptIdx, 'the two turns drew different prompts');

  await page.reload();                            // now exercise the Discard path
  await page.waitForSelector('#resume-banner:not([hidden])');
  await page.click('#discard-btn');
  assert.strictEqual(await page.$('#resume-banner:not([hidden])'), null, 'banner gone after discard');
  assert.strictEqual(await state(page), 'setup');
  assert.strictEqual(await page.evaluate(() => window.__gonuts.getGame()), null);
  const roster = await page.$$eval('#player-list li span', els => els.map(el => el.textContent));
  assert.deepStrictEqual(roster, ['Ann', 'Ben'], 'discard keeps the roster');
});

// S6 — Ties (Phase 3 form): a PARTIAL top tie goes to sudden death — the nutoff screen
// announces the contenders, the shorter NUT-OFF turns are rated by non-contenders only,
// and the nutoffOnly totals crown a unique winner (Part A) — or, still tied, BOTH
// contenders as co-winners (Part A2, the sorted[0] bug class hard invariant 4 bans).
// An ALL-player tie (here: 2 players) has no neutral raters, so it still renders the
// Phase 1 co-winner form (Part B). Also under S6: the crew-title callout (first title
// silent, second title announced), the HOF list/clear paths, and — on a plain (no ?test)
// load, where TEST_TURN can't mask it — the shorter NUTOFF_SECONDS turn length.
scenario('S6 partial tie → NUT-OFF resolves one winner; 2-player tie → co-winners', async ({ page, base }) => {
  // ---- Part A: 3 players, two tied at the top → NUT-OFF ----
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben', 'Cai']);
  const orderedNames = await page.evaluate(() => {
    const g = window.__gonuts.getGame();
    return g.order.map(id => g.players.find(p => p.id === id).name);
  });
  // By seeded turn position: performers 1+2 total 5 each; performer 3 totals 2.
  for (const ratings of [[3, 2], [4, 1], [1, 1]]) await playTurn(page, ratings);

  await page.waitForSelector('#nutoff-screen.active');
  assert.strictEqual(await state(page), 'nutoff');
  assert.ok((await text(page, '#nutoff-title')).includes("IT'S A NUT-OFF!"));
  const contenders = orderedNames.slice(0, 2), neutral = orderedNames[2];
  const namesLine = await text(page, '#nutoff-names');
  assert.ok(contenders.every(n => namesLine.includes(n)), `contenders on screen (got "${namesLine}")`);
  assert.ok(!namesLine.includes(neutral), 'the non-contender never appears on the nutoff screen');
  const tb = await page.evaluate(() => window.__gonuts.getGame().tiebreak);
  assert.strictEqual(tb.turnIdx, 0, 'tiebreak armed at its first turn');
  assert.deepStrictEqual([...tb.order].sort(), [...tb.contenders].sort(), 'tiebreak order is a shuffle of the contenders');

  await page.click('#nutoff-btn');
  await page.waitForSelector('#intro-screen.active');
  assert.ok(await page.$eval('#intro-nutoff', el => !el.hidden), 'intro shows the NUT-OFF banner during the tiebreak');
  const nutoffNames = await page.evaluate(() => {
    const g = window.__gonuts.getGame();
    return g.tiebreak.order.map(id => g.players.find(p => p.id === id).name);
  });
  // Sudden-death turns: only the neutral player rates (1 rater each). 5 then 3 → unique winner.
  await playTurn(page, [5]);
  await page.waitForSelector('#intro-screen.active');
  await playTurn(page, [3]);

  await page.waitForSelector('#winner-screen.active');
  assert.strictEqual(await text(page, '#winner-subtitle'), 'CRAZIEST OF THEM ALL');
  assert.strictEqual(await text(page, '#winner-name'), nutoffNames[0], 'the nutoffOnly totals crown the 5⭐ contender');
  assert.strictEqual(await text(page, '#winner-score'), '5 ⭐ (avg 2.5)',
    'the crown shows the honest MAIN total — nutoff stars never pollute the championship totals');
  const gA = await page.evaluate(() => window.__gonuts.getGame());
  const nutoffTurns = gA.turns.filter(t => t.nutoff);
  assert.strictEqual(nutoffTurns.length, 2, 'both sudden-death turns logged nutoff:true');
  assert.ok(nutoffTurns.every(t => Object.keys(t.ratings).length === 1),
    'nutoff turns are rated by the single non-contender only');
  // Hall of Fame (3.7): exactly one entry, flagged hadNutoff, naming the resolved winner.
  let hof = await page.evaluate(() => JSON.parse(localStorage.getItem('gonuts.hof')));
  assert.strictEqual(hof.entries.length, 1);
  assert.deepStrictEqual(hof.entries[0].winners, [nutoffNames[0]]);
  assert.strictEqual(hof.entries[0].hadNutoff, true);
  assert.strictEqual(hof.entries[0].stars, 5);

  // Refresh on the winner screen: hofRecorded must block a double append, and the
  // resumed screen must re-resolve the same nutoff winner.
  await page.reload();
  await page.waitForSelector('#resume-banner:not([hidden])');
  await page.click('#resume-btn');
  await page.waitForSelector('#winner-screen.active');
  assert.strictEqual(await text(page, '#winner-name'), nutoffNames[0], 'resume re-resolves the same nutoff winner');
  hof = await page.evaluate(() => JSON.parse(localStorage.getItem('gonuts.hof')));
  assert.strictEqual(hof.entries.length, 1, 'a winner-screen refresh never double-writes the HOF');

  // ---- Part A2: a STILL-TIED nut-off resolves to CO-winners (never sorted[0]) ----
  // Same seeded 5/5/2 setup as Part A, but the single neutral rater scores both
  // sudden-death turns equally — the nutoffOnly totals stay tied, and getResults must
  // keep BOTH contenders (hard invariant 4: an arbitrary contenders[0] crown is banned).
  await page.evaluate(() => localStorage.clear());
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben', 'Cai']);
  for (const ratings of [[3, 2], [4, 1], [1, 1]]) await playTurn(page, ratings);
  await page.waitForSelector('#nutoff-screen.active');
  const stillTied = await page.evaluate(() => {
    const g = window.__gonuts.getGame();
    return g.tiebreak.contenders.map(id => g.players.find(p => p.id === id).name);
  });
  await page.click('#nutoff-btn');
  await page.waitForSelector('#intro-screen.active');
  await playTurn(page, [4]);
  await page.waitForSelector('#intro-screen.active');
  await playTurn(page, [4]);                      // 4 vs 4 — the nut-off itself dead-ties
  await page.waitForSelector('#winner-screen.active');
  assert.strictEqual(await text(page, '#winner-subtitle'), 'CO-CRAZIEST OF THEM ALL',
    'a still-tied nut-off celebrates co-winners');
  const coName = await text(page, '#winner-name');
  assert.ok(stillTied.every(n => coName.includes(n)) && coName.includes(' & '),
    `both still-tied contenders share the crown (got "${coName}")`);
  const hofA2 = await page.evaluate(() => JSON.parse(localStorage.getItem('gonuts.hof')));
  assert.deepStrictEqual([...hofA2.entries[0].winners].sort(), [...stillTied].sort(),
    'both co-winners enter the HOF');
  assert.strictEqual(hofA2.entries[0].hadNutoff, true);

  // ---- Part B: a 2-player dead tie (ALL players tied → no neutral raters) ----
  // Deliberately KEEP Part A2's HOF entry (a DIFFERENT crew): the crew-title callout
  // below must count only entries whose crewKey matches — another crew's title on the
  // books must never light "2nd title" for a brand-new crew.
  await page.evaluate(() => localStorage.removeItem('gonuts.game'));
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben']);
  await playTurn(page, [3]);
  await page.waitForSelector('#intro-screen.active');
  await playTurn(page, [3]);                      // dead tie
  await page.waitForSelector('#winner-screen.active');
  assert.strictEqual(await text(page, '#winner-subtitle'), 'CO-CRAZIEST OF THEM ALL');
  assert.strictEqual(await text(page, '#winner-name'), 'Ann & Ben');
  assert.ok(await page.$eval('#superlatives', el => el.hidden), 'superlatives stay hidden below 3 players');
  const hofB = await page.evaluate(() => JSON.parse(localStorage.getItem('gonuts.hof')));
  assert.strictEqual(hofB.entries.length, 2, 'Part A2\'s different-crew entry is still on the books');
  assert.deepStrictEqual(hofB.entries[0].winners, ['Ann', 'Ben'], 'co-winners both enter the HOF');
  assert.strictEqual(hofB.entries[0].hadNutoff, false);
  // Crew callout (3.7): a FIRST title stays silent — and Part A2's other-crew entry
  // must not count toward this crew's streak (the count is crewKey-filtered).
  assert.ok(await page.$eval('#crew-line', el => el.hidden),
    'no crew callout on a first title, even with another crew in the HOF');

  // Reload on the winner screen: the banner must say the game FINISHED (no bogus
  // "in progress"/"? up next"), and Resume must re-show the winner screen.
  await page.reload();
  await page.waitForSelector('#setup-screen.active');
  const banner = await page.waitForSelector('#resume-banner:not([hidden])');
  const msg = (await banner.textContent()).trim();
  assert.ok(msg.includes('Finished game') && !msg.includes('?') && !msg.includes('in progress'),
    `unexpected finished-game banner: ${msg}`);
  await page.click('#resume-btn');
  await page.waitForSelector('#winner-screen.active');
  assert.strictEqual(await text(page, '#winner-name'), 'Ann & Ben');

  // ---- Crew callout, second title (3.7): Play Again, same crew ties again ----
  await page.click('#play-again-btn');
  await page.waitForSelector('#intro-screen.active');
  await playTurn(page, [3]);
  await page.waitForSelector('#intro-screen.active');
  await playTurn(page, [3]);                      // another dead tie — title #2 for Ann & Ben
  await page.waitForSelector('#winner-screen.active');
  assert.ok(await page.$eval('#crew-line', el => !el.hidden), 'the second title lights the crew callout');
  assert.strictEqual(await text(page, '#crew-line'), '👑 2nd title for this crew!',
    'the callout carries the crewKey-filtered count and its ordinal');

  // ---- Hall of Fame toggle on setup (3.7) + "clear history" in the settings sheet ----
  await page.click('#new-game-btn');
  await page.waitForSelector('#setup-screen.active');
  await page.click('#hof-btn');
  await page.waitForSelector('#hof-panel:not([hidden])');
  const hofRows = await page.$$eval('#hof-list li', els => els.map(el => el.textContent.trim()));
  assert.strictEqual(hofRows.length, 3, 'A2 + both Ann & Ben titles are listed');
  assert.ok(hofRows[0].includes('Ann & Ben') && hofRows[0].includes('3\u00a0⭐'),   // nbsp keeps the ⭐ glued to its count
    `unexpected HOF row: ${hofRows[0]}`);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-sheet:not([hidden])');
  await page.click('#sheet-clear-hof');           // confirm() auto-accepted by the dialog handler
  await page.click('#sheet-close');
  assert.strictEqual(await page.evaluate(() => localStorage.getItem('gonuts.hof')), null,
    'clear history wipes gonuts.hof');
  assert.strictEqual(await page.$$eval('#hof-list li', els => els.length), 0, 'the open HOF list re-renders empty');
  assert.ok(await page.$eval('#hof-empty', el => !el.hidden), 'the empty message shows after clearing');

  // ---- NUT-OFF turns are actually SHORTER (CONFIG.NUTOFF_SECONDS) ----
  // TEST mode always forces TEST_TURN >= 1s, so a ?test load can never show the
  // tiebreak-shortened length — deleting the Math.min branch would stay green above.
  // Same pattern as S8's plain-load leg: seed a mid-tiebreak v2 snapshot, resume it on
  // a PLAIN load (reduced motion keeps clicks hit-testable), and read the intro copy —
  // never the wall clock. Deliberately do NOT play the 10s turn.
  await page.evaluate(() => {
    localStorage.clear();
    const players = [{ id: 'p1', name: 'Ann' }, { id: 'p2', name: 'Ben' }, { id: 'p3', name: 'Cai' }];
    const game = {
      v: 2,
      settings: { v: 1, turnSeconds: 15, rounds: 1, sound: true, haptics: true, deckId: 'classic' },
      players,
      order: ['p1', 'p2', 'p3'],
      round: 1, turnIdx: 3,
      raterQueue: [],
      turns: [],
      drawPile: [0, 1, 2, 3, 4],
      currentPromptIdx: null,
      skipsUsed: { p1: 0, p2: 0, p3: 0 },
      tiebreak: { contenders: ['p1', 'p2'], order: ['p1', 'p2'], turnIdx: 0 },
      hofRecorded: false,
    };
    localStorage.setItem('gonuts.game', JSON.stringify({ v: 2, savedAt: Date.now(), phase: 'intro', game }));
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(base);                          // no ?test → the tiebreak branch decides the length
  await page.waitForSelector('#resume-banner:not([hidden])');
  await page.click('#resume-btn');
  await page.waitForSelector('#intro-screen.active');
  assert.ok(await page.$eval('#intro-nutoff', el => !el.hidden), 'the resumed intro shows the NUT-OFF banner');
  assert.strictEqual(await text(page, '#intro-secs'), '10',
    'sudden-death turns run the shorter NUTOFF_SECONDS length, not the 15s game setting');
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

// S8 — Settings persist: toggle sound off via the fixed #sound-btn (Phase 2), pick a
// 30s turn length via the sheet's segmented picker (Phase 3.5), reload, and both the
// persisted gonuts.settings AND the UI must survive — including a fresh game actually
// USING the picked turn length.
scenario('S8 sound/haptics + turn-length picks persist across reload', async ({ page, base }) => {
  await page.goto(base + Q);
  assert.strictEqual(await text(page, '#sound-btn'), '🔊');
  assert.strictEqual(await page.getAttribute('#sound-btn', 'aria-label'), 'Mute sound');
  await page.click('#sound-btn');
  assert.strictEqual(await text(page, '#sound-btn'), '🔇');

  // The gear opens the sheet (visible on setup). It must be a REAL modal: dialog
  // semantics for AT, an inert background (a keyboard user must not be able to reach
  // #start-btn and launch the game under the sheet), and Escape/Done/backdrop closes.
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-sheet:not([hidden])');
  assert.strictEqual(await page.getAttribute('#settings-sheet .sheet-panel', 'role'), 'dialog');
  assert.strictEqual(await page.getAttribute('#settings-sheet .sheet-panel', 'aria-modal'), 'true');
  assert.ok(await page.$eval('#setup-screen', el => el.inert), 'background is inert while the sheet is open');
  assert.ok(await page.$eval('#start-btn', el => el !== document.activeElement && el.closest('[inert]') !== null),
    'start button is unreachable behind the open sheet');
  await page.keyboard.press('Escape');                                     // Escape closes it
  assert.strictEqual(await page.$('#settings-sheet:not([hidden])'), null, 'Escape closes the sheet');
  assert.ok(await page.$eval('#setup-screen', el => !el.inert), 'background inert lifts on close');

  await page.click('#settings-btn');                                       // reopen for the toggle checks
  await page.waitForSelector('#settings-sheet:not([hidden])');
  assert.strictEqual(await text(page, '#sheet-sound'), '🔇 Sound: Off');   // sheet mirrors the corner button
  await page.click('#sheet-haptics');
  assert.strictEqual(await text(page, '#sheet-haptics'), '📴 Haptics: Off');
  await page.click('#sheet-backdrop', { position: { x: 10, y: 10 } });     // backdrop tap closes the sheet
  assert.strictEqual(await page.$('#settings-sheet:not([hidden])'), null);

  await page.reload();
  await page.waitForSelector('#setup-screen.active');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gonuts.settings')));
  assert.strictEqual(stored.sound, false, 'gonuts.settings persisted sound:false');
  assert.strictEqual(stored.haptics, false, 'gonuts.settings persisted haptics:false');
  assert.strictEqual(await text(page, '#sound-btn'), '🔇', 'muted state survives reload');
  assert.strictEqual(await page.getAttribute('#sound-btn', 'aria-label'), 'Unmute sound');

  // Phase 3.5: the segmented pickers. Pick 30s turns, reload, and assert the persisted
  // settings AND that a new game actually uses it. TEST_TURN (&t=2) overrides gameplay
  // length, so the "actually uses it" check runs on a t-less URL and reads the intro
  // copy + the frozen game.settings — never the wall clock.
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-sheet:not([hidden])');
  assert.strictEqual(await page.getAttribute('#seg-turn button[data-val="15"]', 'aria-pressed'), 'true',
    'the default 15s pick is marked');
  assert.strictEqual(await text(page, '#seg-deck button[data-val="classic"]'), 'Classic');
  assert.strictEqual(await page.getAttribute('#seg-deck button[data-val="classic"]', 'aria-pressed'), 'true',
    'the Classic deck is picked by default');
  await page.click('#seg-turn button[data-val="30"]');
  assert.strictEqual(await page.getAttribute('#seg-turn button[data-val="30"]', 'aria-pressed'), 'true');
  assert.strictEqual(await page.getAttribute('#seg-turn button[data-val="15"]', 'aria-pressed'), 'false');
  await page.click('#sheet-close');

  await page.reload();
  await page.waitForSelector('#setup-screen.active');
  const stored2 = await page.evaluate(() => JSON.parse(localStorage.getItem('gonuts.settings')));
  assert.strictEqual(stored2.turnSeconds, 30, 'gonuts.settings persisted turnSeconds:30');
  assert.strictEqual(await page.evaluate(() => window.__gonuts.settings.turnSeconds), 30);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-sheet:not([hidden])');
  assert.strictEqual(await page.getAttribute('#seg-turn button[data-val="30"]', 'aria-pressed'), 'true',
    'the 30s pick survives the reload');
  await page.click('#sheet-close');

  // "Actually uses it": TEST mode always forces TEST_TURN >= 1s (Math.max(1, …) is the
  // spec'd parse), so a ?test load can never show the settings-driven length. Run this
  // leg on a PLAIN load with reduced-motion emulated — the media query kills the same
  // animations the .test class does, so normal hit-tested clicks stay stable.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(base);
  await page.waitForSelector('#setup-screen.active');
  await startGame(page, ['Ann', 'Ben']);
  assert.strictEqual(await text(page, '#intro-secs'), '30', 'intro copy reads the picked turn length');
  const snap = await page.evaluate(() => JSON.parse(localStorage.getItem('gonuts.game')));
  assert.strictEqual(snap.game.settings.turnSeconds, 30,
    'the frozen per-game snapshot carries the picked turn length');
  // Deliberately do NOT play this turn — it would run 30 real wall-clock seconds.
});

// G-UX8 — Confetti upgrades: a 5-star tap fires a ~30-particle micro-burst anchored at
// the tapped star (not the full-screen top rain), mixing 🥜 glyph particles in at ~1-in-5,
// and the canvas visibility gate is widened to the rating state.
scenario('G-UX8 five-star tap fires an origin micro-burst with 🥜 glyphs', async ({ page, base }) => {
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben']);
  await page.click('#begin-turn-btn');
  await page.waitForSelector('#pass-screen.active', { timeout: 15000 });   // Phase 3.4 interstitial
  await page.click('#pass-rate-btn');
  await page.waitForSelector('#rating-screen.active');
  assert.ok(await page.$eval('#confetti', el => getComputedStyle(el).display !== 'none'),
    'confetti canvas must be visible in the rating state (widened CSS gate)');
  const star = await page.$eval('#stars .star:nth-child(5)', el => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.click('#stars .star:nth-child(5)');
  const parts = await page.evaluate(() => window.__gonuts.getConfetti());
  assert.strictEqual(parts.length, 30, `expected a 30-particle micro-burst, got ${parts.length}`);
  // Glyph assignment is deterministic (every 5th particle) — an unseeded coin flip here
  // flaked ~1 in 800 CI runs (0.8^30 all-paper bursts), so the count is exact now.
  assert.strictEqual(parts.filter(p => p.glyph === '🥜').length, 6,
    'exactly 6 of 30 particles are 🥜 glyphs (deterministic 1-in-5)');
  // Origin burst: assert on the engine-recorded spawn coords (x0/y0), NOT the live x/y —
  // the rafLoop physics keeps advancing particles between the click and this evaluate,
  // so live positions drift past any fixed bound if the CDP round-trip stalls ~500ms.
  assert.ok(parts.every(p => Math.abs(p.x0 - star.x) < 2 && Math.abs(p.y0 - star.y) < 2),
    'micro-burst particles must spawn at the tapped star');
  await page.click('#submit-rating-btn');          // the 5-star rating still records normally
  await page.waitForSelector('#intro-screen.active');
  const g = await page.evaluate(() => window.__gonuts.getGame());
  const raterId = g.players.map(p => p.id).find(id => id !== g.turns[0].performerId);  // order is shuffled from Phase 3
  assert.deepStrictEqual(g.turns[0].ratings, { [raterId]: 5 });
});

// S9 — Illegal-transition fuzz: every from→to edge NOT in the state table must be a
// guarded no-op (returns false, state unchanged).
scenario('S9 illegal transitions are all blocked', async ({ page, base }) => {
  // Mirror of the STATES table (DESIGN.md §2; pass/roundEnd/nutoff rows + widened edges
  // from Phase 3.3/3.4/3.5). A drift between this copy and the page's table surfaces as a
  // fuzz failure — that is intentional: any commit that touches the table must update this
  // mirror too.
  const TABLE = {
    setup:      ['intro'],
    intro:      ['countdown', 'setup'],
    countdown:  ['performing', 'setup'],
    performing: ['pass', 'rating', 'setup'],
    pass:       ['rating', 'setup'],
    rating:     ['rating', 'pass', 'intro', 'roundEnd', 'nutoff', 'winner', 'setup'],
    roundEnd:   ['intro', 'setup'],
    nutoff:     ['intro', 'setup'],
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

// S11 — PWA (Phase 2): a plain production load (NO ?test — the real contract, SW
// registration path included, though it self-skips on http:) produces zero console
// errors, and the manifest + service worker are served from the same origin.
scenario('S11 PWA: plain load is clean; manifest + sw.js are served', async ({ page, base }) => {
  await page.goto(base);                          // deliberately no ?test query
  await page.waitForSelector('#setup-screen.active');
  const origin = new URL(base).origin;
  for (const file of ['/manifest.webmanifest', '/sw.js']) {
    const res = await fetch(origin + file);       // node 22 global fetch
    assert.strictEqual(res.status, 200, `${file} must return 200 from the test server`);
  }
  const manifest = await (await fetch(origin + '/manifest.webmanifest')).json();
  assert.strictEqual(manifest.name, 'Go Nuts!');
  assert.strictEqual(manifest.display, 'standalone');
  assert.ok(manifest.icons.length >= 2 && manifest.icons.every(i => i.src === 'icon.svg'),
    'manifest ships the icon.svg pair (any + maskable)');
  const sw = await (await fetch(origin + '/sw.js')).text();
  assert.ok(sw.includes("'gonuts-static-v1'"), 'sw.js cache name matches the spec');
  assert.ok(!sw.includes('skipWaiting()'), 'sw.js must never call skipWaiting (no mid-game swaps)');
});

// S12 — Prompt no-repeat + skip budget (Phase 3.1/3.2): every drawn prompt (used or
// skipped away) is unique across the whole seeded game; the prompt shows on BOTH the
// intro and timer screens; the persisted currentPromptIdx survives a mid-intro reload;
// and the one-per-player skip hides the button after use — for that player only.
scenario('S12 prompts unique across turns; skip budget is per player', async ({ page, base }) => {
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben', 'Cai']);
  const drawn = [];

  // Turn 1 intro: a prompt is up and the skip button is available.
  const first = await text(page, '#intro-prompt-text');
  assert.ok(first.length > 3, `intro shows a prompt (got "${first}")`);
  assert.ok(await page.$eval('#skip-prompt-btn', el => !el.hidden), 'skip button visible before use');
  drawn.push(first);

  // Skip: a different prompt renders in place (no navigation), and the button is gone.
  await page.click('#skip-prompt-btn');
  const second = await text(page, '#intro-prompt-text');
  assert.notStrictEqual(second, first, 'skip draws a different prompt');
  assert.strictEqual(await state(page), 'intro', 'skip re-renders in place — never navigates');
  assert.ok(await page.$eval('#skip-prompt-btn', el => el.hidden), 'skip button disappears after the one allowed use');
  drawn.push(second);

  // Reload mid-intro: currentPromptIdx rides the snapshot, so Resume keeps the prompt.
  await page.reload();
  await page.waitForSelector('#resume-banner:not([hidden])');
  await page.click('#resume-btn');
  await page.waitForSelector('#intro-screen.active');
  assert.strictEqual(await text(page, '#intro-prompt-text'), second, 'resume keeps the same drawn prompt');
  assert.ok(await page.$eval('#skip-prompt-btn', el => el.hidden), 'the spent skip budget survives the reload');

  // The timer screen echoes the same prompt while performing.
  await page.click('#begin-turn-btn');
  await page.waitForSelector('#timer-screen.active');
  assert.ok((await text(page, '#timer-prompt')).includes(second), 'timer screen renders the prompt line');
  for (const stars of [4, 4]) {                    // Phase 3.4: each rater enters via the interstitial
    await page.waitForSelector('#pass-screen.active', { timeout: 15000 });
    await page.click('#pass-rate-btn');
    await page.waitForSelector('#rating-screen.active');
    await page.click(`#stars .star:nth-child(${stars})`);
    await page.click('#submit-rating-btn');
  }

  // Turns 2 and 3: fresh unique prompts, and the OTHER players still have their skip.
  for (let turn = 2; turn <= 3; turn++) {
    await page.waitForSelector('#intro-screen.active');
    const prompt = await text(page, '#intro-prompt-text');
    assert.ok(!drawn.includes(prompt), `turn ${turn} prompt "${prompt}" repeats an earlier draw`);
    drawn.push(prompt);
    assert.ok(await page.$eval('#skip-prompt-btn', el => !el.hidden),
      `turn ${turn}'s performer keeps their skip (budget is per player, not per game)`);
    await playTurn(page, [3, 5]);
  }
  await page.waitForSelector('#winner-screen.active');

  // The log recorded a numeric promptIdx per turn, all unique (drawPile pop ⇒ no repeats).
  const g = await page.evaluate(() => window.__gonuts.getGame());
  const idxs = g.turns.map(t => t.promptIdx);
  assert.ok(idxs.every(i => typeof i === 'number'), `turn entries record promptIdx (got ${JSON.stringify(idxs)})`);
  assert.strictEqual(new Set(idxs).size, idxs.length, 'recorded prompt indexes are unique');
  assert.strictEqual(new Set(drawn).size, drawn.length, 'every prompt shown was unique');
});

// S13 — Private rating (Phase 3.4): across every turn of a 3-player game, the pass
// screen summons each rater exactly once, never the performer, in raterQueue order;
// its button names the same rater; and only after the hand-off does the star UI show.
scenario('S13 pass screen names each rater once, never the performer, in queue order', async ({ page, base }) => {
  await page.goto(base + Q);
  await startGame(page, ['Ann', 'Ben', 'Cai']);
  const ratingsByTurn = [[3, 5], [2, 4], [5, 1]];  // any mix — S13 asserts the hand-off, not the totals
  for (const ratings of ratingsByTurn) {
    await page.waitForSelector('#intro-screen.active');
    await page.click('#begin-turn-btn');
    await page.waitForSelector('#pass-screen.active', { timeout: 15000 });
    // Snapshot the queue exactly as openRating() built it (still un-consumed here).
    const { performer, queueNames } = await page.evaluate(() => {
      const g = window.__gonuts.getGame();
      const nameOf = id => g.players.find(p => p.id === id).name;
      return { performer: nameOf(g.turns.at(-1).performerId), queueNames: g.raterQueue.map(nameOf) };
    });
    assert.strictEqual(queueNames.length, 2, 'everyone but the performer rates');
    assert.ok(!queueNames.includes(performer), 'the performer is never in the rater queue');
    const summoned = [];
    for (const stars of ratings) {
      await page.waitForSelector('#pass-screen.active');
      const rater = await text(page, '#pass-name');
      summoned.push(rater);
      assert.notStrictEqual(rater, performer, 'the pass screen never summons the performer');
      assert.strictEqual(await text(page, '#pass-rate-btn'), `I'm ${rater} — rate!`,
        'the hand-off button names the same rater');
      assert.strictEqual(await page.$('#rating-screen.active'), null,
        'the star UI stays hidden until the named rater takes the phone');
      await page.click('#pass-rate-btn');
      await page.waitForSelector('#rating-screen.active');
      await page.click(`#stars .star:nth-child(${stars})`);
      await page.click('#submit-rating-btn');
    }
    assert.deepStrictEqual(summoned, queueNames, 'pass screens run in raterQueue order');
    assert.strictEqual(new Set(summoned).size, summoned.length, 'each rater is summoned exactly once');
  }
  await page.waitForSelector('#winner-screen.active');   // the hand-off flow still completes the game
});

// S14 — Multi-round (Phase 3.5): rounds=2 picked via the settings sheet. The game visits
// roundEnd exactly once, the between-rounds scoreboard shows the round-1 totals, round 2
// reshuffles the order and resets the turn pointer, the intro tags the round, and the
// final totals accumulate across both rounds.
scenario('S14 rounds=2 reaches roundEnd once; totals accumulate across rounds', async ({ page, base }) => {
  await page.goto(base + Q);
  await page.click('#settings-btn');
  await page.waitForSelector('#settings-sheet:not([hidden])');
  await page.click('#seg-rounds button[data-val="2"]');
  assert.strictEqual(await page.getAttribute('#seg-rounds button[data-val="2"]', 'aria-pressed'), 'true');
  await page.click('#sheet-close');

  await startGame(page, ['Ann', 'Ben']);
  // Count roundEnd visits via the body[data-state] stamp — the machine's own DOM trace.
  // (roundEnd always waits for a user click, so it can never be skipped inside one
  // synchronous mutation batch.)
  await page.evaluate(() => {
    window.__states = [];
    new MutationObserver(() => window.__states.push(document.body.dataset.state))
      .observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
  });
  assert.strictEqual(await page.evaluate(() => window.__gonuts.getGame().settings.rounds), 2,
    'the frozen game snapshot carries rounds=2');
  assert.strictEqual(await text(page, '#intro-round'), 'Round 1 of 2', 'intro shows the round tag');

  const totals = {};                               // name → accumulated stars (test-side ground truth)
  const playRound = async (stars) => {             // 2 players → 2 turns per round, 1 rater each
    for (const s of stars) {
      await page.waitForSelector('#intro-screen.active');
      const performer = await page.evaluate(() => {
        const g = window.__gonuts.getGame();
        return g.players.find(p => p.id === g.order[g.turnIdx]).name;
      });
      await playTurn(page, [s]);
      totals[performer] = (totals[performer] || 0) + s;
    }
  };

  // Ratings picked so NO round-2 reshuffle can produce a tie: |1-5|=4, |3-2|=1.
  await playRound([1, 5]);
  await page.waitForSelector('#roundend-screen.active');
  assert.strictEqual(await state(page), 'roundEnd');
  assert.strictEqual(await text(page, '#roundend-title'), 'Round 1 done!');
  assert.strictEqual(await text(page, '#next-round-btn'), 'Round 2!');
  const round1Order = await page.evaluate(() => window.__gonuts.getGame().order.slice());
  const expect1 = Object.entries(totals).map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
  const lis1 = await page.$$eval('#round-scores li', els => els.map(el => el.textContent.trim()));
  assert.deepStrictEqual(lis1, expect1.map(r => `${r.name} — ${r.total} ⭐ (avg ${r.total.toFixed(1)})`),
    'the running scoreboard shows the round-1 totals');
  assert.strictEqual(await page.evaluate(() => window.__gonuts.getGame().round), 1,
    'the round only bumps on the button, not on roundEnd entry');

  await page.click('#next-round-btn');
  await page.waitForSelector('#intro-screen.active');
  const g2 = await page.evaluate(() => {
    const g = window.__gonuts.getGame();
    return { round: g.round, turnIdx: g.turnIdx, order: g.order.slice() };
  });
  assert.strictEqual(g2.round, 2);
  assert.strictEqual(g2.turnIdx, 0, 'round 2 resets the turn pointer');
  assert.deepStrictEqual([...g2.order].sort(), [...round1Order].sort(),
    'the round-2 order is a permutation of the same players');
  assert.strictEqual(await text(page, '#intro-round'), 'Round 2 of 2');

  await playRound([3, 2]);
  await page.waitForSelector('#winner-screen.active');   // straight to winner — NO second roundEnd
  assert.strictEqual(await state(page), 'winner');
  assert.strictEqual(await page.evaluate(() => window.__states.filter(s => s === 'roundEnd').length), 1,
    'roundEnd is visited exactly once in a 2-round game');

  // Final totals accumulate across both rounds (each player got 2 ratings → avg = total/2).
  const expect = Object.entries(totals).map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
  assert.notStrictEqual(expect[0].total, expect[1].total, 'S14 script must produce a unique winner');
  assert.strictEqual(await text(page, '#winner-name'), expect[0].name);
  assert.strictEqual(await text(page, '#winner-subtitle'), 'CRAZIEST OF THEM ALL');
  const lis = await page.$$eval('#final-scores li', els => els.map(el => el.textContent.trim()));
  assert.deepStrictEqual(lis, expect.map(r => `${r.name} — ${r.total} ⭐ (avg ${(r.total / 2).toFixed(1)})`));
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

# Go Nuts! — Final Design Spec (DESIGN.md)

**Scope:** the complete architecture for Phases 1–4 of `/home/user/gonuts/ROADMAP.md`, implemented on top of the existing `/home/user/gonuts/index.html`. Multi-device rooms are out of scope.

**Provenance note for reviewers (not needed to implement):** this spec is a synthesis. The delivery discipline (port-don't-rewrite, ordered commits, CJS test harness, coarsened persistence) comes from the "minimal" proposal; the machine mechanism (declarative state table with legal-edge lists, a timer registry that also tracks rAF and transient listeners, CI-enforced structural lints, id-keyed turn-log scoring) comes from the "fsm" proposal; the network-first service worker with **no** build-time stamping, the frozen per-game settings snapshot, `body[data-state]`, and the single `advance()` flow router come from the "forward" proposal. The epoch fence from "fsm" is deliberately dropped (redundant with synchronous `clearAll()` in single-threaded JS), and `timers.raf` is respecified as a self-rescheduling `rafLoop` so confetti works.

---

## Hard invariants (violating any of these is a design regression)

1. `index.html` stays ONE self-contained file: all game CSS/JS inline, zero runtime dependencies, no build step, still loads from `file://`. New files only where the platform demands: `manifest.webmanifest`, `sw.js`, `icon.svg`, `og.png`, `tests/`, `.github/workflows/`.
2. **Only `transition()` changes what the user sees.** `show()` is private to it. No handler calls `show()` directly.
3. **Only the `timers` registry creates timers.** Raw `setTimeout`/`setInterval`/`requestAnimationFrame`/transient listeners are banned outside the registry itself (lines that must use them carry a `/* raw-timer-ok */` annotation; CI greps for violations — see §10). `transition()` clears the registry before entering any state. This is what makes bugs (a)/R1 and (b)/R2 structurally impossible.
4. **Scores are never stored, always derived.** There is no `p.total`, no `sorted[0]` winner anywhere. `computeWinners()` returns an **array**; ties must be handled explicitly (co-winners in Phase 1, NUT-OFF in Phase 3). This kills bug (c)/R5 permanently.
5. Every existing name that still works is preserved: screen `<section>` IDs (`setup-screen`, `intro-screen`, `timer-screen`, `rating-screen`, `winner-screen`), the `$`/`escapeHtml` helpers, the `// ---------- NAME ----------` banner comment style, the confetti engine's visual behavior. Phase 1 diffs must be reviewable against the current file.
6. Deploy target is GitHub Pages, static only. Deployed files are byte-identical to the repo (no sed/stamping).

---

## 1. Constants / config block

First thing inside the IIFE, under a `// ---------- CONFIG ----------` banner (the `CRAZY_WORDS`/`RATING_WORDS` arrays move directly below it):

```js
const CONFIG = Object.freeze({
  TURN_SECONDS_DEFAULT: 15,
  TURN_CHOICES:   [10, 15, 30],          // Phase 3 settings UI
  ROUND_CHOICES:  [1, 2, 3],
  NUTOFF_SECONDS: 10,                    // sudden-death turns are shorter
  COUNTDOWN_STEPS: ['3', '2', '1', 'GO NUTS!'],
  COUNTDOWN_STEP_MS: 700,
  WORD_CYCLE_MS:  900,
  REPAINT_MS:     200,                   // ring repaint cadence — cosmetic only, never counts time
  URGENT_AT_S:    3,                     // ring red + urgency cues
  WARN_AT_S:      8,                     // ring orange
  MIN_PLAYERS:    2,
  MAX_NAME_LEN:   14,
  SKIPS_PER_PLAYER: 1,                   // Phase 3 prompt skips
  RESUME_MAX_AGE_MS: 12 * 3600 * 1000,   // saves older than 12h are silently discarded
  HOF_MAX_ENTRIES: 20,
  RING_CIRC: 2 * Math.PI * 90,
});

const KEYS = Object.freeze({             // unversioned key names; each payload carries a `v` field
  game:     'gonuts.game',
  settings: 'gonuts.settings',
  hof:      'gonuts.hof',
  decks:    'gonuts.decks',              // Phase 4
});

// ---- test flags (parsed once; read only via accessors; never persisted) ----
const qp = new URLSearchParams(location.search);
const TEST = qp.has('test');             // ?test=1 → deterministic fast mode
if (TEST) document.documentElement.classList.add('test');
const TEST_TURN = TEST ? Math.max(1, +qp.get('t') || 0) : 0;      // &t=2 → 2s turns
const TEST_FAST = TEST && qp.has('fast');                          // &fast=1 → 60ms countdown steps
const TEST_SEED = TEST ? (+qp.get('seed') || 0) : 0;               // &seed=42 → deterministic shuffle
```

**Accessors (the only way timing values are read):**

```js
function countdownStepMs() { return TEST_FAST ? 60 : CONFIG.COUNTDOWN_STEP_MS; }
function wordCycleMs()     { return TEST_FAST ? 150 : CONFIG.WORD_CYCLE_MS; }
function turnSecondsForCurrentTurn() {
  if (TEST_TURN) return TEST_TURN;
  if (game?.tiebreak) return Math.min(CONFIG.NUTOFF_SECONDS, game.settings.turnSeconds);
  return game?.settings.turnSeconds ?? settings.turnSeconds;
}
```

**How copy/ring/state derive from it (kills R7):** the literal `15` is removed from all four places.
- Intro copy: the subtitle at index.html:322 becomes `Get ready to GO NUTS for <span id="intro-secs">…</span> seconds!`; `enterIntro()` sets `$('intro-secs').textContent = turnSecondsForCurrentTurn()`.
- Ring initial number: markup ships `<div class="ring-num" id="ring-num">—</div>`; `enterPerforming()` paints it before the first repaint.
- Timer math: ring fraction is `remainMs / (turnSecondsForCurrentTurn() * 1000)`; there is no stored `timeLeft` anywhere.
- NUT-OFF and the Phase 3 turn-length setting need zero further changes because everything reads the accessor.

**Test-mode CSS** (in the `<style>` block, needed for Playwright stability, §10):

```css
.test *, .test *::before, .test *::after {
  animation: none !important; transition: none !important;
}
```

---

## 2. State machine

### States

| State | Screen id | Owns timers? | Phase | Purpose |
|---|---|---|---|---|
| `setup` | `setup-screen` | no | 1 | roster entry, resume banner, HOF link (P3) |
| `intro` | `intro-screen` | no | 1 | "Next up: NAME" (+ prompt & skip in P3, NUT-OFF banner when tiebreak active) |
| `countdown` | `countdown-screen` | **yes** (step chain) | 1 | 3-2-1-GO as a real state (the `#ready-overlay` is converted into this screen — see checklist 1.4) |
| `performing` | `timer-screen` | **yes** (repaint + word intervals) | 1 | the ring |
| `pass` | `pass-screen` | no | 3 | "🤫 Hand the phone to ⟨rater⟩" private-rating interstitial |
| `rating` | `rating-screen` | no | 1 | star entry |
| `roundEnd` | `roundend-screen` | no | 3 | running scoreboard between rounds |
| `nutoff` | `nutoff-screen` | no | 3 | "🥜 IT'S A NUT-OFF! 🥜" tie announcement |
| `winner` | `winner-screen` | yes (confetti rafLoop) | 1 | crown, scores, superlatives (P3), HOF (P3) |

The **settings panel** is NOT a state — it is an overlay (bottom sheet) reachable only from `setup` and `winner`. Overlay policy: **overlays never own timers and never navigate**; they are pure DOM toggles.

### Timer plumbing (the registry)

```js
// ---------- TIMERS ----------
const timers = (() => {
  let handles = [];                        // [kind, handle] kind: 't'|'i'|'r'|'l'
  return {
    after(ms, fn)  { const h = setTimeout(fn, ms);  /* raw-timer-ok */ handles.push(['t', h]); return h; },
    every(ms, fn)  { const h = setInterval(fn, ms); /* raw-timer-ok */ handles.push(['i', h]); return h; },
    rafLoop(fn)    {                       // self-rescheduling: runs fn(t) each frame until fn returns false
      const slot = ['r', 0];
      const loop = (t) => { if (fn(t) !== false) slot[1] = requestAnimationFrame(loop); /* raw-timer-ok */ };
      slot[1] = requestAnimationFrame(loop); /* raw-timer-ok */
      handles.push(slot);
    },
    listen(target, ev, fn, opts) {         // transient listeners are timer-class resources
      target.addEventListener(ev, fn, opts);
      handles.push(['l', () => target.removeEventListener(ev, fn, opts)]);
    },
    clearAll() {
      for (const [k, h] of handles) {
        if (k === 't') clearTimeout(h);
        else if (k === 'i') clearInterval(h);
        else if (k === 'r') cancelAnimationFrame(h);
        else h();
      }
      handles = [];
    },
    count() { return handles.length; },    // exposed to tests via __gonuts
  };
})();
```

No epoch fence: `clearAll()` runs synchronously before any state entry, and JS is single-threaded, so a cleared handle can never fire. (Note for the `rafLoop` slot trick: the slot array is mutated in place so `clearAll` always cancels the *latest* scheduled frame.)

### The machine core

```js
// ---------- MACHINE ----------
const STATES = {
  // Phase 1 ships these six rows; Phase 3 ADDS pass/roundEnd/nutoff rows and widens `to` lists — rows are added, never reshaped.
  setup:      { screen: 'setup',     to: ['intro'],                              enter: enterSetup },
  intro:      { screen: 'intro',     to: ['countdown', 'setup'],                 enter: enterIntro },
  countdown:  { screen: 'countdown', to: ['performing', 'setup'],                enter: enterCountdown,  resume: 'intro' },
  performing: { screen: 'timer',     to: ['rating', 'setup'],                    enter: enterPerforming, resume: 'intro' },
  rating:     { screen: 'rating',    to: ['rating', 'intro', 'winner', 'setup'], enter: enterRating },
  winner:     { screen: 'winner',    to: ['intro', 'setup'],                     enter: enterWinner },
  // Phase 3 additions:
  // pass:     { screen: 'pass',     to: ['rating', 'setup'],                    enter: enterPass },
  // roundEnd: { screen: 'roundend', to: ['intro', 'setup'],                     enter: enterRoundEnd },
  // nutoff:   { screen: 'nutoff',   to: ['intro', 'setup'],                     enter: enterNutoff },
  // and: performing.to gains 'pass'; rating.to gains 'pass','roundEnd','nutoff'; rating gains resume:'pass'.
};
const machine = { state: null };           // null = boot; transitions from boot are always legal (resume targets)

function transition(to, payload = {}) {
  const from = machine.state;
  if (from && !STATES[from].to.includes(to)) {
    console.warn(`[fsm] blocked ${from} -> ${to}`);
    return false;                          // guarded no-op — this is what makes double-fires harmless
  }
  timers.clearAll();                       // no timer/listener/rAF survives a transition — R1/R2 dead
  wakeLock.sync(to);                       // §3
  machine.state = to;
  show(STATES[to].screen);                 // the ONLY call site of show()
  STATES[to].enter(payload);
  saveGame();                              // persistence rides every transition (§4)
  return true;
}

function show(name) {                      // PRIVATE: dumb DOM toggler, unchanged semantics
  document.body.dataset.state = machine.state;   // Phase 2 CSS-transition & mascot-pose hook
  document.querySelectorAll('.screen').forEach(el =>
    el.classList.toggle('active', el.id === `${name}-screen`));
}
```

Rules the implementer must follow:

- **Every button handler = optional data mutation + one `transition()` call.** e.g. `$('begin-turn-btn').onclick = () => transition('countdown');` — a second fire arrives while in `countdown`, `intro→countdown` is not in `countdown.to`, blocked. Bug (b)/R2 is unrepresentable. No `disabled` fiddling is needed for correctness (polish only).
- **Enter functions validate preconditions and bail to a safe state**: `enterCountdown`/`enterPerforming` start with `if (!currentPlayer()) return transition('setup');` (defense-in-depth for R1).
- **Reset button** (`#reset-btn`): `if (confirm('Reset everything and start over?')) { game = null; store.del(KEYS.game); transition('setup'); }` — legal from every state (`'setup'` appears in every `to` list). Mid-countdown, `clearAll()` kills the pending step chain: bug (a)/R1 is structurally impossible. `stopTimer()` is deleted; `state.timer/wordTimer/timeLeft` are deleted.
- The countdown enter function (near-verbatim port of `runReadyCountdown`, on registry timers):

```js
function enterCountdown() {
  if (!currentPlayer()) return transition('setup');
  let i = 0;
  const step = () => {
    if (i >= CONFIG.COUNTDOWN_STEPS.length) return transition('performing');
    const num = $('ready-num');
    num.textContent = CONFIG.COUNTDOWN_STEPS[i];
    restartAnim(num);                       // the existing offsetWidth reflow trick, extracted to UTIL
    audio.play(i < 3 ? 'tick' : 'go'); haptics.buzz(i < 3 ? 30 : [60, 40, 60]);  // Phase 2 (no-ops before)
    i++;
    timers.after(countdownStepMs(), step);
  };
  step();
}
```

- **Boot** always lands on `setup` first (the phone may have changed hands); resume is a banner, never an auto-jump (§4).

---

## 3. Timer design (wall-clock)

Ephemeral runtime values live in a module-level `run` object — **never** in closures captured by listeners, and never persisted:

```js
const run = { turnEndsAt: 0, turnTotalMs: 0, lastWholeSecond: 0 };

function enterPerforming() {
  const p = currentPlayer();
  if (!p) return transition('setup');
  $('timer-name').textContent = p.name;
  renderPromptLine();                                     // no-op until Phase 3
  run.turnTotalMs = turnSecondsForCurrentTurn() * 1000;
  run.turnEndsAt  = performance.now() + run.turnTotalMs;
  run.lastWholeSecond = turnSecondsForCurrentTurn() + 1;
  repaintRing(); cycleWord();
  timers.every(CONFIG.REPAINT_MS, repaintRing);
  timers.every(wordCycleMs(), cycleWord);
}

function repaintRing() {                                  // replaces tick() + updateRing()
  const msLeft = Math.max(0, run.turnEndsAt - performance.now());
  const secs = Math.ceil(msLeft / 1000);
  $('ring-num').textContent = secs;
  const ring = $('ring-fg');
  ring.setAttribute('stroke-dashoffset', CONFIG.RING_CIRC * (1 - msLeft / run.turnTotalMs));
  ring.style.stroke = secs <= CONFIG.URGENT_AT_S ? '#ff5252' : secs <= CONFIG.WARN_AT_S ? '#fb8c00' : '#ffeb3b';
  if (secs !== run.lastWholeSecond) {                     // per-second edge — sound/haptic hook
    run.lastWholeSecond = secs;
    if (secs > 0 && secs <= CONFIG.URGENT_AT_S) { audio.play('urgent'); haptics.buzz(40); }
  }
  if (msLeft <= 0) { audio.play('buzzer'); haptics.buzz([80, 60, 80]); endTurn(); }
}
function endTurn() {                                      // also the Stop button handler body
  openRating();                                           // builds raterQueue (§7)
  transition(hasPrivateRating() ? 'pass' : 'rating');     // hasPrivateRating(): false in P1, true from P3
}
```

Decisions, explicit:
- **Truth is `performance.now()` vs `run.turnEndsAt`; the 200ms interval only repaints.** Throttled intervals delay pixels, never stretch time (R3).
- **No pause feature.** The performance happens in the room; a hidden tab keeps the wall clock running.
- **`visibilitychange` is registered ONCE in BOOT** (not per-turn — this avoids the stale-closure leak the judges flagged): `document.addEventListener('visibilitychange', () => { if (!document.hidden && machine.state === 'performing') repaintRing(); })`. It reads `run.turnEndsAt` from module state, so it can never compute from a stale anchor. If the deadline passed while hidden, the first repaint on return ends the turn immediately.
- **Ring CSS:** change `transition: stroke-dashoffset 1s linear` → `stroke-dashoffset 0.2s linear, stroke 0.4s ease` to match the repaint cadence.
- **Wake Lock (R9):** a `wakeLock` module with `sync(state)` called from `transition()`: acquires `navigator.wakeLock?.request('screen')` when entering `countdown`/`performing`/`pass`/`rating`, releases on entry to every other state — `setup`/`intro`/`winner`/`roundEnd`/`nutoff` (releasing on `intro` too is deliberate: the crew may chat indefinitely before tapping I'M READY, and the countdown tap re-acquires). Re-acquire on the BOOT visibilitychange handler when visible and in an acquiring state. All calls try/catch — pure progressive enhancement.
- **Confetti (R8):** the always-on rAF loop is deleted. `burstConfetti()` pushes particles and, if no loop is active, starts `timers.rafLoop(frame)` where `frame` draws and returns `false` when `confetti.length === 0` (also clearing an `active` flag). Owned by `winner`; a transition away cancels it like any other timer.
- **Resume interaction:** a mid-flight turn is never persisted (§4 rewind rule), so `performance.now()` resetting on reload is harmless by construction. Do not "improve" this into a persisted deadline.

---

## 4. Persistence (localStorage)

Private-mode-safe wrapper (used by all keys):

```js
// ---------- STORE ----------
const store = {
  get(k)    { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k)    { try { localStorage.removeItem(k); } catch {} },
};
```

Four independent keys, so Reset never nukes preferences and a rating tap never rewrites the hall of fame:

| Key | Written when | Cleared when |
|---|---|---|
| `gonuts.settings` | any settings change | never (merged over defaults on load) |
| `gonuts.game` | every `transition()` + roster add/remove + each rating submit + prompt skip | Reset (confirmed), resume-Discard, New Game, stale (>12h), version mismatch |
| `gonuts.hof` | once per finished game in `enterWinner` | Phase 3 "clear history" UI |
| `gonuts.decks` | Phase 4 custom-deck editor saves | per-deck delete |

**Game snapshot schema (Phase 1 = `v: 1`; Phase 3 bumps to `v: 2`):**

```js
{
  v: 1,
  savedAt: Date.now(),
  phase: 'intro',            // REWOUND resumable state: STATES[machine.state].resume ?? machine.state
  game: { /* the full game object, §7 — serializable plain data, no derived values */ }
}
```

**Rewind rule:** timer-owning states are not resumable mid-flight. `saveGame()` writes `phase = STATES[machine.state].resume ?? machine.state`: `countdown`/`performing` → `'intro'` (the turn honestly restarts, same performer, same prompt via `game.currentPromptIdx`); `rating` → itself in Phase 1 (current rater re-rates; partial star taps are UI-only, never persisted) and `'pass'` from Phase 3. `setup` phase: the snapshot is still written (roster only) so a refresh during setup keeps the typed names.

**Resume-on-load UX (BOOT):**
1. Load `KEYS.game`. Discard silently (delete the key) if: absent, `v` mismatch (**no migration code, ever** — games last minutes), `savedAt` older than `CONFIG.RESUME_MAX_AGE_MS`, or `game.players.length < CONFIG.MIN_PLAYERS`.
2. `transition('setup')` always runs first. If the snapshot's phase is `'setup'` → silently restore the roster, no banner.
3. Otherwise `enterSetup` renders a **resume banner** panel at the top of the setup screen: *"Game in progress — N players, round R, ⟨name⟩ up next."* with **[Resume]** → rehydrate `game`, `transition(snap.phase)` (legal because transitions from a fresh boot's `setup` to a resume target are allowed via a special case: resume calls bypass the edge check by setting `machine.state = null` first — implement as `resumeGame(snap)` that nulls `machine.state` then transitions) — and **[Discard]** → keep the roster, drop progress, delete the key.
4. `winner` is resumable as itself (refresh on the winner screen re-shows it; `game.hofRecorded` prevents double HOF writes). Play Again overwrites with a fresh game.

**`beforeunload` guard:** registered once at boot; the handler `preventDefault()`s only when `game !== null && machine.state !== 'setup' && machine.state !== 'winner' && !TEST`. It is a courtesy against accidental pull-to-refresh — persistence is the real safety net. `TEST` opt-out keeps Playwright reloads from hanging.

---

## 5. Settings object

```js
// ---------- SETTINGS ----------
const DEFAULT_SETTINGS = {
  v: 1,
  turnSeconds: CONFIG.TURN_SECONDS_DEFAULT,   // one of CONFIG.TURN_CHOICES
  rounds: 1,                                  // one of CONFIG.ROUND_CHOICES
  sound: true,
  haptics: true,
  deckId: 'classic',                          // key into the deck registry (custom ids in Phase 4)
};
let settings = Object.assign({}, DEFAULT_SETTINGS, store.get(KEYS.settings) || {});
function setSetting(k, v) { settings[k] = v; store.set(KEYS.settings, settings); }
```

- Persists in its own key; survives Reset and New Game. Shallow-merge over defaults is forward-compatible (new fields get defaults).
- **Frozen per-game snapshot:** `newGame()` copies `Object.freeze({ ...settings })` into `game.settings`; the ring, copy, rounds, and deck all read `game.settings.*`. A settings change mid-resume can never corrupt an in-flight game.
- Rollout: **Phase 1** ships the object + storage only (nothing reads `rounds`/`deckId` yet — cheap, de-risks later diffs). **Phase 2** adds the persistent 🔊/🔇 mute corner button (fixed top-right, mirroring `#reset-btn`) wired to `setSetting('sound', !settings.sound)`, plus a minimal settings sheet (sound/haptics). **Phase 3** extends the sheet with turn-length segmented buttons (10/15/30), rounds (1–3), and the deck picker; sheet reachable only from `setup`/`winner`.

---

## 6. Audio engine (Phase 2)

One self-contained module, WebAudio-only, zero asset files:

```js
// ---------- AUDIO & HAPTICS ----------
const audio = (() => {
  let ctx = null;
  const ensure = () => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = ctx || new AC();
      if (ctx.state !== 'running') ctx.resume();   // covers iOS Safari's non-standard 'interrupted' state, not just 'suspended'
      return ctx;
    } catch { return null; }
  };
  function tone(freq, dur, { type = 'square', gain = 0.14, at = 0, slideTo = null } = {}) {
    if (!settings.sound) return;                 // the ONLY mute check in the app
    const c = ensure(); if (!c) return;
    const t0 = c.currentTime + at;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  const CUES = {
    tick:    () => tone(880, 0.08),                                        // 3-2-1 steps
    go:      () => { tone(523, 0.15); tone(784, 0.25, { at: 0.12 }); },    // 'GO NUTS!'
    urgent:  () => tone(1174, 0.06, { gain: 0.16 }),                       // last URGENT_AT_S seconds
    buzzer:  () => tone(200, 0.6, { type: 'sawtooth', slideTo: 100, gain: 0.22 }),  // time up / Stop
    pop:     (n) => tone(440 + 130 * (n || 1), 0.09, { type: 'triangle' }),// star tap, pitch rises 1..5
    skip:    () => tone(330, 0.14, { slideTo: 200, type: 'triangle' }),    // prompt skip (P3)
    nutoff:  () => [392, 392, 392, 311].forEach((f, i) => tone(f, 0.14, { at: i * 0.16 })),  // tie! (P3)
    fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { at: i * 0.13, type: 'triangle' })),  // winner
  };
  return { play(name, arg) { CUES[name]?.(arg); }, unlock: ensure };
})();
const haptics = { buzz(p) { try { if (settings.haptics) navigator.vibrate?.(p); } catch {} } };
document.addEventListener('pointerdown', () => audio.unlock(), { once: true }); /* raw-timer-ok: permanent listener */
```

- **Autoplay policy:** context is lazily created and re-`resume()`d on every cue; the one-time document `pointerdown` unlock guarantees a gesture-created context before the first countdown. All cues are gesture-adjacent anyway (button-driven game).
- **Mute:** the `settings.sound` check lives inside `tone()` — call sites never branch. The 🔊/🔇 toggle persists via `setSetting` (§5).
- Cue → moment map: `tick` in countdown steps; `go` on 'GO NUTS!'; `urgent` on the last-3-seconds per-second edge (§3); `buzzer` on time-up and Stop; `pop(n)` in the star `onclick`; `skip` on prompt skip; `nutoff` in `enterNutoff`; `fanfare` in `enterWinner` alongside confetti.
- **Before Phase 2** ships, `audio.play` and `haptics.buzz` calls written in Phase 1 code must not error: ship stub `const audio = { play(){}, unlock(){} }; const haptics = { buzz(){} };` in Phase 1, replaced wholesale in Phase 2.

---

## 7. Game data model (built in Phase 1, consumed by Phase 3)

Phase 1 replaces the current name-keyed `players[i].scores` array with **id-keyed players + an append-only turn log**. This single decision feeds co-winners (P1), superlatives, NUT-OFF, multi-round (P3), and share cards + team mode (P4) — and avoids a scheduled Phase 3 schema rework.

```js
// ---------- GAME MODEL (pure data + pure functions; zero DOM access) ----------
let game = null;

function newGame(playerNames) {
  const players = playerNames.map((name, i) => ({ id: 'p' + (i + 1), name }));
  return {
    v: 1,                                             // 2 from Phase 3
    settings: Object.freeze({ ...settings }),          // frozen snapshot (§5)
    players,                                           // stable ids for the whole game; never key by name
    order: shuffle(players.map(p => p.id)),            // Phase 1: shuffle() is identity; Phase 3: Fisher-Yates
    round: 1,
    turnIdx: 0,                                        // index into order (or tiebreak.order during NUT-OFF)
    raterQueue: [],                                    // player ids left to rate the current turn
    turns: [],                                         // append-only log — the ONLY source of scoring truth
      // entry: { performerId:'p2', round:1, nutoff:false, promptIdx:null, ratings:{ p1:4, p3:5 } }
    // ---- Phase 3 fields (present from v2) ----
    // drawPile: [17, 4, 92, ...],                     // pre-shuffled prompt indexes; pop() = draw ⇒ no repeats
    // currentPromptIdx: null,                          // drawn in enterIntro; persisted so resume keeps the prompt
    // skipsUsed: { p1: 0 },                            // per player id, max CONFIG.SKIPS_PER_PLAYER
    // tiebreak: null,                                  // { contenders:[ids], order:[ids], turnIdx:0 }
    hofRecorded: false,
  };
}
```

**Pure functions (unit-testable through the page handle; no DOM, no timers):**

```js
currentPerformerId()                       // game.tiebreak ? tiebreak.order[tiebreak.turnIdx] : game.order[game.turnIdx]
currentPlayer()                            // players.find(p => p.id === currentPerformerId())
nameOf(id)                                 // id → display name (Phase 4 team mode extends this)
getRaterIds(g, performerId)                // Phase 1: all player ids except performer; NUT-OFF: non-contenders only; P4 teams: non-teammates
starsFor(turn)                             // Object.values(turn.ratings).reduce((a,b)=>a+b,0)
totalsFor(g, { nutoffOnly = false } = {})  // → Map<playerId, { total, turnCount, avg }> over the filtered log
computeWinners(g, opts)                    // → playerId[]  (ALWAYS an array — ties are explicit, never sorted[0])
computeSuperlatives(g)                     // → [{ title, playerIds, detail }]  (Phase 3)
getResults(g)                              // → view-model { winners:[{id,name,total,avg}], rows:[...ranked...], superlatives, coWinners:boolean }
                                           //   consumed by the winner screen, round-end scoreboard, HOF writer, AND the Phase 4 share card
```

**Main totals exclude NUT-OFF turns** (`turns.filter(t => !t.nutoff)`), so championship totals stay honest; NUT-OFF resolution uses `totalsFor(g, { nutoffOnly: true })`.

**The single flow router.** All "what happens next" logic lives in ONE function so Phase 3 changes one place:

```js
function advance() {                        // called by the rating submit handler after recording a rating
  const g = game;
  if (g.raterQueue.length) return transition(hasPrivateRating() ? 'pass' : 'rating');
  if (g.tiebreak) {                                                    // Phase 3
    g.tiebreak.turnIdx++;
    if (g.tiebreak.turnIdx < g.tiebreak.order.length) return transition('intro');
    return transition('winner');                                       // enterWinner resolves via nutoffOnly totals
  }
  g.turnIdx++;
  if (g.turnIdx < g.order.length) return transition('intro');
  if (g.round < g.settings.rounds) return transition('roundEnd');      // Phase 3
  const winners = computeWinners(g);
  if (winners.length === 1 || winners.length === g.players.length) return transition('winner');
  return transition('nutoff', { contenders: winners });                // Phase 3; Phase 1 falls through to winner (co-winners)
}
```

### Phase 3 mechanics on this model (save `v` bumps to 2; old saves discarded per §4)

- **Prompt deck (3.1):** `const DECKS = { classic: { name: 'Classic', prompts: [/* 100+ 'Go nuts like…' strings */] } };` in its own DECKS section. `activeDeck()` merges `store.get(KEYS.decks) || {}` under the built-ins and resolves `game.settings.deckId` (fallback: classic). At game start: `game.drawPile = shuffle(range(activeDeck().prompts.length))`. `enterIntro` pops `game.currentPromptIdx` (unless resuming with one set) and renders *"Go nuts like… ⟨prompt⟩"*; a "Skip ↻" button is visible while `game.skipsUsed[id] < CONFIG.SKIPS_PER_PLAYER`; skip increments, pops the next index, re-renders in place (no transition), plays `audio.skip`. Empty pile → reshuffle the full range (repeats now unavoidable). The turn entry records `promptIdx`.
- **Shuffled order (3.2):** swap `shuffle()` from identity to Fisher–Yates (seeded by `mulberry32(TEST_SEED)` when `TEST_SEED`, else `Math.random`). `newGame` and Play Again (which builds a fresh `newGame(sameNames)`) reshuffle automatically. Two lines, because everything already routes through `currentPlayer()`.
- **NUT-OFF (3.3):** `enterNutoff({contenders})` shows "🥜 IT'S A NUT-OFF! 🥜" + contender names, plays `audio.nutoff`, sets `game.tiebreak = { contenders, order: shuffle(contenders), turnIdx: 0 }`; its button → `transition('intro')`. NUT-OFF turns reuse the exact same `intro → countdown → performing → (pass →) rating` states — `turnSecondsForCurrentTurn()` returns the shorter length, turns are logged with `nutoff: true`, and `getRaterIds` returns **non-contenders only**. `enterWinner` resolves: unique max on `nutoffOnly` totals → winner; still tied, or `contenders.length === players.length` (no neutral raters — including every 2-player tie) → **co-winners**: `winner-name` shows names joined with " & ", subtitle "CO-CRAZIEST OF THEM ALL". *(Phase 1 stopgap, because bug (c) is verified and can't wait: `advance()` has no `nutoff` row yet, so `enterWinner` renders the co-winner form directly whenever `getResults().coWinners`.)*
- **Private rating (3.4):** flip `hasPrivateRating()` to `true`; add the `pass` row. `enterPass` shows "🤫 Hand the phone to **⟨rater⟩**" + button "I'm ⟨rater⟩ — rate!" → `transition('rating')` for that single rater. The star UI is unchanged (the interstitial IS the privacy mechanism); submit records `game.turns.at(-1).ratings[raterId] = stars`, shifts `raterQueue`, calls `advance()`.
- **Multi-round (3.5):** `enterRoundEnd` renders the running scoreboard from `getResults(game).rows` (reusing `.scoreboard` markup) + a "Round ⟨r+1⟩!" button → `game.round++; game.turnIdx = 0; game.order = shuffle(...)`; `transition('intro')`. Totals accumulate automatically since turns carry `round`.
- **Superlatives (3.6):** computed by `computeSuperlatives` from the log, shown only with ≥3 players: **Most Bananas Moment** (highest single-turn `starsFor`, with its prompt), **Crowd Favorite** (most 5★ received), **Most Generous Rater** (highest average given, from the `ratings` keys). Ties within a superlative → all listed with "&". Rendered as pill rows under the final scoreboard.
- **Hall of Fame (3.7)** — `gonuts.hof`:

```js
{ v: 1, entries: [   // newest first, capped at CONFIG.HOF_MAX_ENTRIES
  { at: Date.now(), crewKey: 'alex|jo|sam',          // sorted lowercase names — identifies a crew
    players: ['Alex','Jo','Sam'], winners: ['Sam'], stars: 14, rounds: 1, hadNutoff: false } ] }
```

Appended once in `enterWinner`, guarded by `game.hofRecorded`. Winner screen shows a crew line ("👑 3rd title for this crew!") when `crewKey` matches history; a small "🏆 Hall of Fame" toggle on the setup screen lists entries.

---

## 8. Phase 4 hooks (what Phase 1 must anticipate — and nothing more)

1. **Custom decks:** already anticipated: `settings.deckId` is a string, `activeDeck()` merges `KEYS.decks` storage under the built-in `DECKS`, and all prompt access goes through it. Phase 4 adds an editor sheet (textarea, one prompt per line) writing `{ v:1, decks: { 'c1720…': { name, prompts: [] } } }` to `gonuts.decks`, plus deck-picker entries. Zero logic changes.
2. **Canvas share card:** `getResults(game)` is the pure view-model the winner screen already renders from exclusively (this exclusivity is the Phase 1 obligation). Phase 4 adds `renderShareCard(results)` → offscreen `<canvas>` 1080×1350 in the neo-brutalist style → `canvas.toBlob` → `navigator.share({ files })` with `<a download>` fallback.
3. **Team mode:** players carry stable ids; raters come from `getRaterIds()`; names resolve through `nameOf()`. Phase 4 adds optional `player.teamId`, `game.teams`, and swaps `getRaterIds` (exclude teammates) + `totalsFor` (optional `by` key-function grouping by team). Nothing else in the loop knows about teams.
4. **Multi-device rooms: out of scope.** The serializable `game` object mutated only by named functions would be the sync payload if it ever lands; no extra Phase 1 cost.

---

## 9. File layout, PWA, metadata

### Repository (after all phases)

```
index.html                    # the game — the only file that changes per feature
manifest.webmanifest          # Phase 2
sw.js                         # Phase 2
icon.svg                      # Phase 2 — acorn mark; favicon + PWA icon (any + maskable)
og.png                        # Phase 2 — 1200×630 raster (unfurlers don't take SVG); generated once via the test harness screenshot, committed
ROADMAP.md
DESIGN.md                     # this spec
tests/
  package.json                # { "private": true, "scripts": { "test": "node smoke.cjs" }, "devDependencies": { "playwright": "~1.49" } }
  smoke.cjs                   # the whole harness: static server + scenarios (CJS on purpose, §10)
.github/workflows/pages.yml   # test job gating deploy (§10)
```

### `index.html` internal `<script>` section order (each under a `// ---------- NAME ----------` banner, matching the file's existing style)

1. CONFIG (+ TEST flag parsing, accessors)
2. UTIL (`$`, `escapeHtml`, `restartAnim`, `shuffle` + `mulberry32`, `range`)
3. COPY & DECKS (`CRAZY_WORDS`, `RATING_WORDS`; `DECKS` from Phase 3)
4. STORE (§4 wrapper)
5. SETTINGS (§5)
6. AUDIO & HAPTICS (§6; stubs until Phase 2)
7. WAKE LOCK
8. TIMERS (registry, §2)
9. GAME MODEL (pure data + pure functions + `advance()`, §7)
10. MACHINE (`STATES`, `transition`, private `show`, §2)
11. SCREENS (enter functions + render helpers, in flow order: setup → intro → countdown → performing → pass → rating → roundEnd → nutoff → winner)
12. WIRING (every handler = data op + `transition()`; nothing else)
13. PERSISTENCE (`saveGame`, `loadSnapshot`, `resumeGame`, resume banner, `beforeunload`)
14. CONFETTI (existing engine, rafLoop lifecycle)
15. SW REGISTRATION + BOOT (visibilitychange, resume check, `renderPlayers()`, `transition('setup')`, `if (TEST) window.__gonuts = { machine, timers, transition, getGame: () => game, settings, CONFIG }`)

Markup: existing `<section>` order preserved; `#ready-overlay` is converted into `<section id="countdown-screen" class="screen">` (keeping `#ready-num` and its `pop` animation); Phase 3 adds `pass-screen`, `roundend-screen`, `nutoff-screen` sections; overlays (settings sheet, resume banner is inline in setup) come after the screens; fixed chrome: `#reset-btn`, `#sound-btn` (P2), `#settings-btn` (P3).

### `<head>` additions (Phase 2)

`<link rel="icon" href="icon.svg">` · `<link rel="manifest" href="manifest.webmanifest">` · `<meta name="theme-color" content="#ff006e">` · `<meta name="description" …>` · OG/Twitter tags pointing at `og.png` (absolute Pages URL) · viewport becomes `width=device-width,initial-scale=1,viewport-fit=cover` (**drop `user-scalable=no`**, G-UX4) · `env(safe-area-inset-*)` padding on `.screen` and fixed buttons (G-UX7). A `@media (prefers-reduced-motion: reduce)` block disables the infinite wobble/pulse/gradient animations (same selectors the `.test` rule uses).

### `manifest.webmanifest`

```json
{ "name": "Go Nuts!", "short_name": "Go Nuts!",
  "description": "The pass-the-phone party game where the craziest player wins.",
  "start_url": "./", "scope": "./", "display": "standalone", "orientation": "portrait",
  "background_color": "#1a1a2e", "theme_color": "#ff006e",
  "icons": [ { "src": "icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
             { "src": "icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "maskable" } ] }
```

(If Android install testing shows SVG-icon gaps, add checked-in `icon-192.png`/`icon-512.png` — assets, not a build step.)

### `sw.js` — network-first, NO build-time stamping

```js
const CACHE = 'gonuts-static-v1';   // bump MANUALLY only when the PRECACHE list changes — never per deploy
const PRECACHE = ['./', './manifest.webmanifest', './icon.svg'];
// install: caches.open(CACHE).addAll(PRECACHE); skipWaiting? NO — never swap the app mid-game.
// activate: delete caches not named CACHE; clients.claim()
// fetch:
//   navigation requests → NETWORK-FIRST: fetch, cache.put('./', clone) on success; catch → caches.match('./')
//   everything else     → stale-while-revalidate: serve cache hit, refresh in background
```

Rationale (resolved contradiction): index.html is the only asset that changes per deploy, and navigations always hit the network first — so deployed fixes arrive on the next online load with **zero** version stamping, no `sed`, no CI file mutation, and the deployed files stay byte-identical to the repo. Offline (bad party wifi) serves the cached shell.

Registration (BOOT): `if ('serviceWorker' in navigator && !TEST && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');` — skipped under test and on `file://` (which keeps working as today).

### Deploy packaging (R10 footnote)

The deploy job assembles an allowlisted `public/` dir instead of uploading the repo root:
`mkdir public && cp index.html public/ && for f in manifest.webmanifest sw.js icon.svg og.png; do [ -f "$f" ] && cp "$f" public/; done` → `upload-pages-artifact` with `path: public`. (The existence guard lets Phase 1 ship this before the Phase 2 files exist.) `ROADMAP.md`/`DESIGN.md`/`tests/` are no longer published.

---

## 10. Test plan

### Harness: `tests/smoke.cjs` — deliberately CommonJS

ESM `import` ignores `NODE_PATH`; CJS `require()` honors it. One file, no branching harness, works in both worlds:

```js
// Local run (documented in a comment at the top of the file):
//   NODE_PATH=/tmp/claude-0/-home-user-gonuts/d0bfbb1e-ed5b-5bd2-9f82-728d039a3aae/scratchpad/node_modules \
//   PW_MODULE=playwright-core \
//   CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
//   node tests/smoke.cjs
// CI run: cd tests && npm ci && npx playwright install --with-deps chromium && npm test
const pw = require(process.env.PW_MODULE || 'playwright');
const assert = require('node:assert');
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
// ~15-line static server over the repo root on an ephemeral port (http origin needed for localStorage;
// file:// stays a product feature, not a test path)
const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
```

Scenarios run sequentially with plain `assert` — no test-runner dependency. Every scenario attaches `page.on('pageerror')` and console-`error` listeners; **any event fails the test** (this alone would have caught R1's TypeError). Native `confirm()` (Reset) handled via `page.on('dialog', d => d.accept())`.

### Speed + animated-button stability — one mechanism, the `?test=1` contract

Tests load `?test=1&t=2&fast=1&seed=42`:
- `t=2` → 2-second wall-clock turns (still exercises the *real* deadline math — no fake clock); `fast=1` → 60ms countdown steps (3-2-1-GO in ~0.25s). A full 3-player game runs in well under 15 seconds total.
- `test=1` adds the `.test` class, whose CSS rule kills all animations/transitions — the pulsing `.go` button gets a stable bounding box, so **normal Playwright clicks work. `force: true` is BANNED in the suite** (CI grep-enforced): forced clicks skip hit-testing and would have masked exactly the R1 overlay-intercepts-button bug class. The one sanctioned exception: the R2 double-fire scenario *deliberately* dispatches its second activation via `page.evaluate(() => document.getElementById('begin-turn-btn').click())` to simulate keyboard key-repeat — the point is proving the machine rejects it.
- `test=1` also: disables `beforeunload`, skips SW registration, seeds `shuffle`, and exposes `window.__gonuts`.

### Scenarios

| # | Scenario | Asserts | Phase |
|---|---|---|---|
| S1 | Happy path: add 3 players → full game with scripted mixed ratings → winner | totals/avgs/ranking on winner screen match values recomputed in the test; `__gonuts.machine.state === 'winner'` | 1 |
| S2 | **R1 regression:** begin turn, click Reset during 3-2-1 (accept confirm) | lands on setup, `timers.count() === 0`, no pageerror after 3 more seconds, a new game starts cleanly | 1 |
| S3 | **R2 regression:** on intro, fire begin-turn twice (2nd via JS click) | second `transition` returned false (console.warn observed or state check); after 1s the ring shows exactly ~1s elapsed; `timers.count()` equals the performing state's fixed handle count (2 intervals) | 1 |
| S4 | Wall-clock: with `t=2`, measure GO → rating transition | occurs within 2s ± 400ms | 1 |
| S5 | Resume: mid-rating `page.reload()` | resume banner appears; Resume restores players/turn/ratings (rewound per §4); Discard yields clean setup with roster kept | 1 |
| S6 | Tie: seeded 2-player game rated symmetrically | Phase 1: co-winner rendering, both names + "CO-CRAZIEST"; Phase 3 update: 3-player tie → nutoff screen → NUT-OFF resolves to one winner | 1→3 |
| S7 | Duplicate/empty name | shake/message feedback visible ("Sam is already playing!"), roster length 1 | 1 |
| S8 | Settings persist: toggle sound (P2) / turn length (P3), reload | `gonuts.settings` reflects both; UI matches | 2→3 |
| S9 | Illegal-transition fuzz: via `__gonuts.transition`, attempt every `from→to` not in the table | all return `false`, state unchanged | 1 |
| S10 | Structural lint (in-suite, no browser): no duplicate DOM ids in index.html | parse + Set check | 1 |
| S11 | PWA: page loads with zero console errors; `manifest.webmanifest` + `sw.js` fetch 200 on the served origin | (run without `?test` but with `fast`) | 2 |
| S12 | Prompt no-repeat + skip budget: seeded game, collect prompts across all turns | all unique; skip button disappears after 1 use for that player | 3 |
| S13 | Private rating: pass screen names each rater exactly once, never the performer | order matches `raterQueue` | 3 |
| S14 | Multi-round: rounds=2 game reaches roundEnd once, totals accumulate | scoreboard correct | 3 |

### CI workflow (`pages.yml` evolves in place)

```yaml
name: Test & Deploy to GitHub Pages
on: { push: { branches: [main] }, pull_request: {}, workflow_dispatch: {} }
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: false }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: cd tests && npm ci && npx playwright install --with-deps chromium && npm test
      - name: Structural lints
        run: |
          # raw timers banned outside annotated plumbing lines:
          ! grep -nE '\bset(Timeout|Interval)\(|requestAnimationFrame\(' index.html | grep -v 'raw-timer-ok'
          # forced clicks banned in the suite:
          ! grep -rn 'force: *true' tests/
  deploy:
    needs: test                       # smoke tests gate every Pages publish (R10)
    if: github.ref == 'refs/heads/main'
    environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Package allowlisted site
        run: |
          mkdir public && cp index.html public/
          for f in manifest.webmanifest sw.js icon.svg og.png; do [ -f "$f" ] && cp "$f" public/ || true; done
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: public }
      - id: deployment
        uses: actions/deploy-pages@v4
```

PRs run tests only; `main` pushes must pass tests before deploy.

---

## 11. Ordered per-phase implementation checklists

**Definition of done, every phase:** `node tests/smoke.cjs` green locally (NODE_PATH invocation) and in CI; the game still loads and plays from `file://`; the structural greps pass; a manual phone run-through of the full loop.

### Phase 1 — Reliability (ordered commits; each leaves the game shippable)

1. **Skeleton reshuffle (pure move, zero behavior change):** reorganize the IIFE into the §9 section order with banner comments; extract `restartAnim(el)` (the `offsetWidth` reflow trick) into UTIL; keep all logic identical.
2. **CONFIG + STORE + SETTINGS:** add the §1 CONFIG/KEYS/TEST block and accessors; add the `.test` CSS rule; add the §4 `store` wrapper and §5 settings object + `setSetting`; add audio/haptics stubs (§6). Replace all four hardcoded `15`s (intro copy `<span id="intro-secs">`, ring placeholder `—`, timer math) with accessor reads.
3. **Machine + timers:** add the §2 `timers` registry and `STATES`/`machine`/`transition()`/private `show()` (with `body[data-state]`). Port each existing flow function into an enter function preserving its body: `enterSetup` ← new-game/reset paths, `enterIntro` ← `showIntro`, `enterCountdown` ← `runReadyCountdown` (on `timers.after`; **for this commit the countdown state still shows the intro screen + `#ready-overlay`**), `enterPerforming` ← `startTimer` (still tick-based for this commit), `enterRating` ← `goToRating`/`nextRater`, `enterWinner` ← `showWinner`. Convert every handler to guard-free `transition()` calls; Reset = confirm + clear + `transition('setup')`. Delete `stopTimer`, `state.timer/wordTimer/timeLeft`, and all raw timer calls (annotate registry internals `/* raw-timer-ok */`). Manual check: reset mid-countdown and double-tap READY are now safe.
4. **Countdown screen conversion:** replace `#ready-overlay` with `<section id="countdown-screen" class="screen">` (keep `#ready-num` + `pop` keyframes, add the dimmed backdrop styling to the section); `STATES.countdown.screen = 'countdown'`; delete the overlay special-casing.
5. **Wall-clock timer:** implement §3 (`run` object, `repaintRing`, per-second edge, `endTurn`); ring CSS transition → `0.2s linear`; BOOT-registered `visibilitychange` repaint; delete `tick`/`updateRing`.
6. **Data model swap:** implement §7 — `newGame` with id-keyed players + `order` (identity `shuffle`) + `turns` log + `raterQueue` of ids; pure functions `currentPerformerId/currentPlayer/nameOf/getRaterIds/starsFor/totalsFor/computeWinners/getResults`; `openRating()`; the `advance()` router; rating submit records `ratings[raterId]`; `enterWinner` renders exclusively from `getResults()` including the **co-winner stopgap** (bug (c) is verified, so it ships now: `coWinners` → names joined with " & ", subtitle "CO-CRAZIEST OF THEM ALL"); Play Again = fresh `newGame(sameNames)` → `transition('intro')`.
7. **Persistence:** implement §4 — `saveGame()` in `transition()` + roster mutations + rating submit; rewind via `STATES[s].resume`; BOOT `loadSnapshot` with v/staleness/roster checks; resume banner in `enterSetup` with Resume (`resumeGame`) / Discard; `beforeunload` guard gated on `!TEST`.
8. **Small fixes:** R6 duplicate/empty-name feedback (message under the input: "⟨name⟩ is already playing!" + 300ms `shake` keyframe on the input, cleared on next input); R8 confetti `rafLoop` lifecycle (§3); R9 `wakeLock` module + `sync()` in `transition()`.
9. **Tests + CI:** create `tests/package.json` + `tests/smoke.cjs` with S1–S7, S9, S10; verify locally with the NODE_PATH/PW_MODULE/CHROMIUM_PATH invocation; rewrite `pages.yml` per §10 (test job + lints + allowlisted `public/` packaging + `needs: test`).

**Exit:** all scenarios green in CI; manual kill-tests (reset mid-countdown, double-tap READY, refresh mid-game, 2-player tie) clean.

### Phase 2 — Graphics & feel

1. **Screen transitions (G-UX1):** `.screen.active { animation: screenIn .28s cubic-bezier(.2,.9,.3,1.2); }` (slide-up + scale; incoming animates, outgoing cuts) keyed off `body[data-state]` where per-screen flavor is wanted — zero JS changes; respects `.test` and reduced-motion.
2. **Audio + haptics (G-UX2/2.2/2.3):** replace the stubs with the §6 engine; wire all cue call sites (`tick/go/urgent/buzzer/pop/fanfare`); add the fixed 🔊/🔇 `#sound-btn` + minimal settings sheet (sound/haptics toggles) persisted via `setSetting`; extend S8.
3. **Reduced motion + zoom (G-UX4):** `@media (prefers-reduced-motion: reduce)` block (static gradient, no wobble/pulse); drop `user-scalable=no`.
4. **A11y (G-UX5):** star buttons get `aria-label="{n} star(s)"`; ring number wrapped in `aria-live="polite"` updated only on whole-second changes ≤ 5; focus the screen's first heading inside `show()`.
5. **Confetti upgrades (G-UX8):** `burstConfetti(count, origin)` params; 5-star micro-burst in the star handler; 🥜 glyph particles mixed in.
6. **Metadata (G-UX6):** `icon.svg` (acorn mark with maskable padding), head tags per §9; generate `og.png` once via a harness screenshot, commit it.
7. **Safe area (G-UX7):** `viewport-fit=cover` + `env(safe-area-inset-*)` padding on `.screen` and fixed buttons.
8. **PWA (2.10):** `manifest.webmanifest` + `sw.js` per §9 + guarded registration in BOOT; extend the deploy allowlist (already existence-guarded); add S11.
9. **(Optional, L) Mascot (G-UX3):** inline `<svg id="mascot">` with poses driven purely by `body[data-state]` CSS — no JS/machine impact.

### Phase 3 — Gameplay depth (bump game snapshot `v` to 2 at step 1; old saves discard)

1. **Prompt deck (3.1):** fill `DECKS.classic` (100+ prompts); add `drawPile/currentPromptIdx/skipsUsed` to `newGame`; `enterIntro` draws + renders + skip button; `renderPromptLine()` on the timer screen; persist `currentPromptIdx`; `audio.skip`; add S12.
2. **Shuffle (3.2):** swap `shuffle` to Fisher–Yates (seeded under TEST). Order shuffles at every `newGame` and round start automatically.
3. **Private rating (3.4):** add `pass-screen` markup + `STATES.pass` row; widen `performing.to`/`rating.to`; flip `hasPrivateRating()` → true; `rating.resume = 'pass'`; add S13.
4. **Settings sheet upgrade + multi-round (3.5):** turn-length/rounds/deck pickers (locked mid-game — sheet only opens from setup/winner); add `roundend-screen` + `STATES.roundEnd` + the `advance()` round branch + round-reset logic; add S14.
5. **NUT-OFF (3.3):** add `nutoff-screen` + `STATES.nutoff` row + `game.tiebreak` + the `advance()` tiebreak branch + `getRaterIds` non-contender rule + `enterWinner` nutoff resolution (co-winner fallback retained); update S6.
6. **Superlatives (3.6):** `computeSuperlatives` + pill rows on the winner screen (≥3 players).
7. **Hall of Fame (3.7):** `gonuts.hof` writer in `enterWinner` (guarded by `hofRecorded`), crew callout line, HOF list toggle on setup, "clear history" in the settings sheet.

### Phase 4 — Stretch (each bolts onto an existing seam, §8)

1. **Custom decks:** editor sheet writing `gonuts.decks`; `activeDeck()` already resolves custom ids; deck picker lists them.
2. **Share card:** `renderShareCard(getResults(game))` canvas renderer + Web Share / download button on the winner screen.
3. **Team mode:** setup team-assignment UI; `player.teamId` + `game.teams`; swap `getRaterIds` (exclude teammates) and add the `by` grouping to `totalsFor`; winner/intro render team names via `nameOf`.

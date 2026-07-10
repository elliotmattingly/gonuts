# Go Nuts! — Codebase Audit & Product Roadmap

*Audit date: 2026-07-09 · Scope: entire repository (`index.html`, `.github/workflows/pages.yml`) · Findings marked **[verified]** were reproduced in a scripted Chromium run against the live code, not just read from source.*

---

## Implementation status (2026-07-10)

**All four phases below are implemented** on this branch, governed by the architecture spec in `DESIGN.md` (produced by a design panel and treated as the source of truth during the build). Every phase shipped through the same pipeline: sequential implementation commits, an independent test run plus four review lenses (spec invariants, behavior/game logic, visual QA on real screenshots, test quality), adversarial verification of every finding, a fix pass, and a green gate.

| Phase | Status | Notes |
|---|---|---|
| 1 — Reliability | ✅ Shipped | State machine + timer registry, wall-clock timer, localStorage resume, wake lock, 9-scenario smoke suite + CI gate. Both audit-verified crashes are structurally impossible now. |
| 2 — Graphics & feel | ✅ Shipped | Screen transitions, WebAudio cues + haptics, mute/settings sheet, peanut mascot (3-candidate design panel), confetti upgrades, a11y + reduced motion, favicon/OG/social meta, PWA (offline via service worker), safe-area support. |
| 3 — Gameplay depth | ✅ Shipped | 130-prompt "Go nuts like…" deck with per-player skips, shuffled turn order, private pass-the-phone rating, turn-length/rounds settings, multi-round scoreboard, NUT-OFF tie-breaker, superlatives, hall of fame. |
| 4 — Stretch | ✅ Shipped (3 of 4) | Custom prompt decks, canvas share card (Web Share + download), team mode. Multi-device rooms deliberately not built — requires a backend, contradicts the zero-setup single-link architecture. |

The smoke suite now covers 18 scenarios and, together with two structural lints (no raw timers outside the registry, no forced clicks in tests), gates every GitHub Pages deploy. Deviations from this document's original sketches are recorded in `DESIGN.md` and in code comments (notably: the turn deadline anchors to `Date.now()` because `performance.now()` freezes during iOS page suspension; ties fall back to co-winners whenever a NUT-OFF would have no eligible raters; setup-screen team assignments intentionally don't persist until a game starts).

---

## 1. What exists today

Go Nuts! is a pass-the-phone party game shipped as a single self-contained `index.html` (~700 lines: CSS, markup, and vanilla JS), deployed to GitHub Pages on every push to `main`.

**Game loop:** add 2+ players → each player gets a 3‑2‑1 countdown, then 15 seconds to "go nuts" while random hype words flash → every other player rates them 1–5 stars → highest total stars wins, with confetti.

**Strengths worth preserving:**

- Zero dependencies, zero build step — instant load, works from a file:// URL, nothing to break.
- Player names are HTML-escaped (`escapeHtml`, `index.html:428`) and rendered via `textContent` elsewhere — no XSS exposure found.
- Scoring is fair by construction: every player is rated by the same number of raters, so totals are comparable. **[verified]** — a full 3-player game produced correct totals, averages, and ranking.
- The Pages workflow is modern and correct (official actions, concurrency group, minimal permissions).

The roadmap below is organized as: audit findings first (reliability, graphics/UX, gameplay), then a phased plan with a quick-wins list.

---

## 2. Audit findings

### 2.1 Reliability

#### R1. Reset during the 3‑2‑1 countdown crashes the game — **[verified]** 🔴

`runReadyCountdown` (`index.html:472`) chains `setTimeout` calls but never stores a handle, so nothing can cancel it. The Reset button remains focusable while the overlay is up, so a keyboard user (or any future code path) can reset mid-countdown. The countdown then fires `startTimer()` against an empty player list:

```
TypeError: Cannot read properties of undefined (reading 'name')
```

…and the UI lands on a broken timer screen instead of setup. **Fix:** store the timeout handle in `state`, clear it in the reset path, and have `startTimer` bail if `state.players[state.turnIndex]` doesn't exist.

#### R2. Double-starting a turn runs the timer at 2× speed and leaks an interval — **[verified]** 🔴

`startTimer` (`index.html:498`) overwrites `state.timer` without clearing an existing one. Firing "I'M READY!" twice (reachable on desktop via keyboard key-repeat on the focused button; the overlay only blocks pointer events) stacks two 1-second intervals: the countdown ring hit **7** after 4 real seconds in testing, and the orphaned interval keeps ticking forever. **Fix:** guard with `if (state.timer) return;` or call `stopTimer()` at the top of `startTimer`, and disable the button once pressed.

#### R3. The turn timer counts ticks, not time 🟠

`tick` (`index.html:508`) decrements `timeLeft` once per `setInterval` callback. Mobile browsers throttle or suspend intervals when the tab is backgrounded, the screen dims, or the phone is under load — so a "15-second" turn can silently stretch. For a game whose entire premise is a fair timed window, the timer should compute remaining time from a wall-clock start timestamp (`performance.now()`), with the interval only driving repaints.

#### R4. One accidental refresh destroys the whole game 🟠

All state lives in the in-memory `state` object. Pull-to-refresh, an accidental back-swipe, a tab discard, or a phone lock that reloads the page wipes every player and score mid-game — the worst possible failure for a device being passed around a rowdy group. **Fix:** serialize `state` to `localStorage` on every mutation and offer "Resume game?" on load; add a `beforeunload` guard while a game is in progress.

#### R5. Ties are resolved silently and arbitrarily — **[verified]** 🟠

`showWinner` (`index.html:607`) takes `sorted[0]`. In a verified 2-player game where both scored identically, P1 was crowned with no acknowledgement. Turn order (i.e., who was added first) decides the championship. **Fix:** detect ties and either celebrate co-winners or trigger a tie-breaker round (see G4 — this is also a gameplay opportunity).

#### R6. Rejected player names give zero feedback — **[verified]** 🟡

`addPlayer` (`index.html:434`) silently clears the input for duplicates (and no-ops for whitespace-only names). Adding "Sam", "Sam", "sam" leaves one entry and no explanation — users will believe the tap failed or the player was added. **Fix:** a brief shake animation + message ("Sam is already playing!").

#### R7. The turn length is hardcoded in four places 🟡

`15` appears independently at `index.html:322` (intro copy), `:336` (initial ring text), `:501` (`state.timeLeft = 15`), and `:519` (`pct = timeLeft / 15`). The git history proves the hazard: the 30s→15s change had to touch all of them. **Fix:** one `TURN_SECONDS` constant driving copy, ring math, and state.

#### R8. The confetti loop runs forever 🟡

`loopConfetti` (`index.html:671`) schedules `requestAnimationFrame` unconditionally from page load, clearing and re-scanning the canvas ~60×/sec even when there are zero particles — needless battery drain on a phone-first game. **Fix:** start the rAF loop on `burstConfetti` and stop it when the particle array empties.

#### R9. Nothing prevents the screen from sleeping mid-game 🟡

A 15s performance plus multi-person rating rounds is plenty of time for a phone to auto-lock. The Screen Wake Lock API (`navigator.wakeLock`) is a small progressive enhancement that keeps the game alive while a round is running.

#### R10. Zero automated safety net 🟡

No tests, no CI checks — the Pages workflow deploys whatever lands on `main`, unvalidated. The audit itself demonstrated the fix: a ~100-line Playwright script drove a full game and caught two real bugs. That script belongs in CI (see Phase 1) so every push proves the core loop still works before it deploys. Minor note: `upload-pages-artifact` uses `path: .`, so repo files like this document are also published; harmless for a public repo, but `.` could be narrowed if the repo grows.

### 2.2 Graphics & UX

The neo-brutalist look (thick ink borders, hard shadows, rainbow gradient) is cohesive and fits the tone. Gaps:

- **G-UX1. Screens cut instantly.** Navigation flips `display: none/flex` (`index.html:379`) — no motion between setup → intro → timer → rating, which makes the flow feel flat compared to the game's energetic styling. Animated screen transitions (slide/scale/spring) are the single highest-impact visual upgrade.
- **G-UX2. No sound or haptics.** A party game with a silent countdown and a silent buzzer leaves most of the excitement on the table. WebAudio-synthesized ticks/buzzer/fanfare (no asset files needed, preserving the zero-dependency ethos) plus `navigator.vibrate` pulses on the 3‑2‑1 and final seconds.
- **G-UX3. Identity is emoji-only.** 👑 and ⭐ carry the whole brand; the game is named "Go Nuts" and has no nut. An inline-SVG squirrel/acorn mascot that reacts to game phases (idle, hyped during timer, crowned at winner) would give the game a face — still zero external assets.
- **G-UX4. Motion accessibility.** Infinite wobble/pulse/gradient animations run unconditionally; no `prefers-reduced-motion` handling. Also `user-scalable=no` blocks pinch-zoom, which WCAG advises against.
- **G-UX5. Screen-reader accessibility.** Star buttons are unlabeled `⭐` glyphs (no `aria-label="3 stars"`), the countdown has no `aria-live` region, and screens toggle without focus management.
- **G-UX6. Missing page metadata.** No favicon, `theme-color`, description, or Open Graph/Twitter tags — links shared into a group chat (the primary distribution channel for a party game) render bare.
- **G-UX7. Notch/safe-area.** No `viewport-fit=cover` + `env(safe-area-inset-*)`; the fixed Reset button (`index.html:295`) can collide with notches/dynamic islands, especially in landscape or installed-PWA mode.
- **G-UX8. Confetti is winner-only.** The most visually alive moment happens once. Micro-bursts on high ratings (5 stars) and word-flash particles during the timer would spread the energy through the session.

### 2.3 Gameplay

The core loop works, but it's one mechanic with no variation — replay value is the main growth constraint.

- **G1. No prompts.** "Go nuts" every round means everyone does the same flailing every time. A prompt deck ("Go nuts like… a squirrel who found espresso / a robot at a wedding / a mime in a wind tunnel") is the highest-leverage gameplay addition — it transforms repetition into a performance game with effectively unlimited variety.
- **G2. Ratings are public and socially pressured.** The rated player watches each rater tap stars, and the current rating stage shows the running interaction. A "pass-the-phone, rate in private" flow (rater sees a "hand the phone to X" interstitial, taps hidden, confirms) removes grudge dynamics. Related: later performers are rated by people who already know the standings — score reveal should be deferred to the end (it currently is — preserve that).
- **G3. Turn order is fixed.** Play order = join order, every game, including "Play Again" (`index.html:624`). Going first is a cold-open disadvantage. Shuffle each game.
- **G4. Ties end with a silent coin-flip (see R5).** Reframe as a feature: a sudden-death "NUT-OFF" round for tied leaders is thematically perfect and turns a bug fix into the best moment of the night.
- **G5. One fixed mode.** 15 seconds, one round, sum of stars. Cheap variety levers: configurable turn length (10/15/30), multi-round games with a running scoreboard, themed rounds (animals only, silent round, slow-motion round), and end-of-game superlatives ("Most 5s", "Crowd favorite") so more players get a moment.
- **G6. No session memory.** No champion history or "beat last week's crew" — a tiny localStorage hall of fame gives groups a reason to rematch.

---

## 3. Roadmap

Phased so each phase ships independently. Effort: **S** ≤ half a day, **M** ≈ 1–2 days, **L** ≈ 3+ days.

### Phase 1 — Reliability hardening (make it unbreakable)

| # | Item | Fixes | Effort |
|---|------|-------|--------|
| 1.1 | Cancelable transitions: store countdown/timer handles in `state`, clear them all on reset/navigation, guard `startTimer` against missing player & double-start | R1, R2 | S |
| 1.2 | Wall-clock timer: compute remaining time from a start timestamp; interval only repaints | R3 | S |
| 1.3 | `TURN_SECONDS` constant driving copy, ring, and state | R7 | S |
| 1.4 | Persist game state to localStorage + "Resume game?" on load + `beforeunload` guard mid-game | R4 | M |
| 1.5 | Duplicate/empty-name feedback (shake + message) | R6 | S |
| 1.6 | Confetti loop starts on burst, stops when empty | R8 | S |
| 1.7 | Screen Wake Lock during active rounds (progressive enhancement) | R9 | S |
| 1.8 | CI: Playwright smoke test (full game drive — the audit harness is a working prototype) + HTML validation, gating the Pages deploy | R10 | M |

**Exit criteria:** no reachable state can crash or corrupt a game; a refresh mid-game resumes; every push to `main` is smoke-tested before deploy.

### Phase 2 — Graphics & feel (make it delicious)

| # | Item | Fixes | Effort |
|---|------|-------|--------|
| 2.1 | Animated screen transitions (slide/scale with spring easing) | G-UX1 | M |
| 2.2 | WebAudio sound design: countdown ticks, go-horn, last-3-seconds urgency, end buzzer, star-tap pops, winner fanfare — all synthesized, no assets; mute toggle | G-UX2 | M |
| 2.3 | Haptics (`navigator.vibrate`) on countdown, buzzer, and star taps | G-UX2 | S |
| 2.4 | Inline-SVG mascot (squirrel/acorn) with per-phase poses | G-UX3 | M–L |
| 2.5 | Confetti upgrades: 5-star micro-bursts, 🥜-shaped particles, timer-word sparks | G-UX8 | S |
| 2.6 | `prefers-reduced-motion` support; re-enable pinch zoom | G-UX4 | S |
| 2.7 | A11y pass: star `aria-label`s, `aria-live` timer, focus management on screen swap | G-UX5 | S |
| 2.8 | Favicon + theme-color + OG/Twitter cards (link unfurls in group chats) | G-UX6 | S |
| 2.9 | Safe-area insets + `viewport-fit=cover` | G-UX7 | S |
| 2.10 | PWA: manifest + service worker → installable, fully offline (party venues have bad wifi) | — | M |

**Exit criteria:** the game sounds and moves like it looks; installable and playable offline; shared links unfurl with art.

### Phase 3 — Gameplay depth (make it endlessly replayable)

| # | Item | Fixes | Effort |
|---|------|-------|--------|
| 3.1 | Prompt deck: 100+ "Go nuts like…" prompts, no repeats within a game, "skip prompt" once per player | G1 | M |
| 3.2 | Shuffled turn order per game (including Play Again) | G3 | S |
| 3.3 | Tie-breaker "NUT-OFF" sudden-death round; co-winner celebration as fallback | G4, R5 | S–M |
| 3.4 | Private rating flow: "pass the phone to ⟨rater⟩" interstitial, hidden star entry | G2 | M |
| 3.5 | Game settings: turn length (10/15/30s), rounds per game (1–3) with running scoreboard | G5 | M |
| 3.6 | End-of-game superlatives ("Most Bananas Moment", "Crowd Favorite", "Most Generous Rater") | G5 | S |
| 3.7 | Hall of Fame: localStorage champion history per crew | G6 | S |

**Exit criteria:** two consecutive games feel different; ties are a highlight; every player gets a moment on the winner screen.

### Phase 4 — Stretch (only if the game finds an audience)

- **Custom prompt decks** — players add their own inside-joke prompts before a game (S–M).
- **Shareable result cards** — canvas-rendered winner image for group chats (M).
- **Party-size mode** — team play for 8+ players so rating rounds don't drag (M).
- **Multi-device rooms** (everyone rates from their own phone) — the only item that would end the zero-backend architecture; requires a sync service (WebRTC/PartyKit/Firebase) and is **deliberately last**: the single-device pass-the-phone constraint is a feature (one link, zero setup) and should only be abandoned with evidence of demand (L).

### Architecture stance

Stay single-file with zero dependencies through Phase 3 — it's a genuine product feature (instant load, offline-trivial, unbreakable deploys) and at ~700 lines the file is nowhere near unmanageable. Adopt a build step only if Phase 4's multi-device work lands. The one structural investment worth making now is inside the file: a small explicit state machine (`setup → intro → countdown → performing → rating → winner`) with a single "cancel all pending timers" transition hook — that one refactor is what makes R1/R2-class bugs structurally impossible rather than individually patched.

---

## 4. Top 5 quick wins

If only one afternoon were available:

1. **Fix the two verified crashes/leaks** (R1, R2) — cancelable countdown + timer guard.
2. **Wall-clock timer** (R3) — fairness is the product.
3. **localStorage resume** (R4) — eliminates the worst party-night failure.
4. **Sound + haptics** (2.2/2.3) — the largest feel-per-line-of-code upgrade available.
5. **Prompt deck** (3.1) — the largest replayability-per-line-of-code upgrade available.

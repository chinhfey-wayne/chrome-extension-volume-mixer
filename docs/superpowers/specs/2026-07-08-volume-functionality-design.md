# Volume Control — Functionality Overhaul Design

**Date:** 2026-07-08
**Status:** Approved design, pending spec review → implementation plan
**Repo:** github.com/ChinhFey/chrome-extension-volume-mixer

## Problem

The extension's volume/mute is unreliable and the mixer UI misbehaves. Concrete
reported failures:

1. **Two Google Meet tabs** — cannot raise/lower volume; the current `tabCapture`
   engine can only control the *active* tab, so a background Meet is
   uncontrollable.
2. **Mute button feels fake** — it toggles the extension's own `volumes[tabId]`
   state (mute conflated with volume 0), not the tab's real native mute. Muting
   via Chrome's own tab icon desyncs the button.
3. **Mixer rows jump** — the list re-sorts audible/louder tabs to the top on
   every audio change, and rebuilds the whole DOM each event, causing reordering
   and slider-drag interruption.

Overarching goal: make the core functionality genuinely reliable, then expand to
other browsers.

## Decisions (from brainstorming)

- **Multi-tab volume is top priority** → the engine must control many audio tabs
  simultaneously, including background ones.
- **Engine: content-script Web Audio injection** (NOT tabCapture). tabCapture is
  fundamentally incompatible with controlling background tabs (Chrome only lets
  you capture a tab the user actively invoked the extension on). Injection is how
  Volume Master / Ears work and is the only approach that controls all tabs at
  once.
- **Mute stays native** (`chrome.tabs.update({muted})`) — browser-level, works on
  any tab, decoupled from volume.
- **Persistence is per-tab, tab-lifetime**: default 100% on first visit (no forced
  presets, no per-site memory); remember whatever the user sets for that tab
  across reloads/navigation/app-switches; clear only when the tab closes.
- **Extra feature in scope: global hotkeys only.** Per-site profiles, loudness
  normalization, and solo were considered and deferred (candidate paid features
  for later).
- **Browsers: Chrome first**, perfect functionality, then Chromium siblings
  (Brave/Edge/Opera — same code), Firefox last (separate port).
- **Build a Playwright self-test harness** for UI/logic regression (cannot verify
  real audio or Meet — no audio device / no login).

## Architecture

Three layers, each with one clear responsibility:

```
popup (mixer UI)  ──messages──▶  background (service worker)  ──▶  content scripts
  - render mixer                   - source of truth (storage)       injected.js (MAIN world)
  - stable ordering                - native mute                       - AudioContext gain patch
  - real mute state                - hotkey handling                   - media element volume override
  - in-place updates               - per-tab lifecycle                content.js (ISOLATED world)
                                                                        - bridge bg <-> injected
```

### Volume engine — `injected.js` (MAIN world, all frames, `document_start`)

The single mechanism that scales audio. Runs in the page so it controls audio in
real time, on every tab, background or not.

- **Web Audio path** — patch `AudioContext`/`webkitAudioContext` so each context's
  `destination` is routed through an inserted `GainNode` (`gain.value = volume`).
  This is what controls **Google Meet** (Meet plays remote audio through Web
  Audio), games, and Web-Audio-based players. `gain` supports boost > 1.0.
- **Media element path** — override `HTMLMediaElement.prototype.volume` so
  `actualVolume = requestedVolume * volume`, for plain `<audio>`/`<video>`
  (YouTube etc.). Track the site's requested value as `_reqVol` so the site's own
  volume UI still works.
- **Double-attenuation guard** — patch `AudioContext.prototype.createMediaElementSource`
  to tag any element routed into Web Audio (`el.__vmRouted = true`). The volume
  setter does NOT scale tagged elements (the downstream gain already does).
  Guarantees exactly one scaling point — this was the root of the old
  oscillation/`volume²` behavior.
- **Boost > 100% on plain media elements** — `HTMLMediaElement.volume` caps at
  1.0, so to boost a plain element we lazily route it through our own
  `MediaElementSourceNode → GainNode → destination` (only when it is not already
  site-routed). Web-Audio audio (Meet) boosts directly via the gain.
- **Re-apply triggers** — a `MutationObserver` applies volume to newly added
  media/audio nodes; a `play()` override applies to elements that never had
  `.volume` set. On reload, `volume` initializes synchronously from a per-tab
  `sessionStorage` cache (`__vmVol`) so there is no full-volume gap. (sessionStorage
  is per-browsing-context, so two tabs of the same origin do not collide.)
- **Exposed hooks** — `window.__vmApply(v)` and `window.__vmGains` so the service
  worker can also drive volume via `scripting.executeScript` as a fallback.

### Bridge — `content.js` (ISOLATED world, all frames, `document_start`)

Content scripts in the MAIN world cannot use `chrome.*`. `content.js` runs in the
isolated world and bridges:

- On load, asks background `getVolume` (keyed by `sender.tab.id`) and posts the
  result to `injected.js` via `window.postMessage`.
- Relays future volume updates from background to the page.

### State + orchestration — `background.js` (service worker)

Source of truth and lifecycle owner.

- **Storage** — `chrome.storage.local`, one entry per tab: `vol_<tabId> = { volume, muted }`.
  `volume` is a number (0–1.5, where 1.0 = 100%); `muted` is a boolean, tracked
  **independently** of volume so a tab can be "50% and muted" and unmute returns
  to 50%.
- **Apply volume** — push to the page (`content.js`/`executeScript`), and NOT tied
  to mute.
- **Mute** — `chrome.tabs.update(tabId, { muted })`. Native, real, works on any
  tab including restricted pages.
- **Per-tab lifecycle**:
  - `onRemoved` → delete `vol_<tabId>` (this is the only thing that clears a tab's
    setting — "remembered until the tab closes").
  - On navigation/reload (`onUpdated` status `complete` / audible change) →
    re-assert stored state for that tab (single `applyState(tabId)` path; mute and
    volume are idempotent to re-apply).
  - Startup → purge `vol_*` keys whose tabId no longer exists (tab ids are not
    stable across restart).
- **Hotkeys** — `chrome.commands.onCommand` handlers (see below).

### Mixer UI — `popup.js` / `popup.html` / `popup.css`

- **Stable ordering** — sort visible tabs **once** by `windowId` then tab-strip
  `index`; never re-sort on `audible` or volume. A row keeps its position for the
  tab's life.
- **In-place updates** — replace the current "rebuild entire `innerHTML` on every
  event" with a keyed diff by `tabId`: add new cards, remove closed ones, update
  fields (title, audible indicator, volume label/slider, mute state) on existing
  cards. Prevents flicker and does not interrupt an in-progress slider drag.
- **Real mute state** — the mute button reflects the tab's actual
  `mutedInfo.muted`. Subscribe to `onUpdated.mutedInfo` so muting via Chrome's own
  tab icon keeps the button in sync.
- Existing controls (per-tab slider, ◀/▶ steps, global slider + steps, pause,
  mute-all/boost-all/reset-all, remove/restore) are preserved and routed through
  the decoupled `{volume, muted}` model.

### Global hotkeys — `chrome.commands`

Declared in manifest, remappable at `chrome://extensions/shortcuts`:

- `toggle-mute` — mute/unmute the active tab (native).
- `volume-up` — active tab volume +10% (clamped to MAX 150%).
- `volume-down` — active tab volume −10% (clamped to 0%).

Handlers live in `background.js`, operate on the active tab, and write through the
same storage + apply path as the popup.

## Testing — Playwright self-test harness (`test/`)

- Launch Chrome via `launchPersistentContext` with
  `--load-extension` / `--disable-extensions-except` (headed; MV3 extensions need
  a real browser context).
- Open a controlled test page containing an `<audio>`/`<video>` element and an
  `AudioContext` tone generator.
- Open the extension popup page; **screenshot** it (lets the agent "see" the UI
  and catch layout/visual regressions).
- Drive controls: click mute → assert button state + `tabs.mutedInfo`; drag
  slider / click steps → assert the page's gain value and media element volume via
  an injected probe; verify stable ordering does not reorder on audible change.
- Collect and assert on service-worker + page console errors.

**Out of scope for automation (manual only):** real audible volume change (no
ears), Google Meet end-to-end (needs login, mic, second participant).

## Non-goals / explicitly deferred

- Per-site auto-profiles, auto loudness normalization, solo button, EQ, mono/
  balance — deferred; candidate paid features for a later Pro tier.
- Cross-restart persistence beyond tab lifetime — intentionally not kept (a closed
  tab forgets, by design).
- Firefox port — phase 3, separate spec.

## Phasing

- **P1 — Chrome (this spec):** injection engine, decoupled native mute, per-tab
  lifetime persistence, mixer stable ordering + in-place updates + real mute
  state, global hotkeys, Playwright harness.
- **P2 — Brave / Edge / Opera:** same build; test and list on their stores.
- **P3 — Firefox:** manifest + API port (easier than tabCapture would have been —
  injection needs no `offscreen`/`tabCapture`); own spec.

## Success criteria

- Two simultaneous audio tabs (e.g. two Meets, or Meet + YouTube) can each have
  their volume changed independently while both play, without arming/clicking into
  each.
- Setting a tab's volume/mute holds across reload, navigation, tab switches, app
  switches, and window focus changes, until the tab closes.
- Mute button always reflects the tab's real mute state, including external
  (Chrome tab-icon) mutes.
- Mixer rows never reorder due to audio changes; slider drags are not interrupted
  by background refreshes.
- Global hotkeys adjust the active tab without opening the popup.
- Playwright harness runs green (UI/logic) and produces a popup screenshot.

## Risks

- **Sites re-creating audio nodes / fighting volume** — mitigated by
  MutationObserver + `play()` override + re-assert on navigation. Some hostile
  sites may still transiently reset; injection is the industry-standard best
  effort.
- **`createMediaElementSource` one-shot** — an element can only be source-node'd
  once; boost routing must guard against double-wrapping and site-owned routing
  (checked via `__vmRouted`).
- **Restricted pages** (`chrome://`, Web Store) — no injection possible; volume is
  N/A there, native mute still works. Surface this state in the UI.

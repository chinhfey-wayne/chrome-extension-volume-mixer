// injected.js — MAIN world. The single place page audio volume is scaled.
(function () {
  const clamp01 = v => Math.max(0, Math.min(1, v));

  // Per-tab volume, cached per browsing context so a reload re-applies instantly.
  let volume = (() => {
    try { return parseFloat(sessionStorage.getItem('__vmVol') || '1') || 1.0; }
    catch (_) { return 1.0; }
  })();

  const gainNodes = [];
  window.__vmGains = gainNodes;

  // ---- AudioContext: route destination through our gain (covers Google Meet, games) ----
  const OrigCtx = window.AudioContext || window.webkitAudioContext;
  if (OrigCtx) {
    const OrigBase = window.BaseAudioContext || OrigCtx;
    const destDesc = Object.getOwnPropertyDescriptor(OrigBase.prototype, 'destination');
    const origDestGetter = destDesc && destDesc.get;
    const origCreateMES = OrigCtx.prototype.createMediaElementSource;

    if (origDestGetter) {
      function PatchedAudioContext(...args) {
        const ctx = new OrigCtx(...args);
        const realDest = origDestGetter.call(ctx);
        const gain = OrigCtx.prototype.createGain.call(ctx);
        gain.gain.value = volume;
        gain.connect(realDest);
        gainNodes.push(gain);
        Object.defineProperty(ctx, 'destination', { get: () => gain, configurable: true });
        return ctx;
      }
      PatchedAudioContext.prototype = OrigCtx.prototype;
      Object.setPrototypeOf(PatchedAudioContext, OrigCtx);
      window.AudioContext = PatchedAudioContext;
      if (window.webkitAudioContext) window.webkitAudioContext = PatchedAudioContext;
    }

    // Tag any element the site routes into Web Audio so we never double-scale it.
    if (origCreateMES) {
      OrigCtx.prototype.createMediaElementSource = function (el) {
        try { if (el) el.__vmRouted = true; } catch (_) {}
        return origCreateMES.call(this, el);
      };
    }
  }

  // ---- HTMLMediaElement.volume override (covers plain <audio>/<video>) ----
  const volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  if (volDesc) {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      get() { return this._reqVol ?? volDesc.get.call(this); },
      set(v) { this._reqVol = v; applyToElement(this); },
      configurable: true,
    });

    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (this._reqVol === undefined) this._reqVol = volDesc.get.call(this);
      applyToElement(this);
      return origPlay.apply(this, args);
    };
  }

  function applyToElement(el) {
    if (!volDesc) return;
    const req = el._reqVol ?? 1.0;
    // Routed into Web Audio by the site (not by us) → the gain scales it.
    if (el.__vmRouted && !el.__vmBoost) { volDesc.set.call(el, clamp01(req)); return; }
    if (volume > 1.0) {
      // Boost: element caps at 1.0; the extra gain comes from our own node.
      volDesc.set.call(el, clamp01(req));
      ensureBoost(el);
      if (el.__vmBoost) el.__vmBoost.gain.value = volume;
    } else if (el.__vmBoost) {
      // We routed it earlier for boost; keep controlling via our gain.
      el.__vmBoost.gain.value = volume;
    } else {
      volDesc.set.call(el, clamp01(req * volume));
    }
  }

  // Lazily route a plain element through our own gain so volume can exceed 100%.
  let boostCtx = null;
  function ensureBoost(el) {
    if (el.__vmBoost || !OrigCtx) return;
    try {
      boostCtx = boostCtx || new OrigCtx();
      const src = boostCtx.createMediaElementSource(el); // one-shot; site must not re-route
      const g = boostCtx.createGain();
      g.gain.value = volume;
      src.connect(g); g.connect(boostCtx.destination);
      el.__vmRouted = true;
      el.__vmBoost = g;
    } catch (_) { /* already source-node'd by the site; leave as-is */ }
  }

  function applyVolume(v) {
    volume = v;
    try { sessionStorage.setItem('__vmVol', String(v)); } catch (_) {}
    gainNodes.forEach(g => { try { g.gain.value = v; } catch (_) {} });
    document.querySelectorAll('audio, video').forEach(applyToElement);
  }
  window.__vmApply = applyVolume;

  // Apply to media/audio elements added after load.
  const observer = new MutationObserver(muts => {
    if (volume === 1.0) return;
    for (const m of muts) for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches && node.matches('audio, video')) applyToElement(node);
      if (node.querySelectorAll) node.querySelectorAll('audio, video').forEach(applyToElement);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Message bridge from content.js.
  window.addEventListener('message', e => {
    if (!e.data || !e.data.__vm__ || e.source !== window) return;
    if (e.data.action === 'setVolume') applyVolume(e.data.volume);
    if (e.data.action === 'pause') document.querySelectorAll('audio, video').forEach(el => { try { el.pause(); } catch (_) {} });
    if (e.data.action === 'play')  document.querySelectorAll('audio, video').forEach(el => { try { el.play().catch(() => {}); } catch (_) {} });
  });
})();

// Runs in MAIN (page) world — overrides AudioContext and HTMLMediaElement
(function () {
  let volume = (() => {
    try { return parseFloat(sessionStorage.getItem('__vmVol') || '1') || 1.0; } catch (_) { return 1.0; }
  })();
  const gainNodes = [];
  window.__vmGains = gainNodes; // exposed so background executeScript can reach it

  // --- AudioContext intercept ---
  const OrigCtx = window.AudioContext || window.webkitAudioContext;
  if (OrigCtx) {
    // `destination` lives on BaseAudioContext.prototype, not AudioContext.prototype
    const OrigBase = window.BaseAudioContext || OrigCtx;
    const origDestGetter = Object.getOwnPropertyDescriptor(OrigBase.prototype, 'destination').get;

    function PatchedAudioContext(...args) {
      const ctx = new OrigCtx(...args);
      const realDest = origDestGetter.call(ctx);
      const gain = OrigCtx.prototype.createGain.call(ctx);
      gain.gain.value = volume;
      gain.connect(realDest);
      gainNodes.push(gain);

      Object.defineProperty(ctx, 'destination', {
        get: () => gain,
        configurable: true,
      });

      return ctx;
    }

    PatchedAudioContext.prototype = OrigCtx.prototype;
    Object.setPrototypeOf(PatchedAudioContext, OrigCtx);
    window.AudioContext = PatchedAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = PatchedAudioContext;
  }

  // --- HTMLMediaElement intercept ---
  const origVolDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
  if (origVolDesc) {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      get() {
        return this._reqVol ?? origVolDesc.get.call(this);
      },
      set(v) {
        this._reqVol = v;
        origVolDesc.set.call(this, clamp(v * volume));
      },
      configurable: true,
    });
  }

  // Intercept play() so new elements that never had .volume set still respect our volume
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (this._reqVol === undefined) {
      origVolDesc.set.call(this, clamp(volume));
    }
    return origPlay.apply(this, args);
  };

  function clamp(v) {
    return Math.max(0, Math.min(1, v));
  }

  function applyVolume(v) {
    volume = v;
    try { sessionStorage.setItem('__vmVol', String(v)); } catch (_) {}
    gainNodes.forEach(g => {
      try { g.gain.value = v; } catch (_) {}
    });
    document.querySelectorAll('audio, video').forEach(el => {
      const req = el._reqVol ?? 1.0;
      origVolDesc.set.call(el, clamp(req * v));
    });
  }

  window.__vmApply = applyVolume;

  // Watch for new audio/video elements added to DOM — apply volume immediately
  const observer = new MutationObserver(mutations => {
    if (volume === 1.0) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const els = [];
        if (node.matches && node.matches('audio, video')) els.push(node);
        node.querySelectorAll && node.querySelectorAll('audio, video').forEach(el => els.push(el));
        els.forEach(el => {
          origVolDesc.set.call(el, clamp((el._reqVol ?? 1.0) * volume));
        });
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Continuous enforcement — corrects any drift every 500ms regardless of site code
  setInterval(() => {
    if (volume === 1.0) return;
    gainNodes.forEach(g => {
      try { if (Math.abs(g.gain.value - volume) > 0.001) g.gain.value = volume; } catch (_) {}
    });
    document.querySelectorAll('audio, video').forEach(el => {
      const expected = clamp((el._reqVol ?? 1.0) * volume);
      try {
        if (Math.abs(origVolDesc.get.call(el) - expected) > 0.01) {
          origVolDesc.set.call(el, expected);
        }
      } catch (_) {}
    });
  }, 500);

  window.addEventListener('message', e => {
    if (!e.data || !e.data.__vm__ || e.source !== window) return;
    if (e.data.action === 'setVolume') applyVolume(e.data.volume);
    if (e.data.action === 'pause') document.querySelectorAll('audio, video').forEach(el => el.pause());
    if (e.data.action === 'play')  document.querySelectorAll('audio, video').forEach(el => el.play().catch(() => {}));
  });
})();

// Runs in MAIN (page) world — overrides AudioContext and HTMLMediaElement
(function () {
  let volume = 1.0;
  const gainNodes = [];

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

  function clamp(v) {
    return Math.max(0, Math.min(1, v));
  }

  function applyVolume(v) {
    volume = v;
    gainNodes.forEach(g => {
      try { g.gain.value = v; } catch (_) {}
    });
    document.querySelectorAll('audio, video').forEach(el => {
      const req = el._reqVol ?? 1.0;
      origVolDesc.set.call(el, clamp(req * v));
    });
  }

  window.addEventListener('message', e => {
    if (e.source === window && e.data && e.data.__vm__) {
      applyVolume(e.data.volume);
    }
  });
})();

// Offscreen document — owns the Web Audio graph for every captured tab.
//
// Per tab:  tabStream ──source──▶ gain ──▶ ctx.destination (speakers)
//
// The gain node is the ONE and ONLY place volume is scaled. The page can't
// touch it — the audio has already left the tab and is flowing through us.
// So volume never drifts and there is no enforcement loop to throttle.

const captures = new Map(); // tabId -> { stream, ctx, source, gain }
const starting = new Map(); // tabId -> Promise (in-flight startOrUpdate, prevents dup streams)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'startOrUpdate') {
    startOrUpdate(msg.tabId, msg.streamId, msg.volume)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }

  if (msg.type === 'setGain') {
    const cap = captures.get(msg.tabId);
    if (cap) cap.gain.gain.value = msg.volume;
    sendResponse({ ok: !!cap });
    return false;
  }

  if (msg.type === 'stop') {
    stop(msg.tabId);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'isCapturing') {
    sendResponse({ capturing: captures.has(msg.tabId) });
    return false;
  }
});

async function startOrUpdate(tabId, streamId, volume) {
  const existing = captures.get(tabId);
  if (existing) {
    existing.gain.gain.value = volume;
    return;
  }
  // A start is already in flight for this tab (rapid slider drag) — wait for it,
  // then just set the gain. Prevents creating duplicate streams/contexts.
  if (starting.has(tabId)) {
    await starting.get(tabId);
    const cap = captures.get(tabId);
    if (cap) cap.gain.gain.value = volume;
    return;
  }

  const job = (async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  const ctx = new AudioContext();
  // Offscreen docs have no user gesture — the context can start suspended,
  // which means zero audio flows. Force it running.
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain);
  gain.connect(ctx.destination);

  // If the tab closes, the track ends — clean up so we don't leak contexts.
  stream.getAudioTracks().forEach(t => {
    t.addEventListener('ended', () => stop(tabId));
  });

  captures.set(tabId, { stream, ctx, source, gain });
  })();

  starting.set(tabId, job);
  try { await job; } finally { starting.delete(tabId); }
}

function stop(tabId) {
  const cap = captures.get(tabId);
  if (!cap) return;
  try { cap.source.disconnect(); } catch (_) {}
  try { cap.gain.disconnect(); } catch (_) {}
  try { cap.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { cap.ctx.close(); } catch (_) {}
  captures.delete(tabId);
}

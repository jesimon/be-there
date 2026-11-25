// Shared by every page: the secret link, the live connection to the server,
// and a gentle chime. The video connection between the two devices is in
// peer.js; makePeer below is the earlier version, kept because a browser can
// still pair an older, cached page script with this file.

// Each link carries its secret after the #, which browsers never send to servers.
export function tokenFromLink() {
  return decodeURIComponent(location.hash.replace(/^#/, '').trim());
}

// The link's secret, remembered on this device so a bookmark or a link that
// lost its # part still works here. Forgotten when the server refuses it.
export function rememberedToken(kind) {
  const key = `bethere.${kind}`;
  const fromLink = tokenFromLink();
  try {
    if (fromLink) localStorage.setItem(key, fromLink);
    else {
      const saved = localStorage.getItem(key) || '';
      // Put it back in the address bar so a bookmark made now includes it.
      if (saved) history.replaceState(null, '', `${location.pathname}#${saved}`);
      return saved;
    }
  } catch { /* storage unavailable: use the link only */ }
  return fromLink;
}
export function forgetToken(kind) {
  try { localStorage.removeItem(`bethere.${kind}`); } catch { /* ignore */ }
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

export async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(pathname, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Something went wrong (${res.status}).`), { status: res.status });
  return data;
}

let configPromise;
export function getConfig() {
  configPromise ||= api('/api/config').catch(() => ({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], dropInNoticeSeconds: 8 }));
  return configPromise;
}

// A connection to the server that reconnects by itself (Wi-Fi drops, tablets
// sleep). onMessage gets each message; onState gets 'open' or 'closed'.
// A close code of 4001–4003 means the link no longer works: we stop trying.
export function connect({ role, token, onMessage, onState, onRejected }) {
  let ws;
  let stopped = false;
  let delay = 1000;
  let retry = null;
  const open = () => {
    clearTimeout(retry);
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      delay = 1000;
      ws.send(JSON.stringify({ type: 'hello', role, token, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
      onState?.('open');
    };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
    };
    ws.onclose = (e) => {
      onState?.('closed');
      if (stopped) return;
      if (e.code >= 4001 && e.code <= 4004) { stopped = true; onRejected?.(e.code, e.reason); return; }
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 15_000);
    };
  };
  open();
  // A tablet that slept may hold a dead connection: when it wakes, reconnect
  // at once instead of waiting for the next retry.
  document.addEventListener('visibilitychange', () => {
    if (stopped || document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) { delay = 1000; open(); }
  });
  return {
    send: (msg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); },
    close: () => { stopped = true; ws?.close(); },
  };
}

export async function getCamera() {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

export function stopStream(stream) {
  for (const t of stream?.getTracks() || []) t.stop();
}

// The video link between the two devices. The visitor makes the offer; the
// home screen answers. Messages pass through the server only to introduce them.
export async function makePeer({ stream, sendSignal, onRemote, onConnectionChange, offerer }) {
  const { iceServers } = await getConfig();
  const pc = new RTCPeerConnection({ iceServers });
  for (const track of stream.getTracks()) pc.addTrack(track, stream);
  const remote = new MediaStream();
  pc.ontrack = (e) => {
    for (const t of e.streams[0]?.getTracks() || [e.track]) if (!remote.getTracks().includes(t)) remote.addTrack(t);
    onRemote(remote);
  };
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => onConnectionChange?.(pc.connectionState);

  const pending = [];
  async function handleSignal(data) {
    if (!data) return;
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      while (pending.length) await pc.addIceCandidate(pending.shift()).catch(() => {});
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        sendSignal({ sdp: pc.localDescription.toJSON() });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else pending.push(data.candidate);
    }
  }
  if (offerer) {
    await pc.setLocalDescription(await pc.createOffer());
    sendSignal({ sdp: pc.localDescription.toJSON() });
  }
  return { pc, handleSignal, close: () => pc.close() };
}

// A soft two-note chime, so the person at home always hears that someone is
// coming. Browsers allow sound only after a first tap on the page.
let audioCtx;
export function unlockSound() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* no sound available */ }
}
export function chime() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [[659.25, 0], [523.25, 0.35]].forEach(([freq, at]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.35, now + at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.9);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + at);
    osc.stop(now + at + 1);
  });
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) { const old = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = old; }, 1500); }
  } catch {
    window.prompt('Copy this link:', text);
  }
}

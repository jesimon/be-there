// How the two devices find each other, and the relay for when they can't.
//
// A visit first tries a direct connection, helped only by a public "STUN"
// server (it tells a device its own public address and nothing else). On
// strict networks (mobile data, some home routers, most workplaces) that
// fails. Then, and only then, this server asks Cloudflare for short-lived
// relay ("TURN") credentials for that one visit and gives them to its two
// devices. The picture and sound then pass through Cloudflare's relay, still
// encrypted between the two devices; they never pass through this server.
//
// Nothing here does I/O on import: the environment, fetch and timeouts are
// passed in, so the tests can fake them.

export const PUBLIC_STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }];

const CLOUDFLARE = 'https://rtc.live.cloudflare.com';
const DEFAULT_TTL = 43_200;      // 12 hours: longer than any visit
const MIN_TTL = 600;
const MAX_TTL = 172_800;         // Cloudflare's own limit (48 hours)
const MAX_CREDENTIAL_BYTES = 509;

// Ports browsers refuse to talk to (the Fetch standard's list, plus 0).
// iPhones and iPads drop such an address and then throw if a server is left
// with none, and port 53 simply times out in Chrome.
const BLOCKED_PORTS = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513,
  514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

// Only the exact shapes every browser accepts. WebKit (every browser on an
// iPhone or iPad) throws on a STUN address with a query, and on a TURN address
// whose query is anything but a single transport=udp or transport=tcp.
const HOST = '([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\\[[0-9A-Fa-f:.]+\\])';
const STUN_URL = new RegExp(`^stun:${HOST}(?::(\\d{1,5}))?$`);
const TURN_URL = new RegExp(`^turns?:${HOST}(?::(\\d{1,5}))?(?:\\?transport=(?:udp|tcp))?$`);

// 'stun', 'turn' or null (not safe to hand to a browser).
function urlKind(url) {
  if (typeof url !== 'string' || url.length > 255) return null;
  const stun = STUN_URL.exec(url);
  const m = stun || TURN_URL.exec(url);
  if (!m) return null;
  if (/\.local$/i.test(m[1])) return null;
  if (m[2] !== undefined && (Number(m[2]) > 65_535 || BLOCKED_PORTS.has(Number(m[2])))) return null;
  return stun ? 'stun' : 'turn';
}

const urlsOf = (server) => (Array.isArray(server?.urls) ? server.urls : [server?.urls]);
const usable = (text) => typeof text === 'string' && text.length > 0 && Buffer.byteLength(text, 'utf8') <= MAX_CREDENTIAL_BYTES;

// The list anyone may see (GET /api/config): STUN only, never a relay and
// never a credential, whatever ICE_SERVERS holds.
export function publicIceServers(env = {}) {
  let list = null;
  try { list = JSON.parse(env.ICE_SERVERS || 'null'); } catch { /* fall through to the default */ }
  const out = [];
  for (const server of Array.isArray(list) ? list : []) {
    if (!server || typeof server !== 'object' || server.username != null || server.credential != null) continue;
    const urls = urlsOf(server).filter((u) => urlKind(u) === 'stun');
    if (urls.length) out.push({ urls });
  }
  return out.length ? out : PUBLIC_STUN.map((s) => ({ ...s }));
}

// The relay's settings, or null when it is not set up. The values must look
// like a real Cloudflare TURN key: leftover placeholder text in the service's
// settings must never be sent anywhere as if it were a key.
export function relaySettings(env = {}) {
  const keyId = String(env.TURN_KEY_ID ?? '').trim();
  const apiToken = String(env.TURN_API_TOKEN ?? '').trim();
  if (!/^[a-z0-9]{32}$/i.test(keyId) || !/^[a-z0-9_-]{40,}$/i.test(apiToken)) return null;
  const asked = Math.floor(Number(String(env.TURN_TTL_SECONDS ?? '').trim() || DEFAULT_TTL));
  const ttl = Number.isFinite(asked) ? Math.min(MAX_TTL, Math.max(MIN_TTL, asked)) : DEFAULT_TTL;
  return { keyId, apiToken, ttl };
}

// Turns Cloudflare's answer into a list that is safe to give to any browser.
// Accepts today's shape (a list) and the older one (a single object). Keeps
// only known fields, and drops whatever would make an iPhone or iPad throw:
// odd addresses, blocked ports, relay addresses without a usable username and
// password, and servers left with no address at all.
export function cleanIceServers(body) {
  const raw = body && body.iceServers;
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out = [];
  for (const server of list) {
    if (!server || typeof server !== 'object') continue;
    const withLogin = usable(server.username) && usable(server.credential);
    const urls = urlsOf(server).filter((u) => {
      const kind = urlKind(u);
      return kind === 'stun' || (kind === 'turn' && withLogin);
    });
    if (!urls.length) continue;
    const isRelay = urls.some((u) => urlKind(u) === 'turn');
    out.push(isRelay ? { urls, username: server.username, credential: server.credential } : { urls });
  }
  return out;
}

// Runs `work` but gives up after `ms`, even if fetch ignores the signal.
async function within(ms, work) {
  const stop = new AbortController();
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => { stop.abort(); reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); }, ms);
  });
  try {
    return await Promise.race([work(stop.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

// An answer we will not read: let go of it so the connection is freed.
const discard = async (res) => { try { await res.body?.cancel(); } catch { /* nothing to free */ } };

const endpoint = (settings, rest) => `${CLOUDFLARE}/v1/turn/keys/${encodeURIComponent(settings.keyId)}/credentials/${rest}`;

// Asks Cloudflare for relay credentials that last settings.ttl seconds.
// Never throws: { ok: true, iceServers, username } or { ok: false, reason }.
// The username is kept only so the credentials can be revoked afterwards.
export async function mintRelay(settings, { fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  if (!settings) return { ok: false, reason: 'not_set_up' };
  try {
    return await within(timeoutMs, async (signal) => {
      const res = await fetchImpl(endpoint(settings, 'generate-ice-servers'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: settings.ttl }),
        signal,
      });
      // Cloudflare answers 201; any 2xx will do.
      if (!res.ok) {
        await discard(res);
        return { ok: false, reason: `http_${res.status}` };
      }
      let body;
      try { body = await res.json(); } catch (err) {
        if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw err;
        return { ok: false, reason: 'bad_response' };
      }
      const iceServers = cleanIceServers(body);
      const relay = iceServers.find((s) => s.username);
      if (!relay) return { ok: false, reason: 'bad_response' };
      return { ok: true, iceServers, username: relay.username };
    });
  } catch (err) {
    return { ok: false, reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

// Makes relay credentials stop working (when a visit ends). Best effort: it
// never throws and never logs, since the username would say when a visit was.
export async function revokeRelay(settings, username, { fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  if (!settings || typeof username !== 'string' || !username) return false;
  try {
    return await within(timeoutMs, async (signal) => {
      const res = await fetchImpl(endpoint(settings, `${encodeURIComponent(username)}/revoke`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiToken}` },
        signal,
      });
      await discard(res);
      return !!res.ok;
    });
  } catch {
    return false;
  }
}

// What the server uses. Tests pass createApp({ relay }) a fake of this shape.
export function createRelay({ env = {}, fetchImpl } = {}) {
  const settings = relaySettings(env);
  const options = fetchImpl ? { fetchImpl } : {};
  return {
    ready: !!settings,
    ttl: settings ? settings.ttl : 0,
    // { ttl } overrides the usual lifetime (the organizer's test uses a short one).
    mint: ({ ttl } = {}) => mintRelay(settings && ttl ? { ...settings, ttl } : settings, options),
    revoke: (username) => revokeRelay(settings, username, options),
  };
}

// Who may visit, and when. Pure functions: no I/O, so they are easy to test.
//
// The person at home is in charge. A visitor can reach them only when:
//   - the person at home has approved that visitor (organizers can invite
//     people, but nobody can visit until the person at home says yes),
//   - visits are not paused,
//   - it is within the home's visiting hours, in the home's own time zone,
//   - the home screen is switched on and nobody else is already visiting.
// A visitor who may "come straight in" still gets a few seconds' notice on the
// home screen, which the person at home can refuse.

export const MODES = ['knock', 'dropin'];
export const DROP_IN_NOTICE_SECONDS = 8;

export function cleanName(value, max = 60) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// "08:00" -> minutes since midnight, or null if malformed.
export function parseTime(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function cleanHours(hours) {
  const start = parseTime(hours?.start);
  const end = parseTime(hours?.end);
  if (start === null || end === null) return { start: '08:00', end: '21:00' };
  return { start: hours.start, end: hours.end };
}

export function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0 && tz.length < 64;
  } catch {
    return false;
  }
}

// Minutes since midnight at `now` in time zone `tz`.
export function localMinutes(now, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: validTimeZone(tz) ? tz : 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

export function withinHours(hours, tz, now = new Date()) {
  const { start, end } = cleanHours(hours);
  const s = parseTime(start);
  const e = parseTime(end);
  // The same start and end (e.g. 12:00 AM to 12:00 AM) means any time of day.
  if (s === e) return true;
  const t = localMinutes(now, tz);
  // A window such as 20:00–02:00 wraps past midnight.
  return s < e ? t >= s && t < e : t >= s || t < e;
}

// Why a visitor can or cannot visit right now. `live` is the server's view of
// the home screen: { online, busyWith } (busyWith = id of the current visitor).
export function visitStatus(home, visitor, live = {}, now = new Date()) {
  if (!visitor || visitor.removed) return { ok: false, reason: 'removed' };
  if (!visitor.approved) return { ok: false, reason: 'awaiting_approval' };
  if (home.paused) return { ok: false, reason: 'paused' };
  if (!withinHours(home.hours, home.timeZone, now)) return { ok: false, reason: 'outside_hours' };
  if (!live.online) return { ok: false, reason: 'offline' };
  if (live.busyWith && live.busyWith !== visitor.id) return { ok: false, reason: 'busy' };
  return { ok: true, reason: 'available', mode: MODES.includes(visitor.mode) ? visitor.mode : 'knock' };
}

export const REASON_TEXT = {
  available: 'Available',
  removed: 'This link no longer works.',
  awaiting_approval: 'Waiting for them to say yes to your visits.',
  paused: 'Visits are paused right now.',
  outside_hours: 'Outside visiting hours.',
  offline: 'Their screen is switched off.',
  busy: 'Someone else is visiting right now.',
};

// What a visitor may see about the home: never the other visitors.
export function visitorView(home, visitor, live, now = new Date()) {
  const status = visitStatus(home, visitor, live, now);
  return {
    homeName: home.name,
    personName: home.personName,
    you: { name: visitor.name, mode: visitor.mode, approved: !!visitor.approved },
    hours: cleanHours(home.hours),
    timeZone: home.timeZone,
    status: status.reason,
    statusText: REASON_TEXT[status.reason],
    canVisit: status.ok,
  };
}

// What the home screen and organizers see.
export function homeView(home) {
  return {
    id: home.id,
    name: home.name,
    personName: home.personName,
    paused: !!home.paused,
    hours: cleanHours(home.hours),
    timeZone: home.timeZone,
    visitors: home.visitors.filter((v) => !v.removed).map((v) => ({
      id: v.id, name: v.name, relation: v.relation || '', approved: !!v.approved, mode: v.mode,
    })),
  };
}

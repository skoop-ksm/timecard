// Time arithmetic shared by the server and the browser.
// Everything here works in the *local* time zone of the process that runs it:
// the browser for the UI, the server only for the Shortcuts punch endpoint.

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export const ROUNDING_CHOICES = [0, 5, 10, 15, 30];

export const DEFAULT_SETTINGS = Object.freeze({
  hourlyRate: 0,
  currency: 'USD',
  periodType: 'monthly',      // 'monthly' | 'weekly' | 'biweekly'
  periodStartDay: 1,          // monthly: 1..31 (clamped to the month's length)
  periodStartWeekday: 1,      // weekly: 0 = Sunday .. 6 = Saturday
  periodAnchor: null,         // biweekly: 'YYYY-MM-DD' of any day a period started on
  roundingMinutes: 5,         // 0 = off
});

const pad = (n) => String(n).padStart(2, '0');

/** Snap a timestamp to a grid of `gridMinutes`, measured on the local clock. */
export function snap(ms, gridMinutes, mode = 'nearest') {
  if (!gridMinutes || gridMinutes <= 0) return ms;
  const grid = gridMinutes * MINUTE;
  const offset = new Date(ms).getTimezoneOffset() * MINUTE;
  const local = ms - offset;
  let snapped;
  if (mode === 'down') snapped = Math.floor(local / grid) * grid;
  else if (mode === 'up') snapped = Math.ceil(local / grid) * grid;
  else snapped = Math.round(local / grid) * grid;
  return snapped + offset;
}

export function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Add whole days, keeping the local wall-clock time (DST safe). */
export function addDays(ms, n) {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

export function isDayKey(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseDayKey(s));
}

function monthStart(year, month, day) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay)).getTime();
}

function weekStartOnOrBefore(dayMs, weekday) {
  const back = (new Date(dayMs).getDay() - weekday + 7) % 7;
  return addDays(dayMs, -back);
}

/** The pay period containing `ms`, as { start, end } with end exclusive. */
export function periodFor(ms, settings) {
  const day = startOfDay(ms);
  switch (settings.periodType) {
    case 'weekly': {
      const start = weekStartOnOrBefore(day, settings.periodStartWeekday ?? 1);
      return { start, end: addDays(start, 7) };
    }
    case 'biweekly': {
      const anchorKey = isDayKey(settings.periodAnchor) ? settings.periodAnchor : dayKey(day);
      const anchor = parseDayKey(anchorKey);
      let start = weekStartOnOrBefore(day, new Date(anchor).getDay());
      const weeks = Math.round((start - anchor) / (7 * DAY));
      if (((weeks % 2) + 2) % 2 !== 0) start = addDays(start, -7);
      return { start, end: addDays(start, 14) };
    }
    default: {
      const d = new Date(day);
      const startDay = Math.min(31, Math.max(1, settings.periodStartDay ?? 1));
      let start = monthStart(d.getFullYear(), d.getMonth(), startDay);
      if (day < start) start = monthStart(d.getFullYear(), d.getMonth() - 1, startDay);
      const s = new Date(start);
      return { start, end: monthStart(s.getFullYear(), s.getMonth() + 1, startDay) };
    }
  }
}

export const previousPeriod = (period, settings) => periodFor(period.start - 1, settings);
export const nextPeriod = (period, settings) => periodFor(period.end, settings);

export function entryDuration(entry, now = Date.now()) {
  return Math.max(0, (entry.stop ?? now) - entry.start);
}

/** "7h 40m" (whole minutes). */
export function formatHM(ms) {
  const minutes = Math.round(ms / MINUTE);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** "7:40" for CSV, or "7:40:05" with seconds for the live clock. */
export function formatClock(ms, withSeconds = false) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return withSeconds ? `${h}:${pad(m)}:${pad(s)}` : `${h}:${pad(m)}`;
}

export const hoursDecimal = (ms) => ms / HOUR;

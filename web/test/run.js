// Minimal test runner (works on any Node >= 16): node test/run.js
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  snap, periodFor, previousPeriod, nextPeriod, dayKey, parseDayKey,
  formatHM, formatClock, startOfDay, addDays, MINUTE, DAY,
} from '../shared/time.js';
import { Store, sanitizeSettings, ValidationError } from '../lib/store.js';
import { createServer } from '../server.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const local = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();

// time.js ------------------------------------------------------------------

test('snap down/up/nearest on a 5-minute grid', () => {
  const t = local(2026, 10, 28, 9, 2) + 30_000;
  assert.equal(snap(t, 5, 'down'), local(2026, 10, 28, 9, 0));
  assert.equal(snap(t, 5, 'up'), local(2026, 10, 28, 9, 5));
  assert.equal(snap(t, 5), local(2026, 10, 28, 9, 5), 'halfway rounds up');
  assert.equal(snap(local(2026, 10, 28, 9, 2), 5), local(2026, 10, 28, 9, 0));
  assert.equal(snap(local(2026, 10, 28, 9, 5), 5, 'up'), local(2026, 10, 28, 9, 5), 'on-grid stays');
  assert.equal(snap(t, 0, 'up'), t, 'rounding off is identity');
  assert.equal(snap(local(2026, 10, 28, 9, 29), 30, 'up'), local(2026, 10, 28, 9, 30));
});

test('monthly periods with start day 1', () => {
  const s = { periodType: 'monthly', periodStartDay: 1 };
  const p = periodFor(local(2026, 10, 15), s);
  assert.deepEqual(p, { start: local(2026, 10, 1), end: local(2026, 11, 1) });
  assert.deepEqual(previousPeriod(p, s), { start: local(2026, 9, 1), end: local(2026, 10, 1) });
  assert.deepEqual(nextPeriod(p, s), { start: local(2026, 11, 1), end: local(2026, 12, 1) });
});

test('monthly periods with start day 31 clamp to short months', () => {
  const s = { periodType: 'monthly', periodStartDay: 31 };
  // Feb 2026 has 28 days: the period starting "Jan 31" ends "Feb 28".
  assert.deepEqual(periodFor(local(2026, 2, 10), s), { start: local(2026, 1, 31), end: local(2026, 2, 28) });
  assert.deepEqual(periodFor(local(2026, 2, 28), s), { start: local(2026, 2, 28), end: local(2026, 3, 31) });
  assert.deepEqual(periodFor(local(2026, 3, 30), s), { start: local(2026, 2, 28), end: local(2026, 3, 31) });
});

test('monthly period with start day 15 and year boundary', () => {
  const s = { periodType: 'monthly', periodStartDay: 15 };
  assert.deepEqual(periodFor(local(2027, 1, 3), s), { start: local(2026, 12, 15), end: local(2027, 1, 15) });
});

test('weekly periods starting Monday', () => {
  const s = { periodType: 'weekly', periodStartWeekday: 1 };
  // 2026-10-28 is a Wednesday.
  assert.deepEqual(periodFor(local(2026, 10, 28), s), { start: local(2026, 10, 26), end: local(2026, 11, 2) });
  assert.deepEqual(periodFor(local(2026, 10, 26), s).start, local(2026, 10, 26), 'start day belongs to its own week');
  assert.deepEqual(periodFor(local(2026, 10, 25), s).start, local(2026, 10, 19), 'Sunday belongs to the previous week');
});

test('biweekly periods follow the anchor parity', () => {
  const s = { periodType: 'biweekly', periodAnchor: '2026-10-12' }; // a Monday
  assert.deepEqual(periodFor(local(2026, 10, 28), s), { start: local(2026, 10, 26), end: local(2026, 11, 9) });
  assert.deepEqual(periodFor(local(2026, 10, 20), s), { start: local(2026, 10, 12), end: local(2026, 10, 26) });
  assert.deepEqual(periodFor(local(2026, 9, 30), s), { start: local(2026, 9, 28), end: local(2026, 10, 12) }, 'before the anchor');
  const p = periodFor(local(2026, 10, 28), s);
  assert.equal(nextPeriod(previousPeriod(p, s), s).start, p.start);
});

test('day keys round-trip and formatting helpers', () => {
  assert.equal(dayKey(local(2026, 3, 7, 23, 59)), '2026-03-07');
  assert.equal(parseDayKey('2026-03-07'), local(2026, 3, 7));
  assert.equal(startOfDay(local(2026, 3, 7, 13, 4)), local(2026, 3, 7));
  assert.equal(addDays(local(2026, 3, 7), 1), local(2026, 3, 8));
  assert.equal(formatHM(7 * 60 * MINUTE + 40 * MINUTE), '7h 40m');
  assert.equal(formatHM(45 * MINUTE), '45m');
  assert.equal(formatHM(2 * 60 * MINUTE), '2h');
  assert.equal(formatClock(7 * 60 * MINUTE + 5 * MINUTE + 9_000, true), '7:05:09');
  assert.equal(formatClock(7 * 60 * MINUTE + 5 * MINUTE), '7:05');
});

// store.js -----------------------------------------------------------------

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timecard-test-'));
  return { dir, store: await new Store(path.join(dir, 'timecard.json')).load() };
}

test('store persists entries atomically and reloads', async () => {
  const { dir, store } = await tempStore();
  const a = await store.insertEntry({ start: 1000, stop: 2000 });
  const b = await store.insertEntry({ start: 3000 });
  assert.equal(store.runningEntry().id, b.id);
  await assert.rejects(store.insertEntry({ start: 4000 }), (e) => e instanceof ValidationError && e.status === 409);
  await assert.rejects(store.insertEntry({ start: 5000, stop: 5000 }), /after start/);
  await store.updateEntry(b.id, { stop: 4000 });
  await store.deleteEntry(a.id);
  await store.updateSettings({ hourlyRate: '21.5', currency: 'eur' });

  const again = await new Store(path.join(dir, 'timecard.json')).load();
  assert.deepEqual(again.listEntries().map((e) => [e.id, e.start, e.stop]), [[b.id, 3000, 4000]]);
  assert.equal(again.getSettings().hourlyRate, 21.5);
  assert.equal(again.getSettings().currency, 'EUR');
  assert.equal(again.getSettings().roundingMinutes, 5, 'defaults fill in');
  const files = await fs.readdir(dir);
  assert.deepEqual(files, ['timecard.json'], 'no temp file left behind');
  await fs.rm(dir, { recursive: true });
});

test('settings validation rejects bad values', () => {
  assert.throws(() => sanitizeSettings({ roundingMinutes: 7 }), /roundingMinutes/);
  assert.throws(() => sanitizeSettings({ periodType: 'daily' }), /periodType/);
  assert.throws(() => sanitizeSettings({ periodStartDay: 0 }), /periodStartDay/);
  assert.throws(() => sanitizeSettings({ periodAnchor: 'yesterday' }), /periodAnchor/);
  assert.throws(() => sanitizeSettings({ hourlyRate: -1 }), /hourlyRate/);
  assert.deepEqual(sanitizeSettings({ hourlyRate: 10.005, unknown: 1 }), { hourlyRate: 10.01 });
});

// server.js ----------------------------------------------------------------

function request(base, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? safeJson(text) : null, text }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const safeJson = (t) => { try { return JSON.parse(t); } catch { return t; } };

test('HTTP API: punch flow, edits, settings, static files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timecard-test-'));
  process.env.TIMECARD_TOKEN = '';
  const server = await createServer({ dataFile: path.join(dir, 'timecard.json') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await request(base, 'GET', '/api/state');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.entries, []);
    assert.equal(r.body.settings.periodType, 'monthly');

    r = await request(base, 'POST', '/api/entries', { start: 1_000_000 });
    assert.equal(r.status, 201);
    const id = r.body.id;
    r = await request(base, 'POST', '/api/entries', { start: 2_000_000 });
    assert.equal(r.status, 409);
    r = await request(base, 'PATCH', `/api/entries/${id}`, { stop: 900_000 });
    assert.equal(r.status, 400);
    r = await request(base, 'PATCH', `/api/entries/${id}`, { stop: 1_900_000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.stop, 1_900_000);

    r = await request(base, 'POST', '/api/punch', { action: 'in', at: local(2026, 10, 28, 9, 2) });
    assert.equal(r.status, 201);
    assert.equal(r.body.entry.start, local(2026, 10, 28, 9, 0), 'punch in rounds down');
    r = await request(base, 'POST', '/api/punch', { action: 'in' });
    assert.equal(r.status, 409);
    r = await request(base, 'POST', '/api/punch', { action: 'out', at: local(2026, 10, 28, 12, 31) });
    assert.equal(r.status, 200);
    assert.equal(r.body.entry.stop, local(2026, 10, 28, 12, 35), 'punch out rounds up');
    r = await request(base, 'POST', '/api/punch', { action: 'out' });
    assert.equal(r.status, 409);

    r = await request(base, 'PUT', '/api/settings', { hourlyRate: 30, periodType: 'weekly', periodStartWeekday: 0 });
    assert.equal(r.status, 200);
    assert.equal(r.body.periodStartWeekday, 0);
    r = await request(base, 'PUT', '/api/settings', { roundingMinutes: 3 });
    assert.equal(r.status, 400);
    r = await request(base, 'POST', '/api/entries', 'not json');
    assert.equal(r.status, 400);

    r = await request(base, 'DELETE', `/api/entries/${id}`);
    assert.equal(r.status, 204);
    r = await request(base, 'DELETE', `/api/entries/${id}`);
    assert.equal(r.status, 404);
    r = await request(base, 'GET', '/api/state');
    assert.equal(r.body.entries.length, 1);

    r = await request(base, 'GET', '/api/backup');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /attachment/);

    r = await request(base, 'GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    r = await request(base, 'GET', '/shared/time.js');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /javascript/);
    r = await request(base, 'GET', '/../server.js');
    assert.equal(r.status, 404);
    r = await request(base, 'GET', '/shared/../server.js');
    assert.equal(r.status, 404);
    r = await request(base, 'GET', '/nope.txt');
    assert.equal(r.status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true });
  }
});

test('HTTP API: punch endpoint honours TIMECARD_TOKEN', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'timecard-test-'));
  process.env.TIMECARD_TOKEN = 'secret';
  // The token is read at import time; re-import a fresh copy of the module.
  const { createServer: fresh } = await import(`../server.js?token=${Date.now()}`);
  const server = await fresh({ dataFile: path.join(dir, 'timecard.json') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await request(base, 'POST', '/api/punch', { action: 'in' });
    assert.equal(r.status, 401);
    r = await request(base, 'POST', '/api/punch', { action: 'in' }, { Authorization: 'Bearer secret' });
    assert.equal(r.status, 201);
    r = await request(base, 'GET', '/api/state');
    assert.equal(r.status, 200, 'the rest of the API is left to the reverse proxy');
  } finally {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true });
    process.env.TIMECARD_TOKEN = '';
  }
});

// Runner -------------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n${err.stack || err}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

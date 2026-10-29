// Single-file JSON store with atomic writes. The data set of a punch clock is
// a few entries per day, so one file is plenty; the interface is small enough
// to swap for SQLite or a sync backend later.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, ROUNDING_CHOICES, isDayKey } from '../shared/time.js';

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, nextId: 1, settings: { ...DEFAULT_SETTINGS }, entries: [] };
    this._writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = {
        version: 1,
        nextId: raw.nextId || 1,
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
        entries: Array.isArray(raw.entries) ? raw.entries : [],
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
    }
    return this;
  }

  /** Serialize writes; write to a temp file and rename so a crash never leaves a torn file. */
  save() {
    this._writeQueue = this._writeQueue.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 1));
      await fs.rename(tmp, this.file);
    });
    return this._writeQueue;
  }

  // Entries ---------------------------------------------------------------

  listEntries() {
    return [...this.data.entries].sort((a, b) => a.start - b.start);
  }

  getEntry(id) {
    return this.data.entries.find((e) => e.id === id) || null;
  }

  runningEntry() {
    return this.data.entries.find((e) => e.stop == null) || null;
  }

  async insertEntry({ start, stop = null }) {
    const fields = validateTimes(start, stop);
    if (fields.stop == null && this.runningEntry()) {
      throw new ValidationError('An entry is already running.', 409);
    }
    const now = Date.now();
    const entry = { id: this.data.nextId++, ...fields, createdAt: now, updatedAt: now };
    this.data.entries.push(entry);
    await this.save();
    return entry;
  }

  async updateEntry(id, patch) {
    const entry = this.getEntry(id);
    if (!entry) throw new ValidationError('No such entry.', 404);
    const start = 'start' in patch ? patch.start : entry.start;
    const stop = 'stop' in patch ? patch.stop : entry.stop;
    const fields = validateTimes(start, stop);
    if (fields.stop == null) {
      const running = this.runningEntry();
      if (running && running.id !== id) throw new ValidationError('Another entry is already running.', 409);
    }
    Object.assign(entry, fields, { updatedAt: Date.now() });
    await this.save();
    return entry;
  }

  async deleteEntry(id) {
    const i = this.data.entries.findIndex((e) => e.id === id);
    if (i === -1) throw new ValidationError('No such entry.', 404);
    const [removed] = this.data.entries.splice(i, 1);
    await this.save();
    return removed;
  }

  // Settings --------------------------------------------------------------

  getSettings() {
    return { ...this.data.settings };
  }

  async updateSettings(patch) {
    const next = { ...this.data.settings, ...sanitizeSettings(patch) };
    this.data.settings = next;
    await this.save();
    return { ...next };
  }
}

function validateTimes(start, stop) {
  if (!Number.isInteger(start) || start < 0) throw new ValidationError('start must be a timestamp in milliseconds.');
  if (stop != null) {
    if (!Number.isInteger(stop) || stop < 0) throw new ValidationError('stop must be a timestamp in milliseconds or null.');
    if (stop <= start) throw new ValidationError('stop must be after start.');
  }
  return { start, stop: stop ?? null };
}

export function sanitizeSettings(patch) {
  if (!patch || typeof patch !== 'object') throw new ValidationError('settings must be an object.');
  const out = {};
  if ('hourlyRate' in patch) {
    const n = Number(patch.hourlyRate);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError('hourlyRate must be a non-negative number.');
    out.hourlyRate = Math.round(n * 100) / 100;
  }
  if ('currency' in patch) {
    const c = String(patch.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw new ValidationError('currency must be a 3-letter ISO code.');
    out.currency = c;
  }
  if ('periodType' in patch) {
    if (!['monthly', 'weekly', 'biweekly'].includes(patch.periodType)) throw new ValidationError('Unknown periodType.');
    out.periodType = patch.periodType;
  }
  if ('periodStartDay' in patch) {
    const n = Number(patch.periodStartDay);
    if (!Number.isInteger(n) || n < 1 || n > 31) throw new ValidationError('periodStartDay must be 1..31.');
    out.periodStartDay = n;
  }
  if ('periodStartWeekday' in patch) {
    const n = Number(patch.periodStartWeekday);
    if (!Number.isInteger(n) || n < 0 || n > 6) throw new ValidationError('periodStartWeekday must be 0..6.');
    out.periodStartWeekday = n;
  }
  if ('periodAnchor' in patch) {
    if (patch.periodAnchor != null && !isDayKey(patch.periodAnchor)) throw new ValidationError('periodAnchor must be YYYY-MM-DD.');
    out.periodAnchor = patch.periodAnchor ?? null;
  }
  if ('roundingMinutes' in patch) {
    const n = Number(patch.roundingMinutes);
    if (!ROUNDING_CHOICES.includes(n)) throw new ValidationError(`roundingMinutes must be one of ${ROUNDING_CHOICES.join(', ')}.`);
    out.roundingMinutes = n;
  }
  return out;
}

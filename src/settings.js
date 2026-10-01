import fs from 'node:fs';
import path from 'node:path';
import { badRequest } from './errors.js';

const ROBOTS_POLICIES = ['enforce', 'warn', 'off'];

/** Schema for options that can be changed while the service is running. */
const SCHEMA = {
  headless: { type: 'boolean' },
  fallbackToHeadless: { type: 'boolean' },
  robotsPolicy: { type: 'enum', values: ROBOTS_POLICIES },
  minIntervalMs: { type: 'int', min: 0, max: 600000 },
  cacheTtlSeconds: { type: 'int', min: 0, max: 86400 },
};

function coerce(key, value) {
  const spec = SCHEMA[key];
  switch (spec.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw badRequest(`Setting \`${key}\` must be a boolean.`);
    case 'enum':
      if (spec.values.includes(value)) return value;
      throw badRequest(`Setting \`${key}\` must be one of: ${spec.values.join(', ')}.`);
    case 'int': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        throw badRequest(`Setting \`${key}\` must be an integer between ${spec.min} and ${spec.max}.`);
      }
      return n;
    }
    default:
      throw badRequest(`Unknown setting \`${key}\`.`);
  }
}

/**
 * Runtime-mutable settings. Environment variables provide the defaults; values changed via the
 * API/UI are persisted to `<dataDir>/settings.json` and win over the environment on restart.
 * Reads are synchronous, so each request sees the value at the moment it starts.
 */
export class SettingsStore {
  constructor({ defaults, filePath = null, logger }) {
    this.defaults = { ...defaults };
    this.filePath = filePath;
    this.logger = logger;
    this.listeners = new Set();
    this.values = {};
    // Fail fast on bad environment values (e.g. ROBOTS_POLICY=maybe) instead of at first request.
    for (const [key, value] of Object.entries(defaults)) this.values[key] = coerce(key, value);
    this.defaults = { ...this.values };
    this.#load();
  }

  #load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const [key, value] of Object.entries(saved)) {
        if (!(key in SCHEMA)) continue;
        try {
          this.values[key] = coerce(key, value);
        } catch {
          this.logger?.warn('Ignoring invalid persisted setting', { key });
        }
      }
    } catch (err) {
      this.logger?.warn('Could not read persisted settings; using defaults', { error: err });
    }
  }

  #persist() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.values, null, 2));
    } catch (err) {
      this.logger?.warn('Could not persist settings', { error: err });
    }
  }

  get(key) {
    return this.values[key];
  }

  snapshot() {
    return { ...this.values };
  }

  /** Validate and apply a partial update atomically (all keys or none). */
  update(patch) {
    if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw badRequest('Settings update must be a JSON object.');
    }
    const next = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in SCHEMA)) throw badRequest(`Unknown setting \`${key}\`.`);
      next[key] = coerce(key, value);
    }
    const previous = this.snapshot();
    Object.assign(this.values, next);
    this.#persist();
    this.#emit(previous);
    return this.snapshot();
  }

  reset() {
    const previous = this.snapshot();
    this.values = { ...this.defaults };
    if (this.filePath) fs.rmSync(this.filePath, { force: true });
    this.#emit(previous);
    return this.snapshot();
  }

  /** Subscribe to changes: listener(current, previous). Returns an unsubscribe function. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #emit(previous) {
    const current = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(current, previous);
      } catch (err) {
        this.logger?.error('Settings listener failed', { error: err });
      }
    }
  }
}

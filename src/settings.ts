import fs from 'node:fs';
import path from 'node:path';
import { badRequest } from './errors.js';
import type { Logger } from './logger.js';

export const ROBOTS_POLICIES = ['enforce', 'warn', 'off'] as const;
export type RobotsPolicy = (typeof ROBOTS_POLICIES)[number];

/** Options that can be changed while the service is running. */
export interface SettingsValues {
  headless: boolean;
  fallbackToHeadless: boolean;
  robotsPolicy: RobotsPolicy;
  minIntervalMs: number;
  cacheTtlSeconds: number;
}
export type SettingKey = keyof SettingsValues;
/** Unvalidated initial values (e.g. straight from environment variables). */
export type SettingsInput = { readonly [K in SettingKey]: unknown };
export type SettingsListener = (current: SettingsValues, previous: SettingsValues) => void;

type Spec = { type: 'boolean' } | { type: 'enum'; values: readonly string[] } | { type: 'int'; min: number; max: number };

const SCHEMA: Record<SettingKey, Spec> = {
  headless: { type: 'boolean' },
  fallbackToHeadless: { type: 'boolean' },
  robotsPolicy: { type: 'enum', values: ROBOTS_POLICIES },
  minIntervalMs: { type: 'int', min: 0, max: 600000 },
  cacheTtlSeconds: { type: 'int', min: 0, max: 86400 },
};

const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(SCHEMA, key);

function coerce(key: SettingKey, value: unknown): boolean | number | string {
  const spec = SCHEMA[key];
  switch (spec.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw badRequest(`Setting \`${key}\` must be a boolean.`);
    case 'enum':
      if (typeof value === 'string' && spec.values.includes(value)) return value;
      throw badRequest(`Setting \`${key}\` must be one of: ${spec.values.join(', ')}.`);
    case 'int': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        throw badRequest(`Setting \`${key}\` must be an integer between ${spec.min} and ${spec.max}.`);
      }
      return n;
    }
  }
}

export interface SettingsStoreOptions {
  defaults: SettingsInput;
  filePath?: string | null;
  logger?: Logger;
}

/**
 * Runtime-mutable settings. Environment variables provide the defaults; values changed via the
 * API/UI are persisted to `<dataDir>/settings.json` and win over the environment on restart.
 * Reads are synchronous, so each request sees the value at the moment it starts.
 */
export class SettingsStore {
  private readonly defaults: SettingsValues;
  private values: SettingsValues;
  private readonly filePath: string | null;
  private readonly logger: Logger | undefined;
  private readonly listeners = new Set<SettingsListener>();

  constructor({ defaults, filePath = null, logger }: SettingsStoreOptions) {
    this.filePath = filePath;
    this.logger = logger;
    // Fail fast on bad environment values (e.g. ROBOTS_POLICY=maybe) instead of at first request.
    const initial: Record<string, unknown> = {};
    for (const key of Object.keys(SCHEMA) as SettingKey[]) initial[key] = coerce(key, defaults[key]);
    this.defaults = initial as unknown as SettingsValues;
    this.values = { ...this.defaults };
    this.load();
  }

  private load(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (saved === null || typeof saved !== 'object') return;
      for (const [key, value] of Object.entries(saved)) {
        if (!isSettingKey(key)) continue;
        try {
          (this.values as unknown as Record<string, unknown>)[key] = coerce(key, value);
        } catch {
          this.logger?.warn('Ignoring invalid persisted setting', { key });
        }
      }
    } catch (err) {
      this.logger?.warn('Could not read persisted settings; using defaults', { error: err });
    }
  }

  private persist(): void {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.values, null, 2));
    } catch (err) {
      this.logger?.warn('Could not persist settings', { error: err });
    }
  }

  get<K extends SettingKey>(key: K): SettingsValues[K] {
    return this.values[key];
  }

  snapshot(): SettingsValues {
    return { ...this.values };
  }

  /** Validate and apply a partial update atomically (all keys or none). */
  update(patch: unknown): SettingsValues {
    if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw badRequest('Settings update must be a JSON object.');
    }
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!isSettingKey(key)) throw badRequest(`Unknown setting \`${key}\`.`);
      next[key] = coerce(key, value);
    }
    const previous = this.snapshot();
    Object.assign(this.values, next);
    this.persist();
    this.emit(previous);
    return this.snapshot();
  }

  reset(): SettingsValues {
    const previous = this.snapshot();
    this.values = { ...this.defaults };
    if (this.filePath) fs.rmSync(this.filePath, { force: true });
    this.emit(previous);
    return this.snapshot();
  }

  /** Subscribe to changes: listener(current, previous). Returns an unsubscribe function. */
  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(previous: SettingsValues): void {
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

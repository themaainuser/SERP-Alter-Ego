export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFormat = 'json' | 'pretty';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(extra: LogFields): Logger;
}

export interface LoggerOptions {
  level?: string;
  format?: string;
  stream?: { write(chunk: string): unknown };
  bindings?: LogFields;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Minimal structured logger. `json` format emits one JSON object per line (for log shippers);
 * `pretty` emits a human-readable line.
 */
export function createLogger({ level = 'info', format = 'pretty', stream = process.stderr, bindings = {} }: LoggerOptions = {}): Logger {
  const threshold = LEVELS[level as LogLevel] ?? LEVELS.info;

  function write(lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void {
    if (LEVELS[lvl] < threshold) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg, ...bindings, ...serialize(fields) };
    if (format === 'json') {
      stream.write(JSON.stringify(entry) + '\n');
      return;
    }
    const { time, level: l, msg: m, ...rest } = entry;
    const extra = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
    stream.write(`${time} ${l.toUpperCase().padEnd(5)} ${m}${extra}\n`);
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (extra) => createLogger({ level, format, stream, bindings: { ...bindings, ...extra } }),
  };
}

function serialize(fields: LogFields = {}): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      const code = (v as { code?: unknown }).code;
      out[k] = { name: v.name, message: v.message, code, stack: v.stack?.split('\n').slice(0, 4).join(' | ') };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Strip secrets (api_key) from a URL or query string before logging it. */
export function redactUrl(url: string): string {
  return String(url).replace(/([?&]api_key=)[^&]*/gi, '$1[redacted]');
}

export const nullLogger: Logger = createLogger({ level: 'silent' });

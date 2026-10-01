const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Minimal structured logger. `json` format emits one JSON object per line (for log shippers);
 * `pretty` emits a human-readable line.
 */
export function createLogger({ level = 'info', format = 'pretty', stream = process.stderr, bindings = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, msg, fields) {
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

function serialize(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message, code: v.code, stack: v.stack?.split('\n').slice(0, 4).join(' | ') };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Strip secrets (api_key) from a URL or query string before logging it. */
export function redactUrl(url) {
  return String(url).replace(/([?&]api_key=)[^&]*/gi, '$1[redacted]');
}

export const nullLogger = createLogger({ level: 'silent' });

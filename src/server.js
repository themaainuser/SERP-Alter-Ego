import fs from 'node:fs';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

// Optional .env support without extra dependencies (Node >= 20.12).
if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, format: config.logFormat });

let instance;
try {
  instance = createApp({ config, logger });
} catch (err) {
  logger.error('Invalid configuration', { error: err });
  process.exit(1);
}

const server = instance.app.listen(config.port, config.host, () => {
  const s = instance.components.settings.snapshot();
  logger.info('SERP Alter Ego listening', {
    url: `http://${config.host}:${config.port}`,
    headless: s.headless,
    robotsPolicy: s.robotsPolicy,
  });
});

server.on('error', (err) => {
  logger.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use` : 'Server error', { error: err });
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();
  server.close();
  await instance.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', { error: reason instanceof Error ? reason : new Error(String(reason)) }));

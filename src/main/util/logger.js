'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny leveled logger. Writes to stdout and, if a logDir is configured, to a
 * rolling daily file. Kept dependency-free on purpose.
 */
let logFilePath = null;

function init(logDir) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    logFilePath = path.join(logDir, `timeflip-${day}.log`);
  } catch (err) {
    // Logging must never crash the app; fall back to stdout only.
    logFilePath = null;
    // eslint-disable-next-line no-console
    console.error('logger: could not open log file', err.message);
  }
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ')}`;
  // eslint-disable-next-line no-console
  (level === 'ERROR' ? console.error : console.log)(line);
  if (logFilePath) {
    fs.appendFile(logFilePath, line + '\n', () => {});
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = {
  init,
  info: (...args) => write('INFO', args),
  warn: (...args) => write('WARN', args),
  error: (...args) => write('ERROR', args),
  debug: (...args) => {
    if (process.env.TIMEFLIP_DEBUG) write('DEBUG', args);
  },
};

// log.js — tiny append-only logger for the main process.
// Synapse used to swallow every failure in `catch {}`, which made the packaged
// app impossible to debug: a failed settings write just silently lost your
// vault choice. Everything that can fail now leaves a line here.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;   // rotate once, keep one previous file
let logPath = null;
let stream = null;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logPath = path.join(dir, 'synapse.log');
    try {
      if (fs.statSync(logPath).size > MAX_BYTES) fs.renameSync(logPath, logPath + '.1');
    } catch {}
    stream = fs.createWriteStream(logPath, { flags: 'a' });
    stream.on('error', () => { stream = null; });
  } catch {
    logPath = null; stream = null;
  }
}

function fmt(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function write(level, args) {
  const line = new Date().toISOString() + ' [' + level + '] ' + args.map(fmt).join(' ');
  if (level === 'ERROR') console.error(line); else console.log(line);
  try { if (stream) stream.write(line + '\n'); } catch {}
}

module.exports = {
  init,
  file: () => logPath,
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a)
};

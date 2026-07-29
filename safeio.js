// safeio.js — crash-safe file writes and vault path containment.
// Pure CommonJS so the tests can exercise it without Electron.

const fs = require('fs');
const path = require('path');

const NUL = String.fromCharCode(0);

/**
 * Write to a sibling temp file, flush it, then rename over the target.
 * rename() is atomic within a volume, so a crash or power loss mid-write
 * leaves either the old file or the new one — never a truncated note.
 */
function writeFileAtomic(file, data, encoding) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data, encoding || 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Resolve a vault-relative id to an absolute path, refusing anything that
 * escapes the vault. Every filesystem IPC handler goes through this so a
 * compromised or buggy renderer cannot reach a path outside the vault.
 * Returns null when the id is not safe.
 */
function resolveInVault(vaultPath, relId) {
  if (!vaultPath || typeof relId !== 'string' || !relId) return null;
  if (relId.indexOf(NUL) !== -1) return null;
  const root = path.resolve(vaultPath);
  const target = path.resolve(root, relId);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/**
 * Strip characters that are illegal in Windows/macOS filenames.
 * Spaces and dashes are legal and deliberately preserved.
 */
function sanitizeName(name, fallback) {
  let out = '';
  const src = String(name == null ? '' : name);
  for (const ch of src) {
    if (ch.charCodeAt(0) < 32) continue;
    if ('\\/:*?"<>|'.indexOf(ch) !== -1) continue;
    out += ch;
  }
  out = out.replace(/^\.+/, '').replace(/[. ]+$/, '').trim();
  return out || (fallback || 'Untitled');
}

module.exports = { writeFileAtomic, writeJsonAtomic, resolveInVault, sanitizeName };

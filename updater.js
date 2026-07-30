// updater.js — self-update from GitHub Releases.
// On startup (packaged app only) it asks GitHub for the latest release, compares it
// to the running version, and if newer downloads it in the background and installs
// on restart — no manual reinstall. Uses electron-updater + the NSIS installer.

const { app, dialog } = require('electron');

function initAutoUpdate(win) {
  // Never run in `npm start` / dev — there's no installed app to update.
  if (!app.isPackaged) return null;

  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); }
  catch (e) { return null; }   // dependency missing — fail silent

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (data) => { try { win && !win.isDestroyed() && win.webContents.send('update-status', data); } catch {} };

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available',    (i) => send({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available',() => send({ state: 'current' }));
  autoUpdater.on('download-progress',   (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('error',               (e) => send({ state: 'error', message: String((e && e.message) || e) }));
  autoUpdater.on('update-downloaded',   (i) => {
    send({ state: 'ready', version: i.version });
    dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0, cancelId: 1,
      title: 'Update ready',
      message: 'Synapse ' + i.version + ' has been downloaded.',
      detail: 'Restart to finish installing. Your notes are untouched.'
    }).then(r => { if (r.response === 0) autoUpdater.quitAndInstall(); }).catch(() => {});
  });

  // check a few seconds after launch, then every 6 hours while it runs
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 3000);
  setInterval(check, 6 * 60 * 60 * 1000);

  instance = autoUpdater;
  return autoUpdater;
}

// Held so the Help menu can trigger a check on demand.
let instance = null;

/**
 * Manual "check now". Returns a short status string for the caller to surface,
 * because in development there is no installed app to update.
 */
async function checkNow(win) {
  const { app: electronApp } = require('electron');
  if (!electronApp.isPackaged) {
    return { ok: false, reason: 'dev', message: 'Updates only apply to the installed app, not to `npm start`.' };
  }
  if (!instance) return { ok: false, reason: 'unavailable', message: 'The updater is not available in this build.' };
  try {
    const r = await instance.checkForUpdates();
    const version = r && r.updateInfo && r.updateInfo.version;
    return { ok: true, version: version || null, message: version ? 'Found ' + version : 'Checking…' };
  } catch (err) {
    return { ok: false, reason: 'error', message: String((err && err.message) || err) };
  }
}

/** Restart into the downloaded update. No-op if nothing is staged. */
function quitAndInstall() {
  if (!instance) throw new Error('The updater is not running.');
  instance.quitAndInstall();
}

module.exports = { initAutoUpdate, checkNow, quitAndInstall };

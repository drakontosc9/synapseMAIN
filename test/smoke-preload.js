// Stub of preload.js for the headless UI smoke test (test/ui-smoke.js).
// Records every call so the test can assert what the UI asked main to do.
const { contextBridge } = require('electron');

const calls = [];
const rec = (name, result) => (...args) => { calls.push({ name, args }); return Promise.resolve(result); };

contextBridge.exposeInMainWorld('synapse', {
  getVault: rec('getVault', 'C:/tmp/vault'),
  chooseVault: rec('chooseVault', 'C:/tmp/vault'),
  scanVault: rec('scanVault', { nodes: [], links: [], folders: [], suggestions: [] }),
  previewThought: rec('previewThought', { folder: 'Ideas', reason: 'test' }),
  captureThought: rec('captureThought', { id: 'Ideas/x.md', folder: 'Ideas', title: 'X' }),
  readNote: rec('readNote', '---\ntitle: "X"\nfolder: Ideas\ntags: []\n---\nbody'),
  writeNote: rec('writeNote', true),
  deleteNote: rec('deleteNote', { ok: true }),
  reveal: rec('reveal', true),
  importFiles: rec('importFiles', []),
  importLink: rec('importLink', { id: 'Links/x.md', title: 'Saved link' }),
  newAttachmentNote: rec('newAttachmentNote', { id: 'Attachments/x.md', title: 'X' }),
  setParent: rec('setParent', { ok: true }),
  addWikilink: rec('addWikilink', { ok: true }),
  createFolder: rec('createFolder', { id: 'Research', title: 'Research' }),
  groupNotes: rec('groupNotes', { id: 'G', moved: [] }),
  moveNote: rec('moveNote', { ok: true, to: 'Tasks/x.md' }),
  listFolders: rec('listFolders', ['Ideas', 'Tasks', 'Research']),
  getAppInfo: rec('getAppInfo', {
    version: '0.3.1', electron: '31.0.0', logFile: 'C:/tmp/log',
    vaultPath: 'C:/tmp/vault', quickShortcut: 'Control+Shift+Space',
    quickCaptureEnabled: true, runInTray: false
  }),
  getSettings: rec('getSettings', {
    groupCreate: 'both', quickShortcut: 'Control+Shift+Space',
    quickCaptureEnabled: true, runInTray: false
  }),
  setSettings: rec('setSettings', {
    groupCreate: 'both', quickShortcut: 'Control+Shift+Space',
    quickCaptureEnabled: true, runInTray: false
  }),
  getConfig: rec('getConfig', {}),
  setConfig: rec('setConfig', {}),
  resetConfig: rec('resetConfig', {}),
  getRules: rec('getRules', { rules: [] }),
  setRules: rec('setRules', { ok: true }),
  learnFiling: rec('learnFiling', { ok: true, added: ['gateway'] }),
  saveImage: rec('saveImage', { ok: true }),
  showLog: rec('showLog', { ok: true }),
  quickHide: rec('quickHide', true),
  quickOpenMain: rec('quickOpenMain', true),
  onUpdateStatus: () => () => {},
  onMenuAction: () => () => {},
  onVaultChanged: () => () => {},
  onShortcutFailed: () => () => {},
  onQuickReset: () => () => {},

  // test-only introspection
  __calls: () => calls.slice(),
  __reset: () => { calls.length = 0; }
});

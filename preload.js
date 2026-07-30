// preload.js — safe bridge between the renderer (UI) and main (filesystem).
// Every entry is a narrow, task-specific function: no raw ipcRenderer, no Node
// APIs and no channel names reach the page.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Turn dropped File objects into real paths. File.path is deprecated in recent
// Electron, so prefer webUtils and keep the old property as a fallback.
function pathForFile(file) {
  try { if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file); } catch {}
  return file && file.path ? file.path : null;
}

// Wrap a main-process listener so the renderer only ever receives the payload,
// never the IpcRendererEvent (which exposes the sender).
const on = (channel) => (cb) => {
  if (typeof cb !== 'function') return () => {};
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('synapse', {
  // vault + notes
  getVault:       ()             => ipcRenderer.invoke('get-vault'),
  chooseVault:    ()             => ipcRenderer.invoke('choose-vault'),
  scanVault:      ()             => ipcRenderer.invoke('scan-vault'),
  previewThought: (text)         => ipcRenderer.invoke('preview-thought', text),
  captureThought: (text)         => ipcRenderer.invoke('capture-thought', text),
  readNote:       (id)           => ipcRenderer.invoke('read-note', id),
  writeNote:      (id, content)  => ipcRenderer.invoke('write-note', id, content),
  deleteNote:     (id)           => ipcRenderer.invoke('delete-note', id),
  reveal:         (id)           => ipcRenderer.invoke('reveal', id),

  // import
  importFiles:    ()             => ipcRenderer.invoke('import-files'),
  importLink:     (url, note)    => ipcRenderer.invoke('import-link', url, note),
  newAttachmentNote: (md)        => ipcRenderer.invoke('new-attachment-note', md),

  // creation + import
  createNote:     (text, folderId, opts) => ipcRenderer.invoke('create-note', text, folderId, opts),
  importPaths:    (paths, opts)  => ipcRenderer.invoke('import-paths', paths, opts),
  importImageBuffer: (bytes, name, folderId) => ipcRenderer.invoke('import-image-buffer', bytes, name, folderId),
  pathsForFiles:  (files)        => Array.from(files || []).map(pathForFile).filter(Boolean),

  // folders
  openFolder:     (relId)        => ipcRenderer.invoke('open-folder', relId),
  renameFolder:   (relId, name)  => ipcRenderer.invoke('rename-folder', relId, name),
  mergeFolders:   (from, into)   => ipcRenderer.invoke('merge-folders', from, into),
  deleteFolder:   (relId)        => ipcRenderer.invoke('delete-folder', relId),

  // ephemeral notes
  setNoteTtl:     (relId, hours) => ipcRenderer.invoke('set-note-ttl', relId, hours),
  purgeExpired:   ()             => ipcRenderer.invoke('purge-expired'),
  vaultHasNotes:  ()             => ipcRenderer.invoke('vault-has-notes'),

  // structure
  setParent:      (child, parent)=> ipcRenderer.invoke('set-parent', child, parent),
  addWikilink:    (from, to)     => ipcRenderer.invoke('add-wikilink', from, to),
  createFolder:   (name, parent) => ipcRenderer.invoke('create-folder', name, parent),
  groupNotes:     (ids, name)    => ipcRenderer.invoke('group-notes', ids, name),
  moveNote:       (id, folderId) => ipcRenderer.invoke('move-note', id, folderId),
  listFolders:    ()             => ipcRenderer.invoke('list-folders'),

  // settings / config / rules
  getAppInfo:     ()             => ipcRenderer.invoke('get-app-info'),
  getSettings:    ()             => ipcRenderer.invoke('get-settings'),
  setSettings:    (patch)        => ipcRenderer.invoke('set-settings', patch),
  getConfig:      ()             => ipcRenderer.invoke('get-config'),
  setConfig:      (patch)        => ipcRenderer.invoke('set-config', patch),
  resetConfig:    ()             => ipcRenderer.invoke('reset-config'),
  getRules:       ()             => ipcRenderer.invoke('get-rules'),
  setRules:       (rules)        => ipcRenderer.invoke('set-rules', rules),
  learnFiling:    (text, folder) => ipcRenderer.invoke('learn-filing', text, folder),
  saveImage:      (dataUrl)      => ipcRenderer.invoke('save-image', dataUrl),
  showLog:        ()             => ipcRenderer.invoke('show-log'),

  // quick capture window
  quickHide:      ()             => ipcRenderer.invoke('quick-hide'),
  quickOpenMain:  (id)           => ipcRenderer.invoke('quick-open-main', id),

  // main -> renderer events
  onUpdateStatus:   on('update-status'),
  onMenuAction:     on('menu-action'),
  onVaultChanged:   on('vault-changed'),
  onShortcutFailed: on('shortcut-failed'),
  onQuickReset:     on('quick-reset')
});

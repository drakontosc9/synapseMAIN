// preload.js — safe bridge between the renderer (UI) and main (filesystem).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('synapse', {
  getVault:       ()             => ipcRenderer.invoke('get-vault'),
  chooseVault:    ()             => ipcRenderer.invoke('choose-vault'),
  scanVault:      ()             => ipcRenderer.invoke('scan-vault'),
  previewThought: (text)         => ipcRenderer.invoke('preview-thought', text),
  captureThought: (text)         => ipcRenderer.invoke('capture-thought', text),
  newAttachmentNote: (md)        => ipcRenderer.invoke('new-attachment-note', md),
  readNote:       (id)           => ipcRenderer.invoke('read-note', id),
  writeNote:      (id, content)  => ipcRenderer.invoke('write-note', id, content),
  importFiles:    ()             => ipcRenderer.invoke('import-files'),
  importLink:     (url, note)    => ipcRenderer.invoke('import-link', url, note),
  reveal:         (id)           => ipcRenderer.invoke('reveal', id),
  getSettings:    ()             => ipcRenderer.invoke('get-settings'),
  setSettings:    (patch)        => ipcRenderer.invoke('set-settings', patch),
  getConfig:      ()             => ipcRenderer.invoke('get-config'),
  setConfig:      (patch)        => ipcRenderer.invoke('set-config', patch),
  resetConfig:    ()             => ipcRenderer.invoke('reset-config'),
  getRules:       ()             => ipcRenderer.invoke('get-rules'),
  setRules:       (rules)        => ipcRenderer.invoke('set-rules', rules),
  saveImage:      (dataUrl)      => ipcRenderer.invoke('save-image', dataUrl),
  setParent:      (child, parent)=> ipcRenderer.invoke('set-parent', child, parent),
  addWikilink:    (from, to)     => ipcRenderer.invoke('add-wikilink', from, to),
  createFolder:   (name, parent) => ipcRenderer.invoke('create-folder', name, parent),
  groupNotes:     (ids, name)    => ipcRenderer.invoke('group-notes', ids, name),
  moveNote:       (id, folderId) => ipcRenderer.invoke('move-note', id, folderId)
});

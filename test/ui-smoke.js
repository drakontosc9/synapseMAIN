// Headless UI smoke test. Run with:  npx electron test/ui-smoke.js
// Loads the real index.html + renderer.js against a recording preload stub and
// drives the flows that used to be broken by window.prompt().

const { app, BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const consoleErrors = [];

const ok = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  OK   ' + name); pass++; }
  else { console.log('  FAIL ' + name + '  got=' + g + ' want=' + w); fail++; }
};

function done() {
  if (consoleErrors.length) {
    console.log('\nrenderer console errors:');
    for (const e of consoleErrors) console.log('  ! ' + e);
    fail += consoleErrors.length;
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed.');
  app.exit(fail ? 1 : 0);
}
setTimeout(() => { console.log('TIMED OUT'); app.exit(1); }, 40000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 820,
    webPreferences: {
      preload: path.join(ROOT, 'test', 'smoke-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.webContents.on('console-message', (...args) => {
    const a = (args[0] && typeof args[0] === 'object' && 'level' in args[0]) ? args[0] : { level: args[1], message: args[2] };
    if (a.level === 'error' || a.level === 3) consoleErrors.push(String(a.message));
  });
  win.webContents.on('preload-error', (_e, p, err) => consoleErrors.push('preload: ' + String(err)));

  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise(r => setTimeout(r, 1200));

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  console.log('renderer boots:');
  ok('no missing DOM ids', await js(
    'JSON.stringify(["askModal","askFields","askOk","askCancel","recents","recentsList",' +
    '"moveNoteBtn","deleteNoteBtn","panelDirty","quickShortcut","runInTray","aboutBox","recentsBtn"]' +
    '.filter(function(i){return !document.getElementById(i)}))'), '[]');
  ok('about box filled', await js('/Synapse 0\\.3\\.1/.test(document.getElementById("aboutBox").textContent)'), true);

  console.log('\ngroup creation (used to throw on window.prompt):');
  await js('window.synapse.__reset()');
  await js('document.getElementById("newGroupBtn").click()');
  await wait(150);
  ok('dialog opened', await js('!document.getElementById("askModal").classList.contains("hidden")'), true);
  ok('title is New group', await js('document.getElementById("askTitle").textContent'), 'New group');
  ok('one text field, focused', await js(
    'document.activeElement === document.querySelector("#askFields .ask-input")'), true);

  await js('document.querySelector("#askFields .ask-input").value = "Research"');
  await js('document.getElementById("askOk").click()');
  await wait(250);
  ok('dialog closed', await js('document.getElementById("askModal").classList.contains("hidden")'), true);
  ok('createFolder called with the typed name', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="createFolder"})||{}).args)'),
    '["Research",""]');

  console.log('\nempty group name is rejected, not silently accepted:');
  await js('window.synapse.__reset()');
  await js('document.getElementById("newGroupBtn").click()');
  await wait(120);
  await js('document.querySelector("#askFields .ask-input").value = "   "');
  await js('document.getElementById("askOk").click()');
  await wait(150);
  ok('dialog stays open', await js('!document.getElementById("askModal").classList.contains("hidden")'), true);
  ok('validation message shown', await js(
    '!document.getElementById("askError").classList.contains("hidden")'), true);
  ok('createFolder not called', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="createFolder"}).length'), 0);
  await js('document.getElementById("askCancel").click()');
  await wait(100);

  console.log('\nsave-a-link dialog (also used to throw):');
  await js('window.synapse.__reset()');
  await js('document.getElementById("linkBtn").click()');
  await wait(150);
  ok('two fields rendered', await js('document.querySelectorAll("#askFields .ask-input").length'), 2);
  await js('document.querySelectorAll("#askFields .ask-input")[0].value = "not-a-url"');
  await js('document.getElementById("askOk").click()');
  await wait(120);
  ok('bad URL refused', await js('window.synapse.__calls().filter(function(c){return c.name==="importLink"}).length'), 0);
  await js('document.querySelectorAll("#askFields .ask-input")[0].value = "https://example.com"');
  await js('document.querySelectorAll("#askFields .ask-input")[1].value = "why it matters"');
  await js('document.getElementById("askOk").click()');
  await wait(250);
  ok('importLink called with url + note', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="importLink"})||{}).args)'),
    '["https://example.com","why it matters"]');

  console.log('\nEscape closes the dialog:');
  await js('document.getElementById("newGroupBtn").click()');
  await wait(120);
  await js('document.getElementById("askModal").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await wait(120);
  ok('closed by Escape', await js('document.getElementById("askModal").classList.contains("hidden")'), true);

  console.log('\nmarkdown rendering is link-safe:');
  ok('http link becomes an anchor', await js(
    '/<a href="https:\\/\\/ok.test"/.test(mdToHtml("[x](https://ok.test)"))'), true);
  ok('javascript: url is not an anchor', await js(
    'mdToHtml("[x](javascript:alert(1))").indexOf("<a ") === -1'), true);
  ok('relative path is not an anchor', await js(
    'mdToHtml("[x](../other.md)").indexOf("<a href") === -1'), true);
  ok('ampersand in url not double-escaped', await js(
    'mdToHtml("[x](https://a.test/?p=1&q=2)").indexOf("&amp;amp;") === -1'), true);
  ok('wikilink is clickable', await js(
    '/class="wikilink" data-wiki="Beta"/.test(mdToHtml("see [[Beta]]"))'), true);

  console.log('\nhotkeys leave text fields alone:');
  ok('ctrl+z inside a textarea is not hijacked', await js(
    '(function(){var t=document.getElementById("panelEdit");' +
    'var e=new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true});' +
    'Object.defineProperty(e,"target",{value:t});onGlobalKey(e);return e.defaultPrevented})()'), false);
  ok('ctrl+z on the canvas is handled', await js(
    '(function(){var e=new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true});' +
    'Object.defineProperty(e,"target",{value:document.getElementById("graph")});' +
    'onGlobalKey(e);return e.defaultPrevented})()'), true);

  console.log('\nrecents panel:');
  await js('graph.setData({folders:["Ideas"],nodes:[' +
    '{id:"__root__",type:"root",title:"Vault",containerId:null},' +
    '{id:"Ideas",type:"folder",title:"Ideas",containerId:"__root__",folder:"Ideas",noteCount:2},' +
    '{id:"Ideas/new.md",type:"note",title:"Fresh note",containerId:"Ideas",folder:"Ideas",tags:[],links:[],created:new Date().toISOString()},' +
    '{id:"Ideas/old.md",type:"note",title:"Ancient note",containerId:"Ideas",folder:"Ideas",tags:[],links:[],created:"2020-01-01T00:00:00.000Z"}' +
    '],links:[],suggestions:[]})');
  await js('openRecents()');
  await wait(150);
  ok('panel visible', await js('!document.getElementById("recents").classList.contains("hidden")'), true);
  ok('two notes listed', await js('document.querySelectorAll("#recentsList .rc-item").length'), 2);
  ok('newest first', await js('document.querySelector("#recentsList .rc-item .rc-title").textContent'), 'Fresh note');
  ok('buckets rendered', await js('document.querySelectorAll("#recentsList .rc-bucket").length >= 2'), true);
  ok('today bucket first', await js('document.querySelector("#recentsList .rc-bucket").textContent'), 'Today');

  console.log('\ndelete asks first, then calls through:');
  await js('window.synapse.__reset()');
  // note the trailing `; 0` — the call returns a promise that only settles once
  // the dialog is answered, and executeJavaScript would await it forever
  await js('doDeleteNote({id:"Ideas/old.md",title:"Ancient note"}); 0');
  await wait(150);
  ok('confirmation shown with no input fields', await js(
    'document.querySelectorAll("#askFields .ask-input").length'), 0);
  ok('confirm button is styled destructive', await js(
    'document.getElementById("askOk").classList.contains("danger")'), true);
  await js('document.getElementById("askCancel").click()');
  await wait(120);
  ok('cancel means no delete', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="deleteNote"}).length'), 0);

  // note the trailing `; 0` — the call returns a promise that only settles once
  // the dialog is answered, and executeJavaScript would await it forever
  await js('doDeleteNote({id:"Ideas/old.md",title:"Ancient note"}); 0');
  await wait(150);
  await js('document.getElementById("askOk").click()');
  await wait(250);
  ok('confirmed delete calls deleteNote', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="deleteNote"})||{}).args)'),
    '["Ideas/old.md"]');

  console.log('\nquick capture window:');
  const qwin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'test', 'smoke-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  const qErrors = [];
  qwin.webContents.on('console-message', (...args) => {
    const a = (args[0] && typeof args[0] === 'object' && 'level' in args[0]) ? args[0] : { level: args[1], message: args[2] };
    if (a.level === 'error' || a.level === 3) qErrors.push(String(a.message));
  });
  await qwin.loadFile(path.join(ROOT, 'src', 'quick.html'));
  await wait(600);
  const qjs = (code) => qwin.webContents.executeJavaScript(code, true);
  ok('input is focused on open', await qjs('document.activeElement.id'), 'quickInput');
  ok('hint text shown', await qjs('document.getElementById("quickStatus").textContent.indexOf("Enter to file") >= 0'), true);
  await qjs('document.getElementById("quickInput").value = "ship the thing"');
  await qjs('document.getElementById("quickInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');
  await wait(400);
  ok('captureThought called', await qjs(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="captureThought"})||{}).args)'),
    '["ship the thing"]');
  ok('confirmation shown', await qjs('document.getElementById("quickStatus").className.indexOf("ok") >= 0'), true);
  ok('quick window has no console errors', qErrors, []);

  done();
});

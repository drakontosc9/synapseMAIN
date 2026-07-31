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

  console.log('\nopen folder in explorer:');
  await js('window.synapse.__reset()');
  await js('openFolderInExplorer("Ideas/note.md"); 0');
  await wait(150);
  ok('note path forwarded to main', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="openFolder"})||{}).args)'),
    '["Ideas/note.md"]');
  await js('window.synapse.__reset()');
  await js('openFolderInExplorer(""); 0');
  await wait(150);
  ok('vault root opens too', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="openFolder"})||{}).args)'),
    '[""]');

  console.log('\nfolder context menu:');
  await js('showCtx({x:40,y:40,node:{id:"Ideas",type:"folder",title:"Ideas",folder:"Ideas"}})');
  await wait(120);
  const folderMenu = await js('JSON.stringify(Array.prototype.map.call(document.querySelectorAll("#ctxmenu button"),function(b){return b.textContent}))');
  ok('offers explorer', folderMenu.indexOf('Open in file explorer') >= 0, true);
  ok('offers rename', folderMenu.indexOf('Rename folder') >= 0, true);
  ok('offers merge', folderMenu.indexOf('Merge into another folder') >= 0, true);
  ok('offers colour', folderMenu.indexOf('Change colour') >= 0, true);
  ok('offers delete', folderMenu.indexOf('Delete folder') >= 0, true);
  await js('hideCtx()');

  console.log('\nin-graph note creation:');
  await js('window.synapse.__reset()');
  await js('openSpawn(400, 300)');
  await wait(150);
  ok('spawn box opens', await js('!document.getElementById("spawn").classList.contains("hidden")'), true);
  ok('input focused', await js('document.activeElement.id'), 'spawnInput');
  await js('document.getElementById("spawnInput").value = "thought from the canvas"');
  await js('commitSpawn(); 0');
  await wait(300);
  ok('createNote called with text', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="createNote"})||{}).args[0])'),
    '"thought from the canvas"');
  ok('spawn box closed', await js('document.getElementById("spawn").classList.contains("hidden")'), true);

  console.log('\nburner notes:');
  await js('window.synapse.__reset()');
  await js('openSpawn(400, 300)');
  await wait(120);
  await js('document.getElementById("spawnInput").value = "temporary"');
  await js('document.getElementById("spawnBurner").checked = true');
  await js('document.getElementById("spawnTtl").value = "1"');
  await js('commitSpawn(); 0');
  await wait(300);
  ok('ttl passed through', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="createNote"})||{}).args[2])'),
    '{"ttlHours":1}');

  console.log('\nlens engine:');
  await js('graph.setData({folders:["Ideas"],nodes:[' +
    '{id:"__root__",type:"root",title:"Vault",containerId:null},' +
    '{id:"Ideas",type:"folder",title:"Ideas",containerId:"__root__",folder:"Ideas",noteCount:3},' +
    '{id:"Ideas/a.md",type:"note",title:"A",containerId:"Ideas",folder:"Ideas",tags:[],links:[],created:"2026-07-01T00:00:00.000Z",mass:400},' +
    '{id:"Ideas/b.md",type:"note",title:"B",containerId:"Ideas",folder:"Ideas",tags:[],links:[],created:"2026-07-20T00:00:00.000Z",mass:20},' +
    '{id:"Ideas/c.md",type:"note",title:"C",containerId:"Ideas",folder:"Ideas",tags:[],links:[],created:"2026-07-28T00:00:00.000Z",mass:900,parentNote:"Ideas/a.md"}' +
    '],links:[{source:"Ideas/a.md",target:"Ideas/c.md",type:"parent"}],suggestions:[]})');
  await wait(100);
  ok('mass affects radius', await js(
    'graph.map.get("Ideas/c.md").r > graph.map.get("Ideas/b.md").r'), true);

  await js('setLens("mind")');
  await wait(120);
  ok('lens targets assigned', await js('graph.lensTargets && graph.lensTargets.size'), 3);
  ok('notes visible regardless of zoom', await js('graph._nodeAlpha(graph.map.get("Ideas/a.md"), new Map())'), 1);
  ok('folders dissolve under a lens', await js('graph._nodeAlpha(graph.map.get("Ideas"), new Map())'), 0);
  ok('newest note lands nearer the centre', await js(
    '(function(){var t=graph.lensTargets,cx=graph.canvas.clientWidth/2,cy=graph.canvas.clientHeight/2;' +
    'function d(id){var p=t.get(id);return Math.hypot(p.x-cx,p.y-cy)}' +
    'return d("Ideas/c.md") < d("Ideas/a.md")})()'), true);
  ok('ghost traces recorded', await js('graph.lensGhosts.length'), 3);

  await js('setLens("skills")');
  await wait(120);
  ok('skills lens lays out rows', await js('graph.lensTargets.size'), 3);
  ok('child sits below its prerequisite', await js(
    'graph.lensTargets.get("Ideas/c.md").y > graph.lensTargets.get("Ideas/a.md").y'), true);

  await js('setLens("knowledge")');
  await wait(120);
  ok('knowledge lens clusters', await js('graph.lensTargets.size'), 3);

  await js('setLens("free")');
  await wait(120);
  ok('free lens releases targets', await js('graph.lensTargets === null'), true);
  ok('folders come back', await js('graph._nodeAlpha(graph.map.get("Ideas"), new Map()) > 0'), true);

  console.log('\nflare:');
  await js('graph.flare("Ideas/a.md")');
  ok('flare reaches linked notes', await js('graph._flare.ids.has("Ideas/c.md")'), true);
  ok('flare records the origin at hop 0', await js('graph._flare.ids.get("Ideas/a.md")'), 0);

  console.log('\ncollision tagging (drop a note on a folder):');
  await js('window.synapse.__reset()');
  await js('dropInFolder("Ideas/b.md", "Tasks"); 0');
  await wait(250);
  ok('moveNote called with the folder', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="moveNote"})||{}).args)'),
    '["Ideas/b.md","Tasks"]');
  // dropping into the folder it already lives in must not rewrite anything
  await js('window.synapse.__reset()');
  await js('dropInFolder("Ideas/b.md", "Ideas"); 0');
  await wait(250);
  ok('a no-op drop does not touch the file', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="moveNote"}).length'), 0);

  console.log('\nmarquee multi-select:');
  // dropInFolder above triggered a refresh against the stub's empty vault, so
  // re-seed before asserting on selection
  await js('graph.setData({folders:["Ideas"],nodes:[' +
    '{id:"__root__",type:"root",title:"Vault",containerId:null},' +
    '{id:"Ideas",type:"folder",title:"Ideas",containerId:"__root__",folder:"Ideas",noteCount:3},' +
    '{id:"Ideas/a.md",type:"note",title:"A",containerId:"Ideas",folder:"Ideas",tags:[],links:[],mass:10},' +
    '{id:"Ideas/b.md",type:"note",title:"B",containerId:"Ideas",folder:"Ideas",tags:[],links:[],mass:10},' +
    '{id:"Ideas/c.md",type:"note",title:"C",containerId:"Ideas",folder:"Ideas",tags:[],links:[],mass:10}' +
    '],links:[],suggestions:[]})');
  await wait(100);
  // select-all takes folders as well as notes, since both are now actionable
  ok('selectAllVisible picks up notes and the folder', await js(
    '(function(){graph.clearSelection();graph.selectAllVisible();return graph.getSelection().length})()'), 4);
  ok('it can be restricted to notes', await js(
    '(function(){graph.clearSelection();graph.selectAllVisible("note");return graph.getSelection().length})()'), 3);
  ok('and to folders', await js(
    '(function(){graph.clearSelection();graph.selectAllVisible("folder");return graph.getSelection().length})()'), 1);
  ok('clearSelection empties it', await js(
    '(function(){graph.clearSelection();return graph.getSelection().length})()'), 0);

  console.log('\ndrag-and-drop import:');
  await js('window.synapse.__reset()');
  await js('importDropped(["C:/tmp/a.txt","C:/tmp/b.png"]); 0');
  await wait(300);
  ok('non-markdown imports without a prompt', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="importPaths"})||{}).args[0])'),
    '["C:/tmp/a.txt","C:/tmp/b.png"]');

  // File objects must never cross the context bridge — the preload hands the
  // renderer plain paths through this callback instead.
  ok('renderer registered a drop callback', await js('window.synapse.__hasDropCb()'), true);
  await js('window.synapse.__reset()');
  await js('window.synapse.__fireDrop({paths:["C:/tmp/dropped.txt"],x:5,y:9999,count:1}); 0');
  await wait(350);
  ok('callback paths reach the importer', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="importPaths"})||{}).args[0])'),
    '["C:/tmp/dropped.txt"]');
  await js('window.synapse.__reset()');
  await js('window.synapse.__fireDrop({paths:[],x:5,y:9999,count:2}); 0');
  await wait(250);
  ok('unreadable drop imports nothing', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="importPaths"}).length'), 0);

  console.log('\nhidden panes must not render:');
  ok('pane B is inactive while split is off', await js('panes.b._active'), false);
  ok('pane B stops looping', await js(
    '(function(){var n=0;var o=panes.b._tick.bind(panes.b);panes.b._tick=function(){n++;return o()};' +
    'window.__pbCount=function(){return n};return 1})()'), 1);
  await wait(600);
  ok('no frames drawn by the hidden pane', await js('window.__pbCount()'), 0);
  ok('dpr is defined even when never laid out', await js('typeof panes.b.dpr'), 'number');
  ok('active pane has a real dpr', await js('panes.a.dpr > 0'), true);

  console.log('\ncapture: Enter must never insert a newline:');
  await js('window.synapse.__reset()');
  const fireCapture = (props) => js(
    '(function(){var t=document.getElementById("thought");' +
    'var e=new KeyboardEvent("keydown",Object.assign({key:"Enter",bubbles:true,cancelable:true},' + JSON.stringify(props || {}) + '));' +
    'Object.defineProperty(e,"target",{value:t});' +
    't.dispatchEvent(e);return e.defaultPrevented})()');

  await js('document.getElementById("thought").value = "a real thought"');
  ok('plain Enter is swallowed', await fireCapture(), true);
  await wait(300);
  ok('and it captured', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="captureThought"})||{}).args)'),
    '["a real thought"]');

  await js('window.synapse.__reset()');
  await js('document.getElementById("thought").value = "shift stays a newline"');
  ok('Shift+Enter is left alone', await fireCapture({ shiftKey: true }), false);
  ok('Shift+Enter does not capture', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="captureThought"}).length'), 0);

  await js('document.getElementById("thought").value = "   "');
  ok('whitespace-only Enter still swallowed', await fireCapture(), true);
  ok('and captures nothing', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="captureThought"}).length'), 0);

  // the two paths that used to leak a newline through
  await js('document.getElementById("thought").value = "mid ime"');
  ok('IME composition is swallowed, not captured', await fireCapture({ keyCode: 229 }), false);
  ok('IME does not capture', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="captureThought"}).length'), 0);
  ok('numpad Enter (keyCode 13, no key) is swallowed', await js(
    '(function(){var t=document.getElementById("thought");t.value="numpad";' +
    'var e=new KeyboardEvent("keydown",{bubbles:true,cancelable:true});' +
    'Object.defineProperty(e,"keyCode",{value:13});' +
    'Object.defineProperty(e,"target",{value:t});' +
    't.dispatchEvent(e);return e.defaultPrevented})()'), true);
  await wait(250);

  await js('window.synapse.__reset()');
  await js('document.getElementById("thought").value = "double fire"');
  await js('capturing = true');                      // simulate a capture in flight
  ok('re-entrant Enter is swallowed', await fireCapture(), true);
  ok('but does not double-submit', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="captureThought"}).length'), 0);
  await js('capturing = false');

  console.log('\nworkspace tabs:');
  await js('window.synapse.__reset()');
  await js('lastScan = {folders:["Ideas","Sub"],suggestions:[],links:[' +
    '{source:"Ideas/a.md",target:"Ideas/Sub/c.md",type:"wikilink"},' +
    '{source:"Ideas/a.md",target:"Tasks/t.md",type:"wikilink"}],nodes:[' +
    '{id:"__root__",type:"root",title:"Vault",containerId:null,noteCount:3},' +
    '{id:"Ideas",type:"folder",title:"Ideas",containerId:"__root__",folder:"Ideas",noteCount:2},' +
    '{id:"Ideas/Sub",type:"folder",title:"Sub",containerId:"Ideas",folder:"Sub",noteCount:1},' +
    '{id:"Tasks",type:"folder",title:"Tasks",containerId:"__root__",folder:"Tasks",noteCount:1},' +
    '{id:"Ideas/a.md",type:"note",title:"A",containerId:"Ideas",folder:"Ideas",tags:[],links:[],mass:10},' +
    '{id:"Ideas/Sub/c.md",type:"note",title:"C",containerId:"Ideas/Sub",folder:"Sub",tags:[],links:[],mass:10},' +
    '{id:"Tasks/t.md",type:"note",title:"T",containerId:"Tasks",folder:"Tasks",tags:[],links:[],mass:10}' +
    ']}');
  // stash it: several flows call refresh(), which reloads from the stub's empty
  // vault and wipes both lastScan and the graph
  await js('window.__fx = lastScan; graph.setData(lastScan)');
  await wait(100);

  ok('master tab exists and is pinned', await js('tabs[0].pinned === true && tabs[0].scopeId === ""'), true);

  // scoping
  ok('unscoped data passes through whole', await js('scopeData(lastScan,"").nodes.length'), 7);
  ok('scoped to Ideas keeps its subtree', await js(
    'scopeData(lastScan,"Ideas").nodes.map(function(n){return n.id}).sort().join(",")'),
    'Ideas,Ideas/Sub,Ideas/Sub/c.md,Ideas/a.md,__root__');
  ok('scoped view excludes other folders', await js(
    'scopeData(lastScan,"Ideas").nodes.some(function(n){return n.id==="Tasks/t.md"})'), false);
  ok('scope folder re-parents onto the root', await js(
    'scopeData(lastScan,"Ideas").nodes.find(function(n){return n.id==="Ideas"}).containerId'), '__root__');
  ok('links crossing the scope are dropped', await js('scopeData(lastScan,"Ideas").links.length'), 1);
  ok('root note count is rescoped', await js(
    'scopeData(lastScan,"Ideas").nodes.find(function(n){return n.type==="root"}).noteCount'), 2);
  ok('a missing scope is reported', await js('scopeData(lastScan,"Ghost").missing'), true);

  // spawning
  // the default set is Master + the pinned Breakdown tab, so a new scope tab is the third
  const baseTabs = await js('tabs.length');
  await js('openTabForNode(graph.map.get("Ideas") || {id:"Ideas",type:"folder",title:"Ideas"})');
  await wait(200);
  ok('a scope tab was added', await js('tabs.length'), baseTabs + 1);
  ok('it is scoped to the folder', await js(
    'tabs.filter(function(t){return t.scopeId==="Ideas"}).length'), 1);
  ok('and became active', await js(
    'activeTabId === tabs.find(function(t){return t.scopeId==="Ideas"}).id'), true);
  ok('tab chips rendered', await js('document.querySelectorAll("#tabs .wtab").length'), baseTabs + 1);
  ok('active chip marked', await js(
    'document.querySelector("#tabs .wtab.active").dataset.tab === tabs.find(function(t){return t.scopeId==="Ideas"}).id'), true);

  ok('re-opening the same folder reuses its tab', await js(
    '(function(){openTabForNode({id:"Ideas",type:"folder",title:"Ideas"});return tabs.length})()'), baseTabs + 1);

  // split view
  await js('toggleSplit()');
  await wait(200);
  ok('split turns the second pane on', await js(
    '!document.getElementById("paneB").classList.contains("hidden")'), true);
  ok('split tab is set', await js('splitTabId !== null'), true);
  ok('panes container marked split', await js(
    'document.querySelector(".panes").classList.contains("split")'), true);
  ok('pane B has its own graph instance', await js('panes.b !== panes.a && !!panes.b'), true);
  ok('badges name each pane', await js('document.getElementById("badgeB").textContent.length > 0'), true);

  await js('focusPane("b")');
  ok('focusing a pane repoints the active graph', await js('graph === panes.b'), true);
  await js('focusPane("a")');

  await js('toggleSplit()');
  await wait(150);
  ok('split toggles back off', await js('splitTabId === null'), true);
  ok('pane B hidden again', await js(
    'document.getElementById("paneB").classList.contains("hidden")'), true);

  // cross-tab routing
  console.log('\ncross-tab routing:');
  // route from the Master tab — a scoped tab legitimately cannot see notes
  // outside its own subtree
  await js('activateTab(tabs[0].id)');
  await wait(200);
  ok('master tab sees the whole vault', await js('!!graph.map.get("Tasks/t.md")'), true);
  await js('window.synapse.__reset()');
  const barBox = await js('JSON.stringify(document.getElementById("tabbar").getBoundingClientRect())');
  const bar = JSON.parse(barBox);
  const chip = JSON.parse(await js(
    'JSON.stringify(document.querySelector(\'#tabs .wtab[data-tab="\' + ' +
    'tabs.find(function(t){return t.scopeId==="Ideas"}).id + \'"]\').getBoundingClientRect())'));
  ok('drop over a tab chip is consumed', await js(
    'onDropOutside("Tasks/t.md",' + (chip.left + chip.width / 2) + ',' + (chip.top + chip.height / 2) + ')'), true);
  await wait(300);
  ok('routed note moved into that tab folder', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="moveNote"})||{}).args)'),
    '["Tasks/t.md","Ideas"]');
  ok('drop far below the bar is not consumed', await js(
    'onDropOutside("Tasks/t.md",' + (chip.left + 5) + ',' + (bar.bottom + 400) + ')'), false);

  console.log('\nbreakdown tab + file drop routing:');
  ok('breakdown tab exists and is pinned', await js(
    '(function(){var t=tabs.find(function(x){return x.kind==="ingest"});return !!t && t.pinned})()'), true);
  ok('its chip is styled as an ingest tab', await js(
    '!!document.querySelector("#tabs .wtab.ingest")'), true);

  // drop onto a note => attach
  await js('window.synapse.__reset()');
  await js('activateTab(tabs[0].id)');
  await wait(150);
  // routeDroppedNode above called refresh(), which reloads from the stub's empty
  // vault — put the fixture back before asking where nodes are on screen
  await js('lastScan = window.__fx; graph.setData(lastScan)');
  await wait(200);
  ok('fixture note is back in the graph', await js('!!graph.map.get("Ideas/a.md")'), true);
  // pin the camera and park the node so the hit-test is deterministic
  // (physics and earlier lens/camera moves otherwise put it anywhere)
  // k must be high enough that the containing folder counts as "open", or the
  // note is legitimately invisible and therefore not hit-testable
  await js('(function(){graph.transform={x:0,y:0,k:2};graph.anim=null;graph.alpha=0;' +
    'var f=graph.map.get("Ideas");f.x=150;f.y=150;f.vx=0;f.vy=0;' +
    'var n=graph.map.get("Ideas/a.md");n.x=150;n.y=150;n.vx=0;n.vy=0;n.r=14;return 1})()');
  await wait(120);
  ok('the note is visible at this zoom', await js(
    'graph._nodeAlpha(graph.map.get("Ideas/a.md"), new Map()) > 0.02'), true);

  // the simulation keeps moving nodes, so locate and hit-test in one evaluation
  const screenOf = (id) =>
    '(function(){var n=graph.map.get("' + id + '");var r=graph.canvas.getBoundingClientRect();' +
    'var t=graph.transform;return {x:r.left+n.x*t.k+t.x,y:r.top+n.y*t.k+t.y}})()';
  ok('a note is the drop target under the cursor', await js(
    '(function(){var p=' + screenOf('Ideas/a.md') + ';return dropTargetAt(p.x,p.y).kind})()'), 'note');
  await js('(function(){var p=' + screenOf('Ideas/a.md') + ';routeDroppedFiles(["C:/tmp/spec.txt"],p.x,p.y)})(); 0');
  await wait(350);
  ok('files attach to the note under the cursor', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="attachToNote"})||{}).args.slice(0,2))'),
    '["Ideas/a.md",["C:/tmp/spec.txt"]]');

  // drop onto the breakdown tab chip => breakdown
  await js('window.synapse.__reset()');
  const ingestChip = JSON.parse(await js(
    'JSON.stringify(document.querySelector("#tabs .wtab.ingest").getBoundingClientRect())'));
  ok('the ingest chip is recognised as a drop target', await js(
    'dropTargetAt(' + (ingestChip.left + ingestChip.width / 2) + ',' + (ingestChip.top + ingestChip.height / 2) + ').tab.kind'), 'ingest');
  await js('routeDroppedFiles(["C:/tmp/report.txt"],' +
    (ingestChip.left + ingestChip.width / 2) + ',' + (ingestChip.top + ingestChip.height / 2) + '); 0');
  await wait(400);
  ok('dropping on it breaks the file down', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="breakdownFile"})||{}).args)'),
    '[["C:/tmp/report.txt"],"Breakdown"]');
  ok('it does not fall through to a plain import', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="importPaths"}).length'), 0);

  // with the breakdown tab active, any drop is broken down
  await js('window.synapse.__reset()');
  await js('activateTab(tabs.find(function(t){return t.kind==="ingest"}).id)');
  await wait(200);
  await js('routeDroppedFiles(["C:/tmp/loose.txt"], 5, 9999); 0');
  await wait(400);
  ok('active breakdown tab claims loose drops', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="breakdownFile"}).length'), 1);

  await js('activateTab(tabs[0].id)');
  await wait(150);

  // pruning
  console.log('\ntab pruning:');
  await js('lastScan = {folders:[],links:[],suggestions:[],nodes:[{id:"__root__",type:"root",title:"Vault",containerId:null}]}');
  await js('pruneTabs()');
  await wait(150);
  ok('tab for a vanished folder is closed', await js(
    'tabs.filter(function(t){return t.scopeId==="Ideas"}).length'), 0);
  ok('pinned tabs survive', await js('tabs.every(function(t){return t.pinned})'), true);
  ok('master survives', await js('!!tabs.find(function(t){return t.id==="master"})'), true);
  ok('breakdown survives', await js('!!tabs.find(function(t){return t.kind==="ingest"})'), true);
  ok('active falls back to a surviving tab', await js('!!tabs.find(function(t){return t.id===activeTabId})'), true);

  console.log('\ndropping a folder imports it as a graph:');
  await js('window.synapse.__reset()');
  // no folders in the drop -> ordinary file import, no tree dialog
  await js('routeDroppedFiles(["C:/tmp/plain.txt"], 5, 9999); 0');
  await wait(350);
  ok('a plain file drop still imports normally', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="importPaths"}).length'), 1);
  ok('and does not import a tree', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="importTree"}).length'), 0);

  // now make scanTree report a folder, as it would for a real directory drop
  await js('window.synapse.__reset()');
  await js('window.synapse.__setScanTree({ok:true,plans:[{root:"C:/tmp/lab2a",name:"lab2a",' +
    'summary:{folders:9,files:14,textFiles:13,otherFiles:1,size:"42 KB",skipped:2,truncated:false},' +
    'sample:["empire","empire/characters"]}]}); 0');
  await js('routeDroppedFiles(["C:/tmp/lab2a"], 5, 9999); 0');
  await wait(400);
  ok('a folder drop asks before importing', await js('askOpen()'), true);
  {
    const text = await js('document.getElementById("askTitle").textContent + " " + document.getElementById("askHint").textContent');
    ok('the dialog names the folder', text.indexOf('lab2a') >= 0, true);
    ok('and states the counts up front', text.indexOf('9 folders') >= 0 && text.indexOf('14 files') >= 0, true);
    ok('and how many are readable', text.indexOf('13 readable') >= 0, true);
    ok('and what it will skip', text.indexOf('2 skipped') >= 0, true);
    ok('and explains the result', text.toLowerCase().indexOf('bubble structure') >= 0, true);
  }
  ok('offers a split choice', await js(
    'Array.prototype.some.call(document.querySelectorAll("#askFields .ask-input"),' +
    'function(i){return i.dataset.key==="split"})'), true);

  await js('document.getElementById("askOk").click()');
  await wait(500);
  ok('importTree called with the folder', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="importTree"})||{}).args[0])'),
    '["C:/tmp/lab2a"]');
  ok('and with the chosen options', await js(
    '(function(){var c=window.synapse.__calls().find(function(x){return x.name==="importTree"});' +
    'return c && typeof c.args[1].split === "boolean" && typeof c.args[1].includeBinaries === "boolean"})()'), true);
  await js('window.synapse.__setScanTree({ok:true,plans:[]}); 0');

  console.log('\nbreakdown usage guide:');
  await js('openSettings(); selectSettingsTab("breakdown"); 0');
  await wait(150);
  ok('guide tab exists', await js('!!document.querySelector(\'.tab[data-tab="breakdown"]\')'), true);
  ok('guide page is shown', await js(
    '!document.querySelector(\'.tabpage[data-page="breakdown"]\').classList.contains("hidden")'), true);
  {
    const text = await js('document.querySelector(\'.tabpage[data-page="breakdown"]\').textContent');
    const has = (s) => text.indexOf(s) >= 0;
    ok('documents the heading rule', has('Headings first'), true);
    ok('documents the list rule', has('#point') || has('point'), true);
    ok('documents the action cues', has('deadline'), true);
    ok('documents the highlight fallback', has('densest sentences'), true);
    ok('lists readable formats', has('.markdown'), true);
    ok('is explicit that PDFs are not parsed', has('not'), true);
    ok('states the size limit', has('64 MB'), true);
    ok('states the part limit', has('40 parts'), true);
    ok('states it never rewrites your text', has('verbatim'), true);
    ok('states nothing leaves the machine', has('no network call'), true);
  }
  await js('closeSettings(); 0');

  console.log('\nfolders are linkable:');
  await js('window.synapse.__reset()');
  await js('makeLink("Ideas", "Tasks"); 0');
  await wait(300);
  ok('folder to folder goes through addWikilink', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="addWikilink"})||{}).args)'),
    '["Ideas","Tasks"]');
  await js('window.synapse.__reset()');
  await js('makeLink("Ideas/a.md", "Tasks"); 0');
  await wait(300);
  ok('note to folder works the same way', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="addWikilink"})||{}).args)'),
    '["Ideas/a.md","Tasks"]');

  console.log('\ndropping a note on a folder parents it there:');
  await js('window.synapse.__reset()');
  await js('makeChild("Ideas/a.md", "Tasks"); 0');
  await wait(300);
  ok('folder target files the note instead of erroring', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="moveNote"})||{}).args)'),
    '["Ideas/a.md","Tasks"]');
  ok('and does not try to set a note parent', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="setParent"}).length'), 0);

  console.log('\nfolders can be selected, moved and deleted:');
  await js('lastScan = window.__fx; graph.setData(lastScan); graph.clearSelection(); 0');
  await wait(150);

  // selection
  await js('graph._toggleSelect(graph.map.get("Ideas")); 0');
  await wait(120);
  ok('a folder can be selected', await js('graph.getSelection().indexOf("Ideas") >= 0'), true);
  ok('the selection bar appears for a folder alone', await js(
    '!document.getElementById("selbar").classList.contains("hidden")'), true);
  ok('it counts folders', await js(
    'document.getElementById("selcount").textContent.indexOf("1 folder") >= 0'), true);
  ok('grouping is hidden with no notes selected', await js(
    'document.getElementById("groupSelected").classList.contains("hidden")'), true);

  await js('graph._toggleSelect(graph.map.get("Ideas/a.md")); 0');
  await wait(120);
  ok('a mixed selection is described', await js(
    'document.getElementById("selcount").textContent.indexOf("note") >= 0 && ' +
    'document.getElementById("selcount").textContent.indexOf("folder") >= 0'), true);
  ok('grouping returns once a note is in', await js(
    '!document.getElementById("groupSelected").classList.contains("hidden")'), true);

  // bulk delete
  await js('window.synapse.__reset()');
  await js('doDeleteSelected(); 0');
  await wait(200);
  ok('bulk delete confirms first', await js('askOpen()'), true);
  await js('document.getElementById("askOk").click()');
  await wait(400);
  ok('the note was trashed', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="deleteNote"})||{}).args)'),
    '["Ideas/a.md"]');
  ok('the folder was trashed', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="deleteFolder"})||{}).args)'),
    '["Ideas"]');
  ok('selection cleared afterwards', await js('graph.getSelection().length'), 0);

  // dragging a folder into another folder
  await js('lastScan = window.__fx; graph.setData(lastScan); 0');
  await wait(120);
  await js('window.synapse.__reset()');
  await js('dropInFolder("Ideas", "Tasks"); 0');
  await wait(300);
  ok('a dragged folder moves as a folder', await js(
    'JSON.stringify((window.synapse.__calls().find(function(c){return c.name==="moveFolder"})||{}).args)'),
    '["Ideas","Tasks"]');
  ok('and does not go through moveNote', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="moveNote"}).length'), 0);

  // a folder can be carried onto another folder via long-press too
  await js('window.synapse.__reset()');
  await js('makeChild("Ideas", "Tasks"); 0');
  await wait(300);
  ok('long-press drop routes folders the same way', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="moveFolder"}).length'), 1);

  // those moves each triggered a refresh against the empty stub vault
  await js('lastScan = window.__fx; graph.setData(lastScan); 0');
  await wait(150);
  ok('a folder cannot be dropped into its own subtree', await js(
    'graph._isDescendant(graph.map.get("Ideas/Sub"), graph.map.get("Ideas"))'), true);
  ok('unrelated folders are not descendants', await js(
    'graph._isDescendant(graph.map.get("Tasks"), graph.map.get("Ideas"))'), false);

  console.log('\ncheck for updates button:');
  await js('window.synapse.__reset()');
  await js('openSettings(); selectSettingsTab("help"); 0');
  await wait(150);
  ok('button exists on the help panel', await js('!!document.getElementById("checkUpdatesBtn")'), true);
  await js('document.getElementById("checkUpdatesBtn").click()');
  await wait(400);
  ok('it asked main to check', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="checkUpdates"}).length'), 1);
  ok('an available update is announced', await js(
    'document.getElementById("updateStatus").textContent.indexOf("0.4.0") >= 0'), true);
  ok('it says what you are running', await js(
    'document.getElementById("updateStatus").textContent.indexOf("0.3.2") >= 0'), true);
  ok('release age shown', await js(
    'document.getElementById("updateStatus").textContent.indexOf("2 days ago") >= 0'), true);
  ok('source builds are told to git pull', await js(
    'document.getElementById("updateStatus").textContent.indexOf("git pull") >= 0'), true);
  ok('release notes rendered', await js(
    'document.getElementById("updateNotes").textContent'), 'Adds the lens engine.');
  ok('view-release button revealed', await js(
    '!document.getElementById("openReleaseBtn").classList.contains("hidden")'), true);
  ok('install button stays hidden until a download is ready', await js(
    'document.getElementById("installUpdateBtn").classList.contains("hidden")'), true);

  await js('document.getElementById("openReleaseBtn").click()');
  await wait(200);
  ok('view release opens it via main', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="openRelease"}).length'), 1);

  // a downloaded update reveals the restart button
  await js('window.synapse.__fireUpdate({state:"ready",version:"0.4.0"}); 0');
  await wait(200);
  ok('restart button appears when ready', await js(
    '!document.getElementById("installUpdateBtn").classList.contains("hidden")'), true);
  await js('document.getElementById("installUpdateBtn").click()');
  await wait(200);
  ok('restart asks main to install', await js(
    'window.synapse.__calls().filter(function(c){return c.name==="installUpdate"}).length'), 1);
  await js('closeSettings(); 0');

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

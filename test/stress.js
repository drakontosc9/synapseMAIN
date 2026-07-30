// Stress harness. Run with:  npx electron test/stress.js [noteCount]
// Loads the real renderer with a large synthetic vault and hammers the heavy
// paths (lenses, split panes, flare, drag hit-testing, rescans) with a REAL
// visible window so the GPU path is exercised. Reports whether the renderer
// survived and how long each phase took.

const { app, BrowserWindow } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const COUNT = Number(process.argv[2]) || 1500;

let crashed = null;
const timings = [];
let finished = false;

function done(code) {
  if (finished) return;
  finished = true;
  console.log('\n--- timings ---');
  for (const t of timings) console.log('  ' + t.name.padEnd(34) + t.ms + 'ms');
  if (crashed) console.log('\nRENDERER CRASHED: ' + JSON.stringify(crashed));
  else console.log('\nrenderer survived');
  setTimeout(() => app.exit(code), 60);
}
setTimeout(() => { console.log('TIMED OUT'); done(1); }, 180000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: true,
    webPreferences: {
      preload: path.join(ROOT, 'test', 'smoke-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.webContents.on('render-process-gone', (_e, details) => { crashed = details; done(1); });
  win.webContents.on('console-message', (...args) => {
    const a = (args[0] && typeof args[0] === 'object' && 'level' in args[0]) ? args[0] : { level: args[1], message: args[2] };
    if (a.level === 'error' || a.level === 3) console.log('  [renderer error] ' + String(a.message).slice(0, 200));
  });

  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise(r => setTimeout(r, 1200));

  const js = (code) => win.webContents.executeJavaScript(code, true);
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  async function phase(name, code, settle) {
    if (crashed) return;
    const t0 = Date.now();
    try { await js(code); }
    catch (err) { console.log('  [threw] ' + name + ': ' + String(err.message).slice(0, 160)); }
    await wait(settle == null ? 700 : settle);
    timings.push({ name, ms: Date.now() - t0 });
    console.log('  done: ' + name);
  }

  console.log('building a ' + COUNT + '-note graph in the renderer...');

  // Build the dataset inside the page to avoid a giant IPC payload.
  await js(`
    (function(){
      var COUNT = ${COUNT};
      var folders = ['Tasks','Ideas','Journal','Research','People','Projects','Quotes','My Notes'];
      var tags = ['todo','idea','deep','work','home','maybe','later','urgent','draft','review'];
      var nodes = [{id:'__root__',type:'root',title:'Vault',containerId:null,noteCount:COUNT}];
      for (var i=0;i<folders.length;i++){
        nodes.push({id:folders[i],type:'folder',title:folders[i],containerId:'__root__',folder:folders[i],noteCount:0});
        for (var s=0;s<3;s++){
          var sub = folders[i]+'/sub'+s;
          nodes.push({id:sub,type:'folder',title:'sub'+s,containerId:folders[i],folder:'sub'+s,noteCount:0});
        }
      }
      var links = [];
      for (var n=0;n<COUNT;n++){
        var f = folders[n % folders.length];
        var container = (n % 3 === 0) ? f : f + '/sub' + (n % 3);
        var id = container + '/note-' + n + '.md';
        nodes.push({
          id:id, type:'note', title:'Note '+n, containerId:container,
          folder:container.split('/').pop(),
          tags:[tags[n%tags.length], tags[(n*7)%tags.length]],
          links:[], parentNote: (n>7 ? container+'/note-'+(n-8)+'.md' : null),
          created:new Date(Date.now()-n*3600000).toISOString(),
          mass: 50 + (n*37)%3000,
          excerpt:'excerpt for note '+n,
          search:'note '+n+' body text'
        });
        if (n>0) links.push({source:id,target:container+'/note-'+(n-1)+'.md',type:'wikilink'});
        if (n>7) links.push({source:container+'/note-'+(n-8)+'.md',target:id,type:'parent'});
        if (n%5===0 && n>20) links.push({source:id,target:container+'/note-'+(n-20)+'.md',type:'tag'});
      }
      var byId = {}; nodes.forEach(function(x){byId[x.id]=x;});
      links = links.filter(function(l){return byId[l.source] && byId[l.target];});
      var folderCounts = {};
      nodes.forEach(function(x){ if(x.type==='note'){ var c=x.containerId; while(c){ folderCounts[c]=(folderCounts[c]||0)+1; c = c.indexOf('/')>=0 ? c.slice(0,c.lastIndexOf('/')) : null; } } });
      nodes.forEach(function(x){ if(x.type==='folder') x.noteCount = folderCounts[x.id]||0; });
      var suggestions = [];
      for (var k=0;k<400;k++) suggestions.push({a:nodes[20+k].id,b:nodes[21+k].id,shared:1});
      window.__big = {nodes:nodes,links:links,folders:folders,suggestions:suggestions,busyTags:[]};
      lastScan = window.__big;
      return nodes.length + ' nodes / ' + links.length + ' links';
    })()
  `).then(s => console.log('  ' + s));

  await phase('setData (cold)', 'graph.setData(window.__big)', 2500);
  await phase('fit', 'graph.home()', 1200);
  await phase('zoom in hard', 'graph.transform.k = 3.2; graph.reheat(1)', 1500);
  await phase('zoom out hard', 'graph.transform.k = 0.2; graph.reheat(1)', 1500);
  await phase('lens: mind', 'setLens("mind")', 2500);
  await phase('lens: skills', 'setLens("skills")', 2500);
  await phase('lens: knowledge', 'setLens("knowledge")', 2500);
  await phase('lens: free', 'setLens("free")', 2000);
  await phase('flare hub node', 'graph.flare(window.__big.nodes[40].id)', 2000);
  await phase('select all visible', 'graph.selectAllVisible()', 1200);
  await phase('search everything', 'graph.setSearch("note")', 1500);
  await phase('clear search', 'graph.setSearch("")', 800);

  await phase('open split pane',
    '(function(){tabs.push({id:"stress",title:"Tasks",scopeId:"Tasks",kind:"scope",lens:"free"});' +
    'renderTabs();activateTab("stress");return 1})()', 2000);
  await phase('split view on', 'toggleSplit()', 2500);
  await phase('both panes: lens mind', 'setLens("mind")', 2500);
  await phase('both panes: heavy zoom',
    '(function(){panes.a.transform.k=2.6;panes.b.transform.k=2.6;panes.a.reheat(1);panes.b.reheat(1);return 1})()', 2500);
  await phase('split view off', 'toggleSplit()', 1500);

  await phase('hit-test storm (drag simulation)',
    '(function(){for(var i=0;i<400;i++){graph._nodeAt(400+(i%300),300+(i%200));}return 1})()', 800);
  await phase('drop-target storm',
    '(function(){for(var i=0;i<300;i++){dropTargetAt(500+(i%200),400+(i%150));}return 1})()', 800);
  await phase('repeated setData x8',
    '(function(){for(var i=0;i<8;i++){graph.setData(window.__big);}return 1})()', 3000);

  await wait(1500);
  done(crashed ? 1 : 0);
});

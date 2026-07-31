// Live main-process test. Run with:  npx electron test/ipc-live.js
// Boots the real main.js against a throwaway vault and calls the actual IPC
// handlers, so folder ops / import / burner logic are tested on real files.

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-live-'));

// Point Electron's userData somewhere disposable and pre-seed the vault choice
// so main.js starts up already pointed at our sandbox.
const { app, ipcMain } = require('electron');
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-ud-'));
app.setPath('userData', USERDATA);
fs.writeFileSync(path.join(USERDATA, 'synapse-settings.json'),
  JSON.stringify({ vaultPath: VAULT, quickCaptureEnabled: false, runInTray: false }));

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  OK   ' + name); pass++; }
  else { console.log('  FAIL ' + name + '  got=' + g + ' want=' + w); fail++; }
};
const truthy = (name, v) => ok(name, !!v, true);

// Call a registered ipcMain.handle listener directly.
function invoke(channel, ...args) {
  const handlers = ipcMain._invokeHandlers;
  const fn = handlers && handlers.get(channel);
  if (!fn) throw new Error('no handler registered for ' + channel);
  return Promise.resolve(fn({}, ...args));
}

const rel = (...p) => path.join(VAULT, ...p);
const writeNote = (relPath, title, body, extra) => {
  const full = rel(relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const lines = ['---', 'title: "' + title + '"', 'created: 2026-07-01T00:00:00.000Z',
    'folder: ' + path.dirname(relPath), 'tags: []'];
  if (extra) for (const [k, v] of Object.entries(extra)) lines.push(k + ': ' + v);
  lines.push('---', '', body);
  fs.writeFileSync(full, lines.join('\n'));
};

setTimeout(() => { console.log('TIMED OUT'); app.exit(1); }, 45000);

require(path.join(ROOT, 'main.js'));

app.whenReady().then(async () => {
  await new Promise(r => setTimeout(r, 400));   // let main.js finish wiring

  console.log('open-folder:');
  {
    fs.mkdirSync(rel('Ideas'), { recursive: true });
    writeNote('Ideas/a.md', 'Alpha', 'body');
    const r = await invoke('open-folder', 'Ideas/a.md');
    // a headless CI box may have no file manager; either way it must not throw
    truthy('resolves for a note path', r && typeof r.ok === 'boolean');
    const bad = await invoke('open-folder', '../../escape').catch(e => ({ threw: String(e.message) }));
    truthy('refuses a path outside the vault', bad.threw && bad.threw.indexOf('outside') >= 0);
  }

  console.log('\nrename-folder:');
  {
    writeNote('Ideas/b.md', 'Beta', 'body');
    const r = await invoke('rename-folder', 'Ideas', 'Concepts');
    ok('renames', r.ok, true);
    ok('new id returned', r.id, 'Concepts');
    truthy('old folder gone', !fs.existsSync(rel('Ideas')));
    truthy('files moved', fs.existsSync(rel('Concepts', 'a.md')));
    const raw = fs.readFileSync(rel('Concepts', 'a.md'), 'utf8');
    truthy('folder field updated inside notes', raw.indexOf('folder: Concepts') >= 0);

    fs.mkdirSync(rel('Taken'), { recursive: true });
    const clash = await invoke('rename-folder', 'Concepts', 'Taken');
    ok('refuses to clobber an existing folder', clash.ok, false);
  }

  console.log('\nmerge-folders:');
  {
    fs.mkdirSync(rel('Scratch'), { recursive: true });
    writeNote('Scratch/c.md', 'Gamma', 'body');
    writeNote('Scratch/d.md', 'Delta', 'body');
    const r = await invoke('merge-folders', 'Scratch', 'Concepts');
    ok('merge reports moved files', r.moved.length, 2);
    truthy('source folder removed', !fs.existsSync(rel('Scratch')));
    truthy('files landed in the target', fs.existsSync(rel('Concepts', 'c.md')));
    const raw = fs.readFileSync(rel('Concepts', 'c.md'), 'utf8');
    truthy('folder field rewritten on merge', raw.indexOf('folder: Concepts') >= 0);

    const self = await invoke('merge-folders', 'Concepts', 'Concepts');
    ok('refuses to merge into itself', self.ok, false);

    fs.mkdirSync(rel('Outer', 'Inner'), { recursive: true });
    const nested = await invoke('merge-folders', 'Outer', 'Outer/Inner');
    ok('refuses to merge into own subfolder', nested.ok, false);
  }

  console.log('\ncreate-note:');
  {
    const explicit = await invoke('create-note', 'a deliberate thought', 'Concepts', {});
    ok('lands in the folder asked for', explicit.folder, 'Concepts');
    ok('not classifier-guessed', explicit.guessed, false);
    truthy('file exists', fs.existsSync(rel(explicit.id)));

    const guessed = await invoke('create-note', 'todo: buy milk', null, {});
    ok('null folder means classify', guessed.guessed, true);

    const burner = await invoke('create-note', 'temporary thought', 'Concepts', { ttlHours: 2 });
    const raw = fs.readFileSync(rel(burner.id), 'utf8');
    truthy('burner note carries expires', raw.indexOf('expires:') >= 0);

    let threw = null;
    await invoke('create-note', '   ', 'Concepts', {}).catch(e => { threw = e.message; });
    truthy('empty text is rejected', threw && threw.indexOf('Nothing') >= 0);
  }

  console.log('\nimport-paths (auto-split):');
  {
    const src = path.join(os.tmpdir(), 'import-doc-' + Date.now() + '.md');
    fs.writeFileSync(src, ['# One', 'first section', '', '# Two', 'second section'].join('\n'));
    const r = await invoke('import-paths', [src], { folder: 'Imported', split: true });
    ok('split creates parent + sections', r.created.length, 3);
    const child = fs.readFileSync(rel(r.created[1].id), 'utf8');
    truthy('sections are parented to the document', child.indexOf('parent:') >= 0);

    const flat = await invoke('import-paths', [src], { folder: 'Imported', split: false });
    ok('without split it is one note', flat.created.length, 1);

    const txt = path.join(os.tmpdir(), 'plain-' + Date.now() + '.txt');
    fs.writeFileSync(txt, 'just some text');
    const t = await invoke('import-paths', [txt], { folder: 'Imported' });
    ok('text file imports as a note', t.created.length, 1);

    const bin = path.join(os.tmpdir(), 'thing-' + Date.now() + '.png');
    fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const b = await invoke('import-paths', [bin], { folder: 'Imported' });
    ok('binary is copied to attachments', b.created.length, 1);
    truthy('attachment file exists', fs.readdirSync(rel('attachments')).length > 0);
    const noteBody = fs.readFileSync(rel(b.created[0].id), 'utf8');
    truthy('note embeds the attachment', noteBody.indexOf('attachments/') >= 0);

    const missing = await invoke('import-paths', ['C:/definitely/not/here.txt'], { folder: 'Imported' });
    ok('unreadable path is skipped, not fatal', missing.skipped.length, 1);
  }

  console.log('\nfolder notes make folders linkable:');
  {
    fs.mkdirSync(rel('Alpha'), { recursive: true });
    fs.mkdirSync(rel('Beta'), { recursive: true });
    writeNote('Beta/thing.md', 'Thing', 'a note');

    const r = await invoke('ensure-folder-note', 'Alpha');
    ok('folder note id follows the folder name', r.id, 'Alpha/Alpha.md');
    truthy('the file was created', fs.existsSync(rel('Alpha', 'Alpha.md')));
    const fmText = fs.readFileSync(rel('Alpha', 'Alpha.md'), 'utf8');
    truthy('it is tagged as a folder note', fmText.indexOf('tags: [folder]') >= 0);

    const again = await invoke('ensure-folder-note', 'Alpha');
    ok('asking twice reuses the same file', again.id, 'Alpha/Alpha.md');

    // folder -> folder link, written into Alpha's own note
    const link = await invoke('add-wikilink', 'Alpha', 'Beta');
    ok('folder to folder links', link.ok, true);
    truthy('the link lands in the folder note',
      fs.readFileSync(rel('Alpha', 'Alpha.md'), 'utf8').indexOf('[[Beta]]') >= 0);
    truthy('the target folder note was created too', fs.existsSync(rel('Beta', 'Beta.md')));

    // note -> folder
    const link2 = await invoke('add-wikilink', 'Beta/thing.md', 'Alpha');
    ok('note to folder links', link2.ok, true);
    truthy('written into the note',
      fs.readFileSync(rel('Beta', 'thing.md'), 'utf8').indexOf('[[Alpha]]') >= 0);

    const self = await invoke('add-wikilink', 'Alpha', 'Alpha');
    ok('a folder cannot link to itself', self.ok, false);

    // and the scan turns those into edges between the bubbles
    const m = await invoke('scan-vault');
    const ids = new Set(m.nodes.map(n => n.id));
    truthy('folder note is not a node of its own', !ids.has('Alpha/Alpha.md'));
    truthy('folder to folder edge exists',
      m.links.some(l => l.type === 'wikilink' &&
        ((l.source === 'Alpha' && l.target === 'Beta') || (l.source === 'Beta' && l.target === 'Alpha'))));
  }

  console.log('\nmove-folder:');
  {
    fs.mkdirSync(rel('Movable', 'Inner'), { recursive: true });
    writeNote('Movable/m.md', 'M', 'body');
    fs.mkdirSync(rel('Target'), { recursive: true });

    const r = await invoke('move-folder', 'Movable', 'Target');
    ok('moved', r.ok, true);
    ok('new id reported', r.to, 'Target/Movable');
    truthy('contents came along', fs.existsSync(rel('Target', 'Movable', 'm.md')));
    truthy('sub-folders came along', fs.existsSync(rel('Target', 'Movable', 'Inner')));
    truthy('old location gone', !fs.existsSync(rel('Movable')));

    const into_self = await invoke('move-folder', 'Target', 'Target');
    ok('refuses to move into itself', into_self.ok, false);
    const into_child = await invoke('move-folder', 'Target', 'Target/Movable');
    ok('refuses to move into its own subfolder', into_child.ok, false);
    const same = await invoke('move-folder', 'Target/Movable', 'Target');
    ok('moving where it already is is a no-op', same.already, true);
  }

  console.log('\nattach-to-note:');
  {
    writeNote('Concepts/host.md', 'Host', 'original body');
    const txt = path.join(os.tmpdir(), 'attach-' + Date.now() + '.txt');
    fs.writeFileSync(txt, 'appended content here');
    const img = path.join(os.tmpdir(), 'attach-' + Date.now() + '.png');
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const r = await invoke('attach-to-note', 'Concepts/host.md', [txt, img], { alsoChildNotes: true });
    ok('both files attached', r.attached.length, 2);
    const body = fs.readFileSync(rel('Concepts', 'host.md'), 'utf8');
    truthy('original body preserved', body.indexOf('original body') >= 0);
    truthy('text file inlined', body.indexOf('appended content here') >= 0);
    truthy('binary embedded as a link', body.indexOf('attachments/') >= 0);
    ok('binary also became a child note', r.children.length, 1);
    const child = fs.readFileSync(rel(r.children[0].id), 'utf8');
    truthy('child points back at the host', child.indexOf('Concepts/host.md') >= 0);

    let threw = null;
    await invoke('attach-to-note', '../outside.md', [txt], {}).catch(e => { threw = e.message; });
    truthy('refuses a host outside the vault', threw && threw.indexOf('outside') >= 0);
  }

  console.log('\nbreakdown-file:');
  {
    const doc = path.join(os.tmpdir(), 'breakdown-' + Date.now() + '.txt');
    fs.writeFileSync(doc, [
      'Kickoff notes.',
      '- hire the contractor',
      '- order the parts',
      'TODO: book the venue'
    ].join('\n'));

    const r = await invoke('breakdown-file', [doc], 'Breakdown');
    ok('one document produced', r.docs.length, 1);
    truthy('several parts extracted', r.docs[0].parts.length >= 3);
    truthy('document note exists', fs.existsSync(rel(r.docs[0].doc.id)));

    const partBody = fs.readFileSync(rel(r.docs[0].parts[0].id), 'utf8');
    truthy('parts are parented to the document', partBody.indexOf(r.docs[0].doc.id) >= 0);
    truthy('parts carry a kind tag', /#(point|action|highlight)/.test(partBody));

    const summary = fs.readFileSync(rel(r.docs[0].doc.id), 'utf8');
    truthy('document note names the source', summary.indexOf(path.basename(doc)) >= 0);

    // binary files cannot be read into parts, but must still be filed
    const bin = path.join(os.tmpdir(), 'blob-' + Date.now() + '.png');
    fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const b = await invoke('breakdown-file', [bin], 'Breakdown');
    ok('binary yields a document with no parts', b.docs[0].parts.length, 0);
    truthy('and says why', b.docs[0].note.indexOf('binary') >= 0);

    const gone = await invoke('breakdown-file', ['C:/nope/missing.txt'], 'Breakdown');
    ok('missing file is skipped, not fatal', gone.skipped.length, 1);
  }

  console.log('\nburner expiry:');
  {
    writeNote('Concepts/dead.md', 'Expired', 'gone soon', { expires: '2000-01-01T00:00:00.000Z' });
    writeNote('Concepts/alive.md', 'Alive', 'stays', { expires: '2099-01-01T00:00:00.000Z' });
    const r = await invoke('purge-expired');
    ok('one expired note removed', r.removed, 1);
    truthy('expired file deleted', !fs.existsSync(rel('Concepts', 'dead.md')));
    truthy('future-dated note kept', fs.existsSync(rel('Concepts', 'alive.md')));

    const set = await invoke('set-note-ttl', 'Concepts/alive.md', 0);
    ok('ttl can be cleared', set.expires, null);
    truthy('expires field gone', fs.readFileSync(rel('Concepts', 'alive.md'), 'utf8').indexOf('expires:') === -1);
  }

  console.log('\nvault-has-notes:');
  {
    const r = await invoke('vault-has-notes');
    ok('reports notes present', r.hasNotes, true);
    truthy('counts them', r.count > 0);
  }

  console.log('\ndelete-folder (to trash):');
  {
    fs.mkdirSync(rel('Doomed'), { recursive: true });
    writeNote('Doomed/x.md', 'X', 'body');
    const r = await invoke('delete-folder', 'Doomed');
    ok('reports success', r.ok, true);
    truthy('folder gone from the vault', !fs.existsSync(rel('Doomed')));
  }

  console.log('\ncheck-updates (hits the real GitHub API):');
  {
    const r = await invoke('check-updates');
    truthy('responds', !!r);
    ok('reports the running version', r.current, app.getVersion());
    ok('knows it is not a packaged build', r.packaged, false);
    // the packaged app has no build.publish; resolution must never depend on it
    truthy('never fails for want of a configured repo',
      !(r.error || '').match(/No GitHub repository/i));
    if (r.ok) {
      truthy('status is one of none/current/available',
        ['none', 'current', 'available'].indexOf(r.status) >= 0);
      if (r.status !== 'none') {
        ok('names the repo it checked', r.repo, 'drakontosc9/synapseMAIN');
        truthy('returns a latest version string', typeof r.latest === 'string' && r.latest.length > 0);
        truthy('returns a release url', /^https:\/\/github\.com\//.test(r.url || ''));
        ok('never auto-installs from a dev build', r.canAutoInstall, false);
      }
      console.log('      (live: running ' + r.current + ', latest ' + (r.latest || 'none') + ', status ' + r.status + ')');
    } else {
      // offline or rate-limited is a legitimate outcome, but it must be reported
      truthy('failure carries a message', typeof r.error === 'string' && r.error.length > 0);
      console.log('      (live check unavailable: ' + r.error + ')');
    }
  }

  console.log('\nsettings must never lose the vault pointer:');
  {
    const settingsFile = path.join(USERDATA, 'synapse-settings.json');
    const before = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    truthy('vault path is stored', !!before.vaultPath);

    // A config write (the most frequent save) must not blank the vault.
    await invoke('set-config', { accent: '#ff0000' });
    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    ok('vault path survives a config write', after.vaultPath, before.vaultPath);
    ok('and the config change landed', after.config.accent, '#ff0000');

    // Even if something blanks it in memory, the stored path wins.
    await invoke('set-settings', { groupCreate: 'both' });
    const after2 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    ok('vault path survives a settings write', after2.vaultPath, before.vaultPath);
  }

  console.log('\npath containment on the real handlers:');
  {
    for (const [ch, args] of [
      ['read-note', ['../../../etc/passwd']],
      ['write-note', ['../escape.md', 'x']],
      ['delete-note', ['../escape.md']],
      ['rename-folder', ['../up', 'nope']]
    ]) {
      let threw = null;
      await invoke(ch, ...args).catch(e => { threw = e.message; });
      truthy(ch + ' refuses to escape the vault', threw && threw.indexOf('outside') >= 0);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed.');
  try { fs.rmSync(VAULT, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
});

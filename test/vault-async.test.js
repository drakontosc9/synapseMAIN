// Tests for the async + cached vault scan and the filing-rule learner.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  try { assert.deepStrictEqual(got, want); console.log('  ✓ ' + name); pass++; }
  catch { console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); fail++; }
};
const truthy = (name, v) => ok(name, !!v, true);

const vault = require('../vault');
const classifier = require('../classifier');

function makeVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vasync-'));
  fs.mkdirSync(path.join(dir, 'Ideas'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Ideas/a.md'),
    '---\ntitle: "Alpha"\nfolder: Ideas\ntags: [x]\n---\nAlpha body mentions [[Beta]].');
  fs.writeFileSync(path.join(dir, 'Tasks/b.md'),
    '---\ntitle: "Beta"\nfolder: Tasks\ntags: [x]\n---\nBeta body.');
  return dir;
}

(async function run() {
  console.log('vault.scanAsync:');
  {
    const dir = makeVault();
    vault.clearCache();
    const sync = vault.scan(dir);
    vault.clearCache();
    const async1 = await vault.scanAsync(dir);

    ok('same node count as sync scan', async1.nodes.length, sync.nodes.length);
    ok('same link count as sync scan', async1.links.length, sync.links.length);
    ok('folders match sync scan', async1.folders, sync.folders);
    truthy('wikilink edge resolved', async1.links.some(l => l.type === 'wikilink'));
  }

  console.log('\nvault parse cache:');
  {
    const dir = makeVault();
    vault.clearCache();

    // Count real reads by watching for a changed mtime being picked up.
    const first = await vault.scanAsync(dir);
    const titleOf = (m, id) => (m.nodes.find(n => n.id === id) || {}).title;
    ok('first scan reads title', titleOf(first, 'Ideas/a.md'), 'Alpha');

    // Cached scan with no disk change returns the same content.
    const second = await vault.scanAsync(dir);
    ok('cached scan is stable', titleOf(second, 'Ideas/a.md'), 'Alpha');

    // Change the file; mtime+size differ, so the cache must be bypassed.
    fs.writeFileSync(path.join(dir, 'Ideas/a.md'),
      '---\ntitle: "Alpha renamed"\nfolder: Ideas\ntags: [x]\n---\nDifferent body entirely.');
    const third = await vault.scanAsync(dir);
    ok('edited file is re-read', titleOf(third, 'Ideas/a.md'), 'Alpha renamed');

    // clearCache must not change results
    vault.clearCache();
    const fourth = await vault.scanAsync(dir);
    ok('clearCache is transparent', titleOf(fourth, 'Ideas/a.md'), 'Alpha renamed');
  }

  console.log('\nvault holds a digest, not the whole body:');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vdigest-'));
    fs.mkdirSync(path.join(dir, 'Big'), { recursive: true });
    const para = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod. ';
    const body = para.repeat(200);                 // ~14k characters
    fs.writeFileSync(path.join(dir, 'Big/long.md'),
      ['---', 'title: "Long"', 'folder: Big', 'tags: [x]', '---', body].join('\n'));
    // whitespace-heavy prefix: the excerpt must still come out full length
    fs.writeFileSync(path.join(dir, 'Big/spaced.md'),
      ['---', 'title: "Spaced"', 'folder: Big', 'tags: [x]', '---',
        '\n\n\n     \n\n' + para.repeat(20)].join('\n'));

    vault.clearCache();
    const m = await vault.scanAsync(dir);
    const long = m.nodes.find(n => n.id === 'Big/long.md');
    const spaced = m.nodes.find(n => n.id === 'Big/spaced.md');

    ok('the raw body is not carried on the node', long.body, undefined);
    ok('excerpt is capped', long.excerpt.length, 160);
    ok('excerpt has collapsed whitespace', /\s{2,}/.test(long.excerpt), false);
    ok('leading blank lines do not truncate the excerpt', spaced.excerpt.length, 160);

    truthy('search text is bounded well below the body', long.search.length < body.length / 2);
    truthy('search still contains real body text', long.search.indexOf('lorem ipsum') >= 0);
    truthy('search is lowercased', long.search === long.search.toLowerCase());
    truthy('filename stays searchable', long.search.indexOf('long') >= 0);
    truthy('mass still reflects the full body', long.mass > 10000);

    // the whole payload must stay proportionate to the digest, not the vault
    const payload = JSON.stringify(m).length;
    truthy('scan payload stays smaller than the source text', payload < body.length * 2);
  }

  console.log('\nvault tag fan-out guard:');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfanout-'));
    fs.mkdirSync(path.join(dir, 'Bulk'), { recursive: true });
    // 120 notes sharing one tag would be 7140 pairs without the cap
    for (let i = 0; i < 120; i++) {
      fs.writeFileSync(path.join(dir, 'Bulk/n' + i + '.md'),
        '---\ntitle: "N' + i + '"\nfolder: Bulk\ntags: [everything]\n---\nbody');
    }
    vault.clearCache();
    const m = await vault.scanAsync(dir);
    ok('over-popular tag makes no edges', m.links.filter(l => l.type === 'tag').length, 0);
    ok('and no suggestions either', m.suggestions.length, 0);
    ok('but all notes still appear', m.nodes.filter(n => n.type === 'note').length, 120);
    ok('the skip is reported, not silent', m.busyTags, [{ tag: 'everything', count: 120 }]);

    // a tag under the cap still wires up normally
    const small = fs.mkdtempSync(path.join(os.tmpdir(), 'vsmall-'));
    fs.mkdirSync(path.join(small, 'A'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(small, 'A/n' + i + '.md'),
        '---\ntitle: "N' + i + '"\nfolder: A\ntags: [shared]\n---\nbody');
    }
    vault.clearCache();
    const sm = await vault.scanAsync(small);
    ok('normal tag makes all pairs', sm.links.filter(l => l.type === 'tag').length, 10);
    ok('and reports no busy tags', sm.busyTags, []);
  }

  console.log('\nclassifier.learnableTerms:');
  {
    ok('drops stopwords and short words',
      classifier.learnableTerms('I need to refactor the payment gateway'),
      ['need', 'refactor', 'payment', 'gateway']);
    ok('dedupes repeats',
      classifier.learnableTerms('budget budget budget spreadsheet'),
      ['budget', 'spreadsheet']);
    ok('respects the limit',
      classifier.learnableTerms('alpha bravo charlie delta echo foxtrot golf hotel', 3).length, 3);
    ok('empty input is safe', classifier.learnableTerms(''), []);
    ok('null input is safe', classifier.learnableTerms(null), []);
    ok('ignores digits and punctuation', classifier.learnableTerms('123 !!! ok?'), []);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed.');
  process.exit(fail ? 1 : 0);
})();

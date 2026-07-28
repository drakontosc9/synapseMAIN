// Minimal test harness (no dependencies) for the classifier.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const c = require('../classifier');

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'rules.json'), 'utf8'));
let pass = 0, fail = 0;
function check(name, got, want) {
  try { assert.strictEqual(got, want); console.log('  ✓ ' + name); pass++; }
  catch { console.log('  ✗ ' + name + '  (got "' + got + '", want "' + want + '")'); fail++; }
}

console.log('classify() routing:');
check('todo -> Tasks',        c.classify('Remember to email Sam about the deadline', rules).folder, 'Tasks');
check('idea -> Ideas',        c.classify('Idea: what if the app auto-tagged photos', rules).folder, 'Ideas');
check('journal -> Journal',   c.classify('Today I felt grateful and a bit tired', rules).folder, 'Journal');
check('research -> Research', c.classify('Research how does caching improve latency', rules).folder, 'Research');
check('explicit #tag wins',   c.classify('random musing #idea', rules).folder, 'Ideas');
check('no match -> Inbox',    c.classify('xyzzy plugh', rules).folder, 'Inbox');

console.log('\nextraction:');
check('tags',      JSON.stringify(c.extractTags('a #foo and #bar-baz here')), JSON.stringify(['foo', 'bar-baz']));
check('wikilinks', JSON.stringify(c.extractLinks('see [[Note A]] and [[Note B|alias]]')), JSON.stringify(['Note A', 'Note B']));
check('title',     c.deriveTitle('Buy oat milk and call the dentist tomorrow morning about the'), 'Buy oat milk and call the dentist tomorrow');
check('slug',      c.slugify('Hello, World! #idea'), 'hello-world-idea');

console.log('\nbuildNote + parseNote round-trip:');
const built = c.buildNote('Ship the [[Graph View]] milestone #project', 'Projects', ['project']);
const parsed = c.parseNote(built.content);
check('folder preserved', parsed.folder, 'Projects');
check('tags preserved',   parsed.tags.includes('project'), true);
check('link parsed',      parsed.links[0], 'Graph View');

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);

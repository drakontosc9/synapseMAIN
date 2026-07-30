// Tests for the auto-split Markdown engine.
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, got, want) => {
  try { assert.deepStrictEqual(got, want); console.log('  ✓ ' + name); pass++; }
  catch { console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); fail++; }
};

const { splitMarkdown, parseNote, breakdown } = require('../classifier');
const NL = '\n';

console.log('splitMarkdown — heading mode:');
{
  const doc = [
    '# Project Atlas',
    'Intro paragraph.',
    '',
    '## Goals',
    'Ship the thing.',
    'Then ship more.',
    '',
    '## Risks',
    'It might not work.'
  ].join(NL);
  const parts = splitMarkdown(doc);
  ok('one section per heading', parts.length, 3);
  ok('titles come from headings', parts.map(p => p.title), ['Project Atlas', 'Goals', 'Risks']);
  ok('body follows its heading', parts[1].body, 'Ship the thing.' + NL + 'Then ship more.');
  ok('trailing section captured', parts[2].body, 'It might not work.');
}

console.log('\nsplitMarkdown — blank-line mode (no headings):');
{
  const doc = ['First thought here.', '', 'Second thought here.', '', '', 'Third one.'].join(NL);
  const parts = splitMarkdown(doc);
  ok('splits on blank lines', parts.length, 3);
  ok('derives a title from the text', parts[0].title, 'First thought here.');
  ok('keeps the body', parts[2].body, 'Third one.');
}

console.log('\nsplitMarkdown — edge cases:');
{
  ok('empty document yields nothing', splitMarkdown(''), []);
  ok('whitespace only yields nothing', splitMarkdown(NL + NL + '   ' + NL), []);
  const single = splitMarkdown('Just one paragraph with no breaks.');
  ok('single paragraph is one section', single.length, 1);

  // frontmatter must be stripped, not treated as content
  const withFm = ['---', 'title: "Doc"', 'folder: Ideas', '---', '# A', 'body a', '', '# B', 'body b'].join(NL);
  const parts = splitMarkdown(withFm);
  ok('frontmatter is not a section', parts.length, 2);
  ok('first section is the real heading', parts[0].title, 'A');

  // headings win over blank lines when both are present
  const mixed = ['# H1', 'a', '', 'b', '', '# H2', 'c'].join(NL);
  const m = splitMarkdown(mixed);
  ok('blank lines do not split inside a heading section', m.length, 2);
  ok('heading section keeps its blank lines', m[0].body.indexOf('b') >= 0, true);

  ok('minChars filters tiny fragments', splitMarkdown(['aaaa', '', 'b'].join(NL), { minChars: 2 }).length, 1);
}

console.log('\nbreakdown — structured documents:');
{
  const doc = ['# Plan', 'intro', '', '## Phase one', 'do the thing', '', '## Phase two', 'do more'].join(NL);
  const parts = breakdown(doc);
  ok('uses headings when present', parts.length, 3);
  ok('marks them as sections', parts[0].kind, 'section');
  ok('keeps heading titles', parts.map(p => p.title), ['Plan', 'Phase one', 'Phase two']);
}

console.log('\nbreakdown — list mining:');
{
  const doc = [
    'Meeting notes from Tuesday.',
    '- ship the installer',
    '* write the changelog',
    '1. tell the users',
    'Some trailing prose that is not a list item at all.'
  ].join(NL);
  const parts = breakdown(doc);
  const bodies = parts.map(p => p.body);
  ok('dash bullets extracted', bodies.indexOf('ship the installer') >= 0, true);
  ok('star bullets extracted', bodies.indexOf('write the changelog') >= 0, true);
  ok('numbered items extracted', bodies.indexOf('tell the users') >= 0, true);
  ok('list items marked as points', parts.find(p => p.body === 'ship the installer').kind, 'point');
}

console.log('\nbreakdown — action cues:');
{
  const doc = [
    'General background chatter that says nothing much.',
    'TODO: renew the certificate',
    'We decided to postpone the launch until March.',
    'The deadline is the 14th.'
  ].join(NL);
  const parts = breakdown(doc);
  const kinds = parts.map(p => p.kind);
  ok('cue lines are picked up', parts.length >= 3, true);
  ok('and marked as actions', kinds.indexOf('action') >= 0, true);
  ok('todo line captured', parts.some(p => p.body.indexOf('renew the certificate') >= 0), true);
  ok('decision line captured', parts.some(p => p.body.indexOf('postpone the launch') >= 0), true);
}

console.log('\nbreakdown — prose fallback:');
{
  const doc = 'The migration replaced the legacy scheduler with a queue-backed worker pool. ' +
    'Throughput improved substantially under sustained load during the trial period. ' +
    'Short one.';
  const parts = breakdown(doc);
  ok('falls back to dense sentences', parts.length >= 1, true);
  ok('marked as highlights', parts[0].kind, 'highlight');
  ok('drops the very short sentence', parts.every(p => p.body.length >= 30), true);
}

console.log('\nbreakdown — edge cases:');
{
  ok('empty input yields nothing', breakdown(''), []);
  ok('whitespace yields nothing', breakdown('   ' + NL + '  '), []);
  ok('respects the limit', breakdown(
    Array.from({ length: 60 }, (_, i) => '- item number ' + i).join(NL), { limit: 5 }).length, 5);
  const dupes = breakdown(['- same thing', '- same thing', '- other thing'].join(NL));
  ok('deduplicates identical points', dupes.length, 2);
  // frontmatter must not leak into the parts
  const fm = ['---', 'title: "Doc"', '---', '- real point'].join(NL);
  ok('frontmatter ignored', breakdown(fm).length, 1);
}

console.log('\nparseNote reads the burner field:');
{
  const doc = ['---', 'title: "Temp"', 'expires: 2030-01-01T00:00:00.000Z', '---', 'body'].join(NL);
  ok('expires parsed', parseNote(doc).expires, '2030-01-01T00:00:00.000Z');
  ok('absent expires is null', parseNote('---' + NL + 'title: "x"' + NL + '---' + NL + 'b').expires, null);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);

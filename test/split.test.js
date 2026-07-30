// Tests for the auto-split Markdown engine.
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, got, want) => {
  try { assert.deepStrictEqual(got, want); console.log('  ✓ ' + name); pass++; }
  catch { console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); fail++; }
};

const { splitMarkdown, parseNote } = require('../classifier');
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

console.log('\nparseNote reads the burner field:');
{
  const doc = ['---', 'title: "Temp"', 'expires: 2030-01-01T00:00:00.000Z', '---', 'body'].join(NL);
  ok('expires parsed', parseNote(doc).expires, '2030-01-01T00:00:00.000Z');
  ok('absent expires is null', parseNote('---' + NL + 'title: "x"' + NL + '---' + NL + 'b').expires, null);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);

// Tests for repo.js — resolving the update source in every packaging shape.
const assert = require('assert');
let pass = 0, fail = 0;
const ok = (name, got, want) => {
  try { assert.deepStrictEqual(got, want); console.log('  ✓ ' + name); pass++; }
  catch { console.log('  ✗ ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); fail++; }
};

const { resolveRepo, fromUrl, FALLBACK } = require('../repo');
const pick = (pkg) => { const r = resolveRepo(pkg); return r.owner + '/' + r.repo; };

console.log('repo.fromUrl:');
{
  ok('https url', fromUrl('https://github.com/drakontosc9/synapseMAIN.git'), { owner: 'drakontosc9', repo: 'synapseMAIN' });
  ok('https without .git', fromUrl('https://github.com/a/b'), { owner: 'a', repo: 'b' });
  ok('git+https prefix', fromUrl('git+https://github.com/a/b.git'), { owner: 'a', repo: 'b' });
  ok('ssh form', fromUrl('git@github.com:a/b.git'), { owner: 'a', repo: 'b' });
  ok('github shorthand', fromUrl('github:a/b'), { owner: 'a', repo: 'b' });
  ok('trailing path ignored', fromUrl('https://github.com/a/b/issues'), { owner: 'a', repo: 'b' });
  ok('non-github url', fromUrl('https://gitlab.com/a/b.git'), null);
  ok('empty', fromUrl(''), null);
  ok('null', fromUrl(null), null);
}

console.log('\nrepo.resolveRepo — source priority:');
{
  const withBuild = {
    build: { publish: [{ provider: 'github', owner: 'from', repo: 'build' }] },
    repository: { type: 'git', url: 'https://github.com/from/repository.git' }
  };
  ok('build.publish wins when present', pick(withBuild), 'from/build');
  ok('and says where it came from', resolveRepo(withBuild).source, 'build.publish');

  // this is the packaged case: electron-builder removes the build block
  const packaged = { repository: { type: 'git', url: 'https://github.com/from/repository.git' } };
  ok('falls back to the repository field', pick(packaged), 'from/repository');
  ok('reports the repository source', resolveRepo(packaged).source, 'repository');

  ok('accepts a string repository', pick({ repository: 'github:a/b' }), 'a/b');

  const bare = {};
  ok('falls back to the compiled-in constant', pick(bare), FALLBACK.owner + '/' + FALLBACK.repo);
  ok('reports the fallback source', resolveRepo(bare).source, 'fallback');
}

console.log('\nrepo.resolveRepo — malformed input never throws:');
{
  ok('null package', typeof resolveRepo(null).owner, 'string');
  ok('undefined package', typeof resolveRepo(undefined).owner, 'string');
  ok('publish not an array', pick({ build: { publish: { owner: 'x', repo: 'y' } } }), FALLBACK.owner + '/' + FALLBACK.repo);
  ok('publish empty array', pick({ build: { publish: [] } }), FALLBACK.owner + '/' + FALLBACK.repo);
  ok('non-github provider ignored', pick({ build: { publish: [{ provider: 's3', owner: 'x', repo: 'y' }] } }),
    FALLBACK.owner + '/' + FALLBACK.repo);
  ok('publish missing repo name', pick({ build: { publish: [{ provider: 'github', owner: 'x' }] } }),
    FALLBACK.owner + '/' + FALLBACK.repo);
  ok('garbage repository field', pick({ repository: 12345 }), FALLBACK.owner + '/' + FALLBACK.repo);
}

console.log('\nthe real package.json resolves:');
{
  const pkg = require('../package.json');
  const r = resolveRepo(pkg);
  ok('resolves to this project', r.owner + '/' + r.repo, 'drakontosc9/synapseMAIN');
  // and it must still resolve with the build block stripped, as when packaged
  const stripped = Object.assign({}, pkg);
  delete stripped.build;
  const s = resolveRepo(stripped);
  ok('still resolves once packaged', s.owner + '/' + s.repo, 'drakontosc9/synapseMAIN');
  ok('via the repository field, not the fallback', s.source, 'repository');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);

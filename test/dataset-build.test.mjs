import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const builder = fileURLToPath(new URL('../scripts/build-dataset.mjs', import.meta.url));
const updater = fileURLToPath(new URL('../scripts/update-data.mjs', import.meta.url));
const history = fileURLToPath(new URL('../scripts/build-history.mjs', import.meta.url));

async function fixture(t, { version = '12.1.5.70961', subject = '12.1.5 (70961)' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wow-dataset-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { stdio: 'pipe' });
  git('init', '--quiet');
  if (version) {
    await writeFile(path.join(directory, 'version.txt'), `${version}\n`);
    git('add', '--', 'version.txt');
  }
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', subject);
  const manifest = path.join(directory, 'manifest.json');
  const run = (...args) => spawnSync(process.execPath,
    [builder, '--source', directory, '--manifest', manifest, ...args], { encoding: 'utf8' });
  return { directory, manifest, run };
}

test('build refuses to label a source revision as a different client build', async (t) => {
  const current = await fixture(t);
  const historical = await fixture(t, { version: null, subject: '10.0.0 (46549)' });
  for (const [repo, claimed, documented] of [
    [current, '12.1.5.70962', '12.1.5.70961'],
    [historical, '10.0.0.46550', '10.0.0.46549'],
  ]) {
    const result = repo.run('--client-version', claimed);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match the source revision/);
    assert.ok(result.stderr.includes(documented));
    await assert.rejects(readFile(repo.manifest), { code: 'ENOENT' });
  }
});

test('build refuses dirty source and preflights incompatible manifests and output collisions', async (t) => {
  const dirty = await fixture(t);
  await writeFile(path.join(dirty.directory, 'version.txt'), '12.1.5.70962\n');
  const dirtyBuild = dirty.run();
  assert.equal(dirtyBuild.status, 1);
  assert.match(dirtyBuild.stderr, /uncommitted Interface or version.txt changes/);

  const clean = await fixture(t);
  const colliding = clean.run('--output', clean.manifest);
  assert.equal(colliding.status, 1);
  assert.match(colliding.stderr, /must use distinct paths/);
  await assert.rejects(readFile(clean.manifest), { code: 'ENOENT' });

  const unknownManifest = '{"schemaVersion":2,"channel":"retail","versions":[]}';
  await writeFile(clean.manifest, unknownManifest);
  const unsupported = clean.run();
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /Unsupported manifest schema: 2/);
  assert.equal(await readFile(clean.manifest, 'utf8'), unknownManifest);

  const retained = JSON.stringify({ schemaVersion: 1, channel: 'retail', versions: [
    { version: '12.1.0', file: 'old-api.json.gz', resourceFile: 'old-resources.json.gz' },
  ] });
  await writeFile(clean.manifest, retained);
  for (const output of ['old-api.json.gz', 'old-resources.json.gz']) {
    const conflict = clean.run('--output', path.join(clean.directory, output));
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /must use distinct paths/);
  }
  assert.equal(await readFile(clean.manifest, 'utf8'), retained);
});

test('build locks the manifest before source validation and releases the lock on failure', async (t) => {
  const repo = await fixture(t);
  const lock = `${repo.manifest}.lock`;
  const owner = '{"pid":12345}';
  await writeFile(lock, owner);

  const blocked = repo.run('--client-version', '12.1.5.70962');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Another dataset build holds the lock/);
  assert.ok(blocked.stderr.includes(lock));
  assert.equal(await readFile(lock, 'utf8'), owner);
  await assert.rejects(readFile(repo.manifest), { code: 'ENOENT' });

  await unlink(lock);
  const invalid = repo.run('--client-version', '12.1.5.70962');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /does not match the source revision/);
  await assert.rejects(readFile(lock), { code: 'ENOENT' });

  const collision = repo.run('--output', lock);
  assert.equal(collision.status, 1);
  assert.match(collision.stderr, /must use distinct paths/);
  await assert.rejects(readFile(lock), { code: 'ENOENT' });
});

test('build rejects unknown options before touching the catalog', async (t) => {
  const repo = await fixture(t);
  const result = repo.run('--api-ony');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option '--api-ony'/);
  await assert.rejects(readFile(repo.manifest), { code: 'ENOENT' });
  await assert.rejects(readFile(`${repo.manifest}.lock`), { code: 'ENOENT' });
});

test('refresh and history reject unknown options and missing values before Git or writes', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wow-dataset-arguments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Prevent any Git lookup from reaching the real repository or the network
  // if a guard regresses.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')), PATH: directory };
  for (const [script, args, message] of [
    [updater, ['--unknown'], /Unknown option '--unknown'/],
    [updater, ['--channel'], /argument missing/],
    [history, ['--unknown'], /Unknown option '--unknown'/],
    [history, ['--from'], /argument missing/],
    [history, ['--to'], /argument missing/],
    [history, ['--from=invalid'], /Invalid --from version/],
    [history, ['--from', '12.1.5', '--to', '12.0.0'], /--from must not be later than --to/],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: directory, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  }
  await assert.rejects(readFile(path.join(directory, '.cache')), { code: 'ENOENT' });
});

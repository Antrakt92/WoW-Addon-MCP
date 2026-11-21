import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { DatasetCatalog, loadCatalog, WowApiStore } from '../src/data-store.mjs';
import { compareVersions, updateManifest } from '../scripts/lib/dataset-manifest.mjs';
import { apiHistory, compareApi, diffVersions, entryFingerprint } from '../src/version-tools.mjs';

const fixture = JSON.parse(await readFile(new URL('fixtures/migration.json', import.meta.url), 'utf8'));
const archiveLocation = { commit: 'a'.repeat(40), file: 'snapshot.json.gz' };

test('refreshes build aliases and extends the catalog when a new patch arrives', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wow-manifest-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'manifest.json');
  await updateManifest(manifestPath, { ...archiveLocation, version: '12.1.0', clientVersion: '12.1.0.69283', build: '69283' });
  await updateManifest(manifestPath, { ...archiveLocation, version: '12.1.0', clientVersion: '12.1.0.69587', build: '69587' });
  let catalog = await loadCatalog(manifestPath);
  assert.equal(catalog.listVersions().length, 1);
  assert.equal(catalog.resolve('69587'), '12.1.0');
  assert.equal(catalog.resolve('12.1.0.69587'), '12.1.0');
  assert.throws(() => catalog.resolve('69283'), /Unsupported retail version/);
  assert.throws(() => catalog.resolve('12.1.0.69283'), /Unsupported retail version/);

  await updateManifest(manifestPath, { ...archiveLocation, version: '13.0.0', clientVersion: '13.0.0.90000', build: '90000' });
  catalog = await loadCatalog(manifestPath);
  assert.deepEqual(catalog.listVersions().map((entry) => entry.version), ['12.1.0', '13.0.0']);
  assert.equal(catalog.resolve('latest'), '13.0.0');
  assert.equal(catalog.resolve('13.0'), '13.0.0');
  assert.equal(catalog.resolve('90000'), '13.0.0');
  assert.equal(catalog.resolve('69587'), '12.1.0');
});

test('bundles a complete, internally consistent retail version catalog', async () => {
  const catalog = await loadCatalog();
  const versions = catalog.listVersions();
  for (const version of fixture.retainedPatches) {
    assert.ok(versions.some((entry) => entry.version === version), `Missing retained patch ${version}`);
  }
  assert.deepEqual(versions.map((entry) => entry.version), versions.map((entry) => entry.version).sort(compareVersions));
  assert.equal(versions[0].version, '10.0.0');
  assert.equal(versions.at(-1).version, catalog.manifest.default);
  assert.equal(versions.at(-1).default, true);

  await Promise.all(versions.map(async (entry) => {
    const archive = await readFile(catalog.datasetPath(entry));
    assert.equal(archive[9], 0x0a, `${entry.file} has a platform-specific gzip header`);
    const dataset = JSON.parse(gunzipSync(archive));
    assert.equal(dataset.source.patch, entry.version);
    assert.equal(dataset.source.version, entry.clientVersion);
    assert.equal(dataset.source.build, entry.build);
    assert.equal(dataset.source.commit, entry.commit);
    assert.deepEqual(dataset.stats, entry.stats);
    assert.equal(dataset.resources, undefined);
  }));
});

test('resolves patch and build aliases and lazily bounds loaded datasets', async () => {
  const catalog = await loadCatalog(undefined, { cacheSize: 2 });
  const current = catalog.entry();
  assert.equal(catalog.resolve('latest'), current.version);
  assert.equal(catalog.resolve('12.1'), '12.1.0');
  assert.equal(catalog.resolve(current.clientVersion), current.version);
  assert.equal(catalog.resolve(current.build), current.version);
  assert.throws(() => catalog.resolve('9.2.7'), /Unsupported retail version/);

  await catalog.store('10.0.0');
  await catalog.store('11.0.0');
  await catalog.store('latest');
  assert.deepEqual([...catalog.cache.keys()], ['11.0.0', current.version]);
});

test('rejects invalid or ambiguous version identities before resolving a catalog', async () => {
  const catalog = await loadCatalog();
  const { manifest } = catalog;
  const current = catalog.entry();
  assert.throws(() => new DatasetCatalog({ ...manifest, channel: undefined }), /must declare its channel/);
  for (const entry of [
    { ...current, version: '12.1.999' },
    { ...current, version: [current.version] },
    { ...current, version: '12.1', build: '5', clientVersion: '12.1.5' },
    { ...current, build: '1' },
    { ...current, clientVersion: '12unknown' },
  ]) {
    assert.throws(() => new DatasetCatalog({ ...manifest, default: entry.version, versions: [entry] }),
      /Dataset manifest (mixes client channels|contains inconsistent version identities)/);
  }
  const second = { ...current, version: '12.1.999', clientVersion: `12.1.999.${current.build}` };
  assert.throws(() => new DatasetCatalog({ ...manifest, versions: [current, second] }), /duplicate build aliases/);
});

test('sorts custom manifest history chronologically without changing its selected default', async () => {
  const { manifest, manifestPath } = await loadCatalog();
  const shuffled = [...manifest.versions].reverse();
  const catalog = new DatasetCatalog({ ...manifest, versions: shuffled }, manifestPath);
  assert.equal(catalog.entry().version, manifest.default);
  assert.deepEqual(catalog.versionsBetween('10.0.0', manifest.default).map(({ version }) => version),
    manifest.versions.map(({ version }) => version));
  assert.equal(shuffled[0].version, manifest.default);
  await assert.rejects(apiHistory(catalog, 'UnitStat', { fromVersion: manifest.default, toVersion: '10.0.0' }), /newer than/);
});

test('requires loaded catalog source references and archive paths before creating source claims', async (t) => {
  const { manifest } = await loadCatalog();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wow-manifest-source-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, 'manifest.json');
  const current = manifest.versions.at(-1);
  for (const changes of [{ commit: undefined }, { commit: 'live' }, { file: undefined }, { file: ' ' }]) {
    await writeFile(manifestPath, JSON.stringify({ ...manifest, versions: [{ ...current, ...changes }] }));
    await assert.rejects(loadCatalog(manifestPath), /missing a valid source commit or API archive path/);
  }
  await writeFile(manifestPath, JSON.stringify({ ...manifest, versions: [{ ...current, commitDate: undefined }] }));
  assert.equal((await loadCatalog(manifestPath)).entry().commit, current.commit);
});

test('refuses to serve archives with inconsistent build provenance or incomplete envelopes', async (t) => {
  const bundled = await loadCatalog();
  const current = bundled.entry();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wow-snapshot-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const api = JSON.parse(gunzipSync(await readFile(bundled.datasetPath(current))));
  const resource = JSON.parse(gunzipSync(await readFile(bundled.datasetPath({ file: current.resourceFile }))));
  const file = 'snapshot.json.gz';
  const resourceFile = 'resources.json.gz';
  const catalog = (overrides = {}) => new DatasetCatalog({
    schemaVersion: 1, channel: 'retail', default: current.version, versions: [{ ...current, file, resourceFile, ...overrides }],
  }, path.join(directory, 'manifest.json'));
  const writeArchive = (name, dataset) => writeFile(path.join(directory, name), gzipSync(JSON.stringify(dataset)));
  for (const invalid of [
    { ...api, schemaVersion: 2 },
    { ...api, source: { ...api.source, patch: '12.1.999' } },
    { ...api, source: { ...api.source, build: '1' } },
    { ...api, widgets: undefined },
  ]) {
    await writeArchive(file, invalid);
    await assert.rejects(catalog().store(), /Unsupported API snapshot schema|Invalid API snapshot|API snapshot does not match/);
  }
  for (const invalid of [
    { ...resource, source: { ...resource.source, patch: '12.1.999' } },
    { ...resource, resources: undefined },
  ]) {
    await writeArchive(resourceFile, invalid);
    await assert.rejects(catalog().lookupResources('CreateFrame'), /Resource snapshot does not match|Invalid resource snapshot/);
  }
  await writeArchive(file, api);
  await writeArchive(resourceFile, resource);
  await assert.rejects(catalog({ stats: { ...current.stats, methods: 1 } }).store(), /API snapshot statistics do not match/);
  await assert.rejects(catalog({ resourceCounts: { ...current.resourceCounts, symbol: 1 } }).lookupResources('CreateFrame'),
    /Resource snapshot counts do not match/);
  const wrongCoverage = current.resourceCoverage === 'complete' ? 'partial' : 'complete';
  await assert.rejects(catalog({ resourceCoverage: wrongCoverage }).lookupResources('CreateFrame'),
    /Resource snapshot coverage does not match/);
  const older = catalog({ stats: undefined, resourceCounts: undefined, resourceCoverage: undefined });
  assert.ok(await older.store());
  assert.equal((await older.lookupResources('CreateFrame')).available, true);
});

test('compares pinned API fixtures and histories without blending version snapshots', async () => {
  const versions = fixture.datasets.map(({ source }) => ({
    version: source.patch, clientVersion: source.version, build: source.build, commit: source.commit,
  }));
  const catalog = new DatasetCatalog({ schemaVersion: 1, channel: 'retail', default: '12.1.0', versions });
  for (const dataset of fixture.datasets) catalog.cache.set(dataset.source.patch, new WowApiStore(dataset));
  const comparison = await compareApi(catalog, 'AuraContainer', '12.0.7', '12.1.0', 'widget');
  assert.equal(comparison.comparisons.length, 1);
  assert.equal(comparison.comparisons[0].status, 'added');
  assert.equal(comparison.comparisons[0].before, undefined);
  assert.equal(comparison.comparisons[0].after.name, 'AuraContainer');

  const diff = await diffVersions(catalog, '12.0.7', '12.1.0', { namespace: 'C_UnitAuras', limit: 100 });
  assert.deepEqual(diff.counts, { added: 9, removed: 3, changed: 18 });
  assert.ok(diff.changes.some((entry) => entry.identity === 'C_UnitAuras.AddAuraSound' && entry.status === 'added'));
  assert.ok(diff.changes.some((entry) => entry.identity === 'C_UnitAuras.AddPrivateAuraAppliedSound' && entry.status === 'removed'));
  const alternateSpelling = await diffVersions(catalog, '12.0.7', '12.1.0', { namespace: ' c_unitauras ', limit: 100 });
  assert.deepEqual(alternateSpelling.changes, diff.changes);

  const history = await apiHistory(catalog, 'AuraContainer', { kind: 'widget' });
  assert.deepEqual(history.transitions.map((entry) => [entry.version.version, entry.status]), [
    ['12.0.7', 'absent'],
    ['12.1.0', 'introduced'],
  ]);
});

test('accepts qualified event identities in comparisons and history', async () => {
  const catalog = await loadCatalog();
  const name = 'C_CurrencyInfo.ACCOUNT_CHARACTER_CURRENCY_DATA_RECEIVED';
  const comparison = await compareApi(catalog, name, 'latest', 'latest', 'event');
  assert.equal(comparison.comparisons.length, 1);
  assert.equal(comparison.comparisons[0].identity, name);
  assert.equal(comparison.comparisons[0].status, 'unchanged');
  const history = await apiHistory(catalog, name, { kind: 'event', fromVersion: 'latest' });
  assert.equal(history.transitions[0].status, 'present');
});

test('paginates the filtered comparison without losing or duplicating changes', async () => {
  const retail = await loadCatalog();
  const forever = await loadCatalog(undefined, { channel: 'forever' });
  const options = { kind: 'function', change: 'added', toCatalog: forever };
  const full = await diffVersions(retail, 'latest', 'latest', { ...options, limit: 100_000 });
  assert.ok(full.matching > 15);

  const collected = [];
  let offset = 0;
  do {
    const page = await diffVersions(retail, 'latest', 'latest', { ...options, limit: 15, offset });
    assert.equal(page.offset, offset);
    assert.equal(page.matching, full.matching);
    assert.deepEqual(page.counts, full.counts);
    assert.equal(page.truncated, page.nextOffset !== null);
    collected.push(...page.changes);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(collected, full.changes);

  const empty = await diffVersions(retail, 'latest', 'latest', { ...options, offset: full.matching + 1 });
  assert.deepEqual(empty.changes, []);
  assert.equal(empty.nextOffset, null);
  assert.equal(empty.truncated, false);
});

test('fingerprints ignore object key order and source paths but preserve argument order', () => {
  const before = { metadata: { SecretArguments: 'AllowedWhenUntainted', NeverSecret: true }, arguments: [{ Name: 'a' }, { Name: 'b' }], sourceFile: 'a.lua' };
  const after = { arguments: before.arguments, metadata: { NeverSecret: true, SecretArguments: 'AllowedWhenUntainted' }, sourceFile: 'b.lua' };
  assert.equal(entryFingerprint(before), entryFingerprint(after));
  assert.notEqual(entryFingerprint(before), entryFingerprint({ ...after, arguments: [...after.arguments].reverse() }));
});

test('shares concurrent API loads and retries failed reads without caching the failure', async (t) => {
  const bundled = await loadCatalog();
  const entry = bundled.entry();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wow-catalog-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = 'snapshot.json.gz';
  const catalog = new DatasetCatalog({
    schemaVersion: 1, channel: 'retail', default: entry.version, versions: [{ ...entry, file }],
  }, path.join(directory, 'manifest.json'));
  const failed = await Promise.allSettled([catalog.store(), catalog.store(entry.clientVersion)]);
  assert.deepEqual(failed.map((result) => result.reason?.code), ['ENOENT', 'ENOENT']);
  await writeFile(path.join(directory, file), await readFile(bundled.datasetPath(entry)));
  const [patch, build, fullVersion] = await Promise.all([catalog.store(entry.version), catalog.store(entry.build), catalog.store(entry.clientVersion)]);
  assert.strictEqual(patch, build);
  assert.strictEqual(patch, fullVersion);
  assert.strictEqual(await catalog.store(), patch);
  await assert.rejects(loadCatalog(undefined, { cacheSize: -1 }), /cache size/i);
});

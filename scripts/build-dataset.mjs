import { spawnSync } from 'node:child_process';
import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { channelManifest, channelProfile, matchesChannel } from '../src/channels.mjs';

import { extractDataset } from './lib/extract-dataset.mjs';
import { patchVersion, readManifest, updateManifest } from './lib/dataset-manifest.mjs';
import { writeArchive } from './lib/dataset-archive.mjs';

function optionPath(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!value.trim()) throw new Error(`--${name} requires a path`);
  return path.resolve(value);
}

function git(sourceRoot, ...args) {
  const result = spawnSync('git', ['-c', `safe.directory=${sourceRoot.replaceAll('\\', '/')}`, '-C', sourceRoot, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.error?.message || result.stderr?.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function requireCleanSource(sourceRoot) {
  if (git(sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--', 'Interface', 'version.txt')) {
    throw new Error('Source checkout contains uncommitted Interface or version.txt changes');
  }
}

async function sourceVersion(sourceRoot, commit, suppliedVersion) {
  let version = await readFile(path.join(sourceRoot, 'version.txt'), 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (version === null) {
    // Older upstream revisions record the build in the Git subject.
    const subject = git(sourceRoot, 'show', '-s', '--format=%s', commit);
    const historical = /^(\d+\.\d+\.\d+) \((\d+)\)$/.exec(subject);
    if (!historical) throw new Error('Source revision has neither version.txt nor an exact version/build in its Git subject');
    version = `${historical[1]}.${historical[2]}`;
  }
  version = version.trim();
  if (suppliedVersion !== null && suppliedVersion.trim() !== version) {
    throw new Error(`Requested client version ${suppliedVersion} does not match the source revision (${version})`);
  }
  return version;
}

function requireDistinctOutputs(outputs, lockPath) {
  const paths = [lockPath, ...outputs.flatMap((output) => [output, `${output}.tmp`])];
  if (paths.some((output, index) => paths.slice(0, index).some((previous) => path.relative(output, previous) === ''))) {
    throw new Error('Manifest, archives, temporary files, and build lock must use distinct paths');
  }
}

export function validateDataset(dataset) {
  const channel = dataset.source.channel ?? 'retail';
  if (!matchesChannel(dataset.source.version, channel)) throw new Error(`Client version ${dataset.source.version} does not belong to ${channel}`);
  if (dataset.schemaVersion !== 1) throw new Error('Unexpected dataset schema version');
  if (dataset.stats.systems < 300) throw new Error(`Only ${dataset.stats.systems} API systems were extracted`);
  if (dataset.stats.functions < 1500) throw new Error(`Only ${dataset.stats.functions} API functions were extracted`);

  if (dataset.source.version.startsWith('12.1.')) {
    const functionNames = new Set(dataset.functions.map((entry) => entry.fullName));
    const widgetNames = new Set(dataset.widgets.map((entry) => entry.name));
    if (!functionNames.has('C_UnitAuras.GetHiddenGroupBuffs')) {
      throw new Error('Expected 12.1 API is missing: C_UnitAuras.GetHiddenGroupBuffs');
    }
    if (functionNames.has('C_UnitAuras.TriggerPrivateAuraShowDispelType')) {
      throw new Error('Removed 12.1 API is still present: C_UnitAuras.TriggerPrivateAuraShowDispelType');
    }
    for (const name of ['AuraButton', 'AuraContainer']) {
      if (!widgetNames.has(name)) throw new Error(`Expected 12.1 intrinsic widget is missing: ${name}`);
    }
  }

  if (channel === 'forever' || Number.parseInt(dataset.source.version, 10) >= 12) {
    const hasSecurityMetadata = dataset.functions.some((entry) => Object.keys(entry.metadata).some((key) => (
      key === 'SecretArguments' || key === 'HasRestrictions' || key === 'RequiresUnitAuraAccess'
    )));
    if (!hasSecurityMetadata) throw new Error('No function security metadata was extracted');
  }
}

async function buildDataset({ channel, sourceRoot, manifestPath, lockPath, options }) {
  const profile = channelProfile(channel);
  const commit = git(sourceRoot, 'rev-parse', 'HEAD');
  requireCleanSource(sourceRoot);
  const version = await sourceVersion(sourceRoot, commit, options['client-version'] ?? null);
  const parsedVersion = patchVersion(version);
  if (parsedVersion.build === null) throw new Error(`Source client version ${version} is missing its build number`);
  if (!matchesChannel(version, channel)) throw new Error(`Client version ${version} does not belong to ${channel}`);
  const previousManifest = await readManifest(manifestPath, channel);
  if (previousManifest.schemaVersion !== 1) throw new Error(`Unsupported manifest schema: ${previousManifest.schemaVersion}`);
  if (previousManifest.channel !== channel) throw new Error(`Cannot write ${channel} data into a ${previousManifest.channel} manifest`);
  if (!Array.isArray(previousManifest.versions)) throw new Error('Manifest versions must be an array');
  const manifestDirectory = path.dirname(manifestPath);
  const output = optionPath(options.output, 'output',
    path.join(manifestDirectory, channel === 'retail' ? 'retail' : 'snapshots', `${parsedVersion.version}.json.gz`));
  const includeResources = !options['api-only'];
  const resourceFile = `resources/${parsedVersion.version}.json.gz`;
  const previous = previousManifest.versions.find((entry) => entry.version === parsedVersion.version);
  const existingResources = !includeResources && previous?.commit === commit ? previous.resourceFile : undefined;
  const resourceOutput = includeResources ? resourceFile : existingResources;
  const retainedArchives = previousManifest.versions
    .filter((entry) => entry.version !== parsedVersion.version)
    .flatMap(({ file, resourceFile }) => [file, resourceFile])
    .filter(Boolean);
  requireDistinctOutputs([manifestPath, output, ...[resourceOutput, ...retainedArchives]
    .filter(Boolean).map((file) => path.resolve(manifestDirectory, file))], lockPath);
  const commitDate = git(sourceRoot, 'show', '-s', '--format=%cI', commit);
  const branch = git(sourceRoot, 'branch', '--show-current') || profile.branch;

  const dataset = await extractDataset(sourceRoot, {
    repository: 'https://github.com/Gethe/wow-ui-source',
    ...(channel === 'retail' ? {} : { channel }),
    branch,
    version,
    patch: parsedVersion.version,
    build: parsedVersion.build,
    commit,
    commitDate,
  }, { includeResources, allowPartialResources: options['allow-partial-resources'] });
  validateDataset(dataset);
  if (git(sourceRoot, 'rev-parse', 'HEAD') !== commit) throw new Error('Source revision changed during extraction');
  requireCleanSource(sourceRoot);

  let resourceMetadata = {};
  if (dataset.resources) {
    await writeArchive(path.join(manifestDirectory, resourceFile), { schemaVersion: 1, source: dataset.source, resources: dataset.resources });
    resourceMetadata = { resourceFile, resourceCounts: dataset.resources.counts, resourceCoverage: dataset.resources.coverage.status };
    delete dataset.resources;
  } else if (previous?.commit === commit && previous.resourceFile) {
    const { resourceFile, resourceCounts, resourceCoverage } = previous;
    resourceMetadata = { resourceFile, resourceCounts, resourceCoverage };
  }
  const bytes = await writeArchive(output, dataset);

  const relativeFile = path.relative(manifestDirectory, output).split(path.sep).join('/');
  const manifest = await updateManifest(manifestPath, {
    version: parsedVersion.version,
    clientVersion: version,
    build: parsedVersion.build,
    commit,
    commitDate,
    file: relativeFile,
    stats: dataset.stats,
    ...resourceMetadata,
  }, channel);

  console.log(JSON.stringify({ output, manifest: manifestPath, default: manifest.default, bytes, source: dataset.source, stats: dataset.stats, ...resourceMetadata }, null, 2));
}

async function main() {
  const { values: options } = parseArgs({
    options: {
      channel: { type: 'string', default: 'retail' },
      source: { type: 'string' },
      manifest: { type: 'string' },
      output: { type: 'string' },
      'client-version': { type: 'string' },
      'api-only': { type: 'boolean' },
      'allow-partial-resources': { type: 'boolean' },
    },
  });
  const channel = options.channel;
  const sourceRoot = optionPath(options.source, 'source',
    path.resolve('.cache', channel === 'retail' ? 'wow-ui-source' : 'wow-ui-forever'));
  const requestedManifest = optionPath(options.manifest, 'manifest', fileURLToPath(channelManifest(channel)));
  await mkdir(path.dirname(requestedManifest), { recursive: true });
  const manifestPath = path.join(await realpath(path.dirname(requestedManifest)), path.basename(requestedManifest));
  const lockPath = `${manifestPath}.lock`;
  const lock = await open(lockPath, 'wx').catch((error) => {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another dataset build holds the lock at ${lockPath}. After an interruption, verify no build is running before removing the lock manually and rebuilding the catalog.`);
  });
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    await buildDataset({ channel, sourceRoot, manifestPath, lockPath, options });
  } finally {
    try {
      await lock.close();
    } finally {
      await unlink(lockPath);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

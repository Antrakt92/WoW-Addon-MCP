import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { compareVersions } from './lib/dataset-manifest.mjs';
import { channelManifest, channelProfile, matchesChannel } from '../src/channels.mjs';

const repository = 'https://github.com/Gethe/wow-ui-source';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || `${command} ${args.join(' ')} failed`);
  return result.stdout?.trim() ?? '';
}

function git(root, ...args) {
  const safeRoot = root.replaceAll('\\', '/');
  return run('git', ['-c', `safe.directory=${safeRoot}`, '-C', root, ...args]);
}

function versionOption(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value)) throw new Error(`Invalid --${name} version: ${value}`);
  return value;
}

function canonicalSnapshots(sourceRoot, ref, channel) {
  const lines = git(sourceRoot, 'log', ref, '--format=%H%x09%cI%x09%s').split('\n');
  const snapshots = new Map();
  for (const line of lines) {
    const [commit, commitDate, subject] = line.split('\t');
    const match = /^(\d+\.\d+\.\d+) \((\d+)\)$/.exec(subject);
    if (!match || !matchesChannel(match[1], channel) || snapshots.has(match[1])) continue;
    snapshots.set(match[1], { version: match[1], build: match[2], commit, commitDate });
  }
  return [...snapshots.values()].sort((left, right) => compareVersions(left.version, right.version));
}

export async function withHistoryWorktree(sourceRoot, prefix, commit, build) {
  const directory = await mkdtemp(prefix + '-');
  let added = false;
  try {
    git(sourceRoot, 'worktree', 'add', '--detach', directory, commit);
    added = true;
    return await build(directory);
  } finally {
    // An ordinary removal protects any edits made while the rebuild ran.
    if (added) git(sourceRoot, 'worktree', 'remove', directory);
    else await rmdir(directory);
  }
}

async function main() {
  const { values: options } = parseArgs({
    options: {
      channel: { type: 'string', default: 'retail' },
      from: { type: 'string' },
      to: { type: 'string' },
      pinned: { type: 'boolean' },
      resources: { type: 'boolean' },
      'allow-partial-resources': { type: 'boolean' },
    },
  });
  const { channel } = options;
  const { branch } = channelProfile(channel);
  const sourceRoot = path.resolve('.cache', channel === 'retail' ? 'wow-ui-source' : 'wow-ui-forever');
  const worktreePrefix = path.resolve('.cache', channel === 'retail' ? 'wow-ui-history' : 'wow-ui-forever-history');
  const from = versionOption(options.from, 'from', channel === 'retail' ? '10.0.0' : '1.60.0');
  const to = versionOption(options.to, 'to', '999.999.999');
  if (compareVersions(from, to) > 0) throw new Error('--from must not be later than --to');
  if (!existsSync(path.join(sourceRoot, '.git'))) throw new Error('Run npm run data:update before building history');
  const origin = git(sourceRoot, 'remote', 'get-url', 'origin').replace(/\/?$/, '').replace(/\.git$/, '');
  if (origin !== repository) throw new Error(`Unexpected source origin: ${origin}`);

  if (git(sourceRoot, 'rev-parse', '--is-shallow-repository') === 'true') {
    run('git', ['-c', `safe.directory=${sourceRoot.replaceAll('\\', '/')}`, '-C', sourceRoot, 'fetch', '--unshallow', '--filter=blob:none', 'origin', branch], { stdio: 'inherit' });
  } else {
    run('git', ['-c', `safe.directory=${sourceRoot.replaceAll('\\', '/')}`, '-C', sourceRoot, 'fetch', '--filter=blob:none', 'origin', branch], { stdio: 'inherit' });
  }

  const candidates = options.pinned
    ? JSON.parse(await readFile(channelManifest(channel), 'utf8')).versions
    : canonicalSnapshots(sourceRoot, 'FETCH_HEAD', channel);
  const snapshots = candidates.filter((snapshot) => (
    compareVersions(snapshot.version, from) >= 0 && compareVersions(snapshot.version, to) <= 0
  ));
  if (snapshots.length === 0) throw new Error(`No versions found between ${from} and ${to}`);

  await withHistoryWorktree(sourceRoot, worktreePrefix, snapshots[0].commit, async (worktreeRoot) => {
    for (const [index, snapshot] of snapshots.entries()) {
      if (index > 0) git(worktreeRoot, 'checkout', '--detach', snapshot.commit);
      console.log(`\n[${index + 1}/${snapshots.length}] Building ${channel} ${snapshot.version} (${snapshot.build})`);
      run(process.execPath, [
        'scripts/build-dataset.mjs',
        '--channel', channel,
        '--source', worktreeRoot,
        '--client-version', `${snapshot.version}.${snapshot.build}`,
        ...(options.resources ? [] : ['--api-only']),
        ...(options['allow-partial-resources'] ? ['--allow-partial-resources'] : []),
      ], { stdio: 'inherit' });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

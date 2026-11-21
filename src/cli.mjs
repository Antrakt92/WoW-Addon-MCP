#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const { values: options } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean' },
    channel: { type: 'string' },
    'runtime-data': { type: 'string', multiple: true },
    'dataset-info': { type: 'boolean' },
    'list-versions': { type: 'boolean' },
  },
});
const actions = [options.help, options.version, options['dataset-info'], options['list-versions']];
if (actions.filter(Boolean).length > 1) throw new Error('Choose one of --help, --version, --dataset-info, or --list-versions');
if (options['runtime-data']?.some((file) => !file.trim())) throw new Error('--runtime-data requires a JSON snapshot path');

if (options.help) {
  console.log('Usage: wow-addon-api-mcp [--channel retail|forever] [--runtime-data PATH]...');
  console.log('Options: --dataset-info, --list-versions, --version, --help');
} else if (options.version) {
  console.log(packageJson.version);
} else {
  const inventoryMode = options['dataset-info'] || options['list-versions'];
  const { server, catalog, catalogs } = await createServer({
    packageVersion: packageJson.version,
    channel: options.channel,
    runtimeDataPath: inventoryMode ? [] : options['runtime-data'],
  });
  if (options['dataset-info']) {
    console.log(JSON.stringify(catalog ? catalog.info('latest') : { channels: [...catalogs.values()].map((entry) => entry.info('latest')) }, null, 2));
  } else if (options['list-versions']) {
    console.log([...catalogs.values()].flatMap((selected) => selected.listVersions().map((entry) =>
      `${catalog ? '' : entry.channel + '\t'}${entry.version}\t${entry.build}${entry.default ? '\tlatest' : ''}`)).join('\n'));
  } else {
    await server.connect(new StdioServerTransport());
  }
}

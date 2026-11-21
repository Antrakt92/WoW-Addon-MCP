import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const installations = {
  retail: { directory: '_retail_', product: 'wow' },
  forever: { directory: '_forever_', product: 'wowf' },
};

export async function localClientBuilds(root, catalogs) {
  const metadata = root
    ? await readFile(path.join(root, '.build.info'), 'utf8').catch(() => null)
    : null;
  const [header = '', ...rows] = (metadata ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const columns = header.split('|').map((column) => column.split('!')[0]);
  const productColumn = columns.indexOf('Product');
  const activeColumn = columns.indexOf('Active');
  const versionColumn = columns.indexOf('Version');

  return Promise.all([...catalogs].map(async ([channel, catalog]) => {
    const latest = catalog.entry();
    const result = {
      channel,
      latestCatalogVersion: latest.clientVersion,
      latestCatalogCommit: latest.commit,
    };
    if (!root) return { ...result, status: 'root_not_configured' };
    if ([productColumn, activeColumn, versionColumn].includes(-1)) {
      return { ...result, status: 'build_metadata_unavailable' };
    }

    const { directory, product } = installations[channel];
    // A launcher row alone can survive a removed client.
    const executable = await stat(path.join(root, directory, 'Wow.exe')).catch(() => null);
    if (!executable?.isFile()) return { ...result, status: 'client_not_found' };
    const candidates = new Set(rows.map((row) => row.split('|'))
      .filter((row) => row[productColumn] === product && row[activeColumn] === '1')
      .map((row) => row[versionColumn]));
    const [version] = candidates;
    if (candidates.size !== 1 || !/^\d+\.\d+\.\d+\.\d+$/.test(version ?? '')) {
      return { ...result, status: 'build_metadata_unavailable' };
    }

    const exact = catalog.listVersions().find((entry) => entry.clientVersion === version);
    return {
      ...result,
      installedVersion: version,
      installedVersionSource: '.build.info',
      versionEvidence: 'launcher_metadata',
      status: exact ? 'exact_match' : 'build_not_cataloged',
      exactCatalogCommit: exact?.commit ?? null,
    };
  }));
}

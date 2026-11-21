import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localClientBuilds } from '../src/local-client-builds.mjs';

test('launcher build detection requires an unambiguous complete metadata table', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wow-launcher-build-'));
  const retail = path.join(root, '_retail_');
  const executable = path.join(retail, 'Wow.exe');
  const metadata = path.join(root, '.build.info');
  const old = { clientVersion: '12.1.5.70961', commit: 'old' };
  const current = { clientVersion: '12.1.5.70962', commit: 'current' };
  const catalogs = new Map([['retail', { entry: () => current, listVersions: () => [old, current] }]]);
  try {
    await mkdir(retail);
    await writeFile(executable, '');
    const normal = 'Product!STRING:0|Active!DEC:1|Version!STRING:0|Branch!STRING:0';
    for (const document of [
      'Product!STRING:0|Active!DEC:1|Version!STRING:0|Version!STRING:0\nwow|1|12.1.5.70961|12.1.5.70962',
      normal + '\nwow|1|12.1.5.70961',
      normal + '\nwow|1|12.1.5.70961|eu\nwowf|1|1.60.1.70959',
      normal + '\nwow|1|1.60.1.70959|eu',
    ]) {
      await writeFile(metadata, document);
      const [row] = await localClientBuilds(root, catalogs);
      assert.equal(row.status, 'build_metadata_unavailable', document);
      assert.equal(row.installedVersion, undefined);
    }
    await writeFile(metadata, '\uFEFF' + normal + '\r\nwow|1|12.1.5.70961|eu\r\nwow|1|12.1.5.70961|us\r\n');
    const [match] = await localClientBuilds(root, catalogs);
    assert.equal(match.status, 'exact_match');
    assert.equal(match.exactCatalogCommit, 'old');
  } finally {
    await unlink(metadata).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(executable).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(retail).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(root);
  }
});

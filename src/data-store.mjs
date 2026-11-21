import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { channelManifest, channelProfile, matchesChannel } from './channels.mjs';

const SECURITY_KEY = /(secret|restriction|taint|unsecure|secure|combat|unittoken|unitaura|forbidden|protected)/i;
const API_STATS = ['systems', 'functions', 'methods', 'events', 'enumerations', 'structures', 'widgets'];
const RESOURCE_COUNTS = ['symbol', 'template', 'mixin', 'frame', 'cvar', 'atlas'];

function normalized(value) {
  return value.toLocaleLowerCase('en-US');
}

export function entryIdentity(entryKind, entry) {
  if (entryKind === 'function') return entry.fullName;
  if (entryKind === 'event') return entry.namespace ? `${entry.namespace}.${entry.literalName}` : entry.literalName;
  if (entryKind === 'system') return `${entry.kind}:${entry.namespace ?? ''}:${entry.name}`;
  return entry.name;
}

function exactNames(entryKind, entry) {
  const names = [entryIdentity(entryKind, entry)];
  if (entryKind === 'event') names.push(entry.literalName);
  if (entryKind === 'system') names.push(entry.name, entry.namespace);
  if (entryKind === 'enumeration') names.push(`Enum.${entry.name}`);
  return names.filter(Boolean);
}

function score(entry, query, entryKind) {
  const aliases = entryKind ? exactNames(entryKind, entry) : [];
  const names = [...aliases, entry.name, entry.namespace].filter(Boolean).map(normalized);
  if (names.includes(query)) return 0;
  if (names.some((name) => name.startsWith(query))) return 1;
  if (names.some((name) => name.includes(query))) return 2;
  const documentation = (entry.documentation ?? []).join(' ').toLocaleLowerCase('en-US');
  return documentation.includes(query) ? 3 : Number.POSITIVE_INFINITY;
}

function hasSecurityMetadata(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => (
    (SECURITY_KEY.test(key) && nested !== false && nested != null) || hasSecurityMetadata(nested)
  ));
}

function resourceMatches(resources, query, { kind, exact = false, limit = 20, offset = 0 } = {}) {
  if (!resources) return { available: false, total: 0, entries: [] };
  const needle = normalized(query.trim());
  const matches = resources.entries
    .filter((entry) => (!kind || entry.kind === kind) && (exact
      ? normalized(entry.name) === needle : normalized(entry.name).includes(needle)))
    .sort((a, b) => score(a, needle) - score(b, needle)
      || Number(a.sourceKind === 'framexml-reference') - Number(b.sourceKind === 'framexml-reference')
      || a.name.localeCompare(b.name) || a.sourceFile.localeCompare(b.sourceFile) || a.sourceLine - b.sourceLine);
  return { available: true, scope: resources.scope, coverage: resources.coverage,
    total: matches.length, offset, nextOffset: offset + limit < matches.length ? offset + limit : null,
    entries: matches.slice(offset, offset + limit) };
}

export class WowApiStore {
  constructor(dataset) {
    this.dataset = dataset;
    this.categories = {
      function: dataset.functions,
      event: dataset.events,
      enumeration: dataset.enumerations,
      structure: dataset.structures,
      widget: dataset.widgets,
      system: dataset.systems,
    };
  }

  info() {
    return { schemaVersion: this.dataset.schemaVersion, source: this.dataset.source, stats: this.dataset.stats };
  }

  search(query, { kind, limit = 20 } = {}) {
    const needle = normalized(query.trim());
    if (!needle) return [];
    const categories = kind ? [[kind, this.categories[kind] ?? []]] : Object.entries(this.categories);
    let matches = categories
      .flatMap(([entryKind, entries]) => entries.map((entry) => ({
        entryKind, entry, rank: score(entry, needle, entryKind),
      })))
      .filter((result) => Number.isFinite(result.rank));
    if ((!kind || kind === 'function') && !matches.some((match) => match.rank === 0)) {
      const method = this.#widgetMethod(needle);
      if (method) {
        matches = matches.filter(({ entryKind, entry }) => entryKind !== 'function' || entry.fullName !== method.fullName);
        matches.push({ entryKind: 'function', entry: method, rank: 0 });
      }
    }
    return matches
      .sort((a, b) => a.rank - b.rank || (a.entry.fullName ?? a.entry.literalName ?? a.entry.name).localeCompare(b.entry.fullName ?? b.entry.literalName ?? b.entry.name))
      .slice(0, Math.min(Math.max(limit, 1), 50));
  }

  #widgetMethod(name) {
    const separator = name.indexOf(':');
    if (separator === -1) return undefined;
    const widget = this.widget(name.slice(0, separator));
    const methodName = name.slice(separator + 1).trim();
    return widget?.methods.find((method) => normalized(method.name) === methodName);
  }

  lookup(name, kind, { allowShortNames = true } = {}) {
    const needle = normalized(name.trim());
    const categories = kind ? [[kind, this.categories[kind] ?? []]] : Object.entries(this.categories);
    const exact = [];
    const short = [];
    for (const [entryKind, entries] of categories) {
      for (const entry of entries) {
        if (exactNames(entryKind, entry).some((value) => normalized(value) === needle)) {
          exact.push({ entryKind, entry });
        } else if (allowShortNames && normalized(entry.name) === needle) {
          short.push({ entryKind, entry, matchType: 'short-name' });
        }
      }
    }
    if (exact.length) return exact;
    if (short.length === 0 && (!kind || kind === 'function')) {
      const method = this.#widgetMethod(needle);
      if (method) return [{ entryKind: 'function', entry: method }];
    }
    return short;
  }

  resources(query, { kind, exact = false, limit = 20, offset = 0 } = {}) {
    return resourceMatches(this.dataset.resources, query, { kind, exact, limit, offset });
  }

  namespace(namespace) {
    const needle = normalized(namespace.trim());
    return {
      systems: this.dataset.systems.filter((entry) => normalized(entry.namespace ?? entry.name) === needle),
      functions: this.dataset.functions.filter((entry) => normalized(entry.namespace ?? '') === needle),
      events: this.dataset.events.filter((entry) => normalized(entry.namespace ?? '') === needle),
      types: [...this.dataset.enumerations, ...this.dataset.structures].filter((entry) => normalized(entry.namespace ?? '') === needle),
    };
  }

  widget(name, includeInherited = true) {
    const direct = this.lookup(name, 'widget')[0]?.entry;
    if (!direct || !includeInherited) return direct;

    const methods = new Map(direct.methods.map((method) => [method.name, method]));
    const visited = new Set([direct.name]);
    const addParents = (widget) => {
      for (const parentName of widget.inherits ?? []) {
        if (visited.has(parentName)) continue;
        visited.add(parentName);
        const parent = this.lookup(parentName, 'widget')[0]?.entry;
        if (!parent) continue;
        for (const method of parent.methods) {
          if (!methods.has(method.name)) methods.set(method.name, method);
        }
        addParents(parent);
      }
    };
    addParents(direct);
    return { ...direct, methods: [...methods.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  restrictions(query = '', limit = 50) {
    const needle = normalized(query.trim());
    return this.dataset.functions
      .filter((entry) => hasSecurityMetadata(entry.metadata) || entry.arguments.some(hasSecurityMetadata) || entry.returns.some(hasSecurityMetadata))
      .filter((entry) => !needle || normalized(`${entry.fullName} ${(entry.documentation ?? []).join(' ')}`).includes(needle))
      .slice(0, Math.min(Math.max(limit, 1), 100));
  }
}

export async function loadStore(datasetPath) {
  if (datasetPath == null) return (await loadCatalog()).store('latest');
  const buffer = await readFile(datasetPath);
  const dataset = JSON.parse(gunzipSync(buffer));
  if (dataset?.schemaVersion !== 1) throw new Error('Unsupported API snapshot schema');
  const store = new WowApiStore(dataset);
  if (Object.values(store.categories).some((entries) => !Array.isArray(entries))) {
    throw new Error('Invalid API snapshot categories');
  }
  return store;
}

function matchesSnapshot(source, entry) {
  return source?.commit === entry.commit && source?.version === entry.clientVersion
    && source.patch === entry.version && source.build === entry.build
    && (source.channel ?? 'retail') === entry.channel;
}

function matchesCounts(expected, actual, fields) {
  if (expected === undefined) return true;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  return fields.every((field) => {
    if (!Object.hasOwn(expected, field)) return true;
    const count = expected[field];
    return Number.isSafeInteger(count) && count >= 0 && count === actual?.[field];
  });
}

function validateResourceIndex(resources, entry) {
  if (!Array.isArray(resources?.entries)) throw new Error('Invalid resource snapshot entries');
  const status = resources.coverage?.status;
  if ((status !== undefined && status !== 'complete' && status !== 'partial')
    || (entry.resourceCoverage !== undefined && entry.resourceCoverage !== status)) {
    throw new Error('Resource snapshot coverage does not match the dataset manifest');
  }
  if (!matchesCounts(entry.resourceCounts, resources.counts, RESOURCE_COUNTS)) {
    throw new Error('Resource snapshot counts do not match the dataset manifest');
  }
}

export class DatasetCatalog {
  #apiLoads = new Map();
  #resourceLoads = new Map();

  constructor(manifest, manifestPath, cacheSize = 2) {
    if (manifest?.schemaVersion !== 1) throw new Error(`Unsupported dataset manifest schema: ${manifest?.schemaVersion}`);
    if (manifest.channel === undefined) throw new Error('Dataset manifest must declare its channel');
    channelProfile(manifest.channel);
    if (!Array.isArray(manifest.versions) || manifest.versions.length === 0) throw new Error('Dataset manifest has no versions');
    if (manifest.versions.some((entry) => !matchesChannel(entry?.clientVersion, manifest.channel))) throw new Error('Dataset manifest mixes client channels or contains an invalid version');
    if (manifest.versions.some(({ version, build, clientVersion }) => (
      typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)
      || typeof build !== 'string' || !/^\d+$/.test(build) || clientVersion !== `${version}.${build}`
    ))) throw new Error('Dataset manifest contains inconsistent version identities');
    if (new Set(manifest.versions.map(({ build }) => build)).size !== manifest.versions.length) {
      throw new Error('Dataset manifest contains duplicate build aliases');
    }
    if (!Number.isSafeInteger(cacheSize) || cacheSize < 0) throw new RangeError('Dataset cache size must be a non-negative safe integer');
    // History follows numeric patch order even when a custom manifest is listed newest first.
    const versions = [...manifest.versions].sort((left, right) => left.version.localeCompare(right.version, 'en-US', { numeric: true }));
    this.manifest = { ...manifest, versions };
    this.manifestPath = manifestPath;
    this.cacheSize = cacheSize;
    this.cache = new Map();
    this.resourceCache = new Map();
    this.entries = new Map(versions.map((entry) => [entry.version, { ...entry, channel: manifest.channel }]));
    if (this.entries.size !== versions.length) throw new Error('Dataset manifest contains duplicate versions');
    if (!this.entries.has(manifest.default)) throw new Error(`Dataset manifest default is unavailable: ${manifest.default}`);
  }

  listVersions() {
    return this.manifest.versions.map((entry) => ({ ...entry, channel: this.manifest.channel, default: entry.version === this.manifest.default }));
  }

  resolve(version = 'latest') {
    const requested = String(version ?? 'latest').trim();
    if (!requested || requested.toLowerCase() === 'latest' || requested.toLowerCase() === 'current') {
      return this.manifest.default;
    }
    if (this.entries.has(requested)) return requested;

    const clientMatch = this.manifest.versions.find((entry) => entry.clientVersion === requested || entry.build === requested);
    if (clientMatch) return clientMatch.version;

    const normalizedPatch = /^(\d+\.\d+)$/.test(requested) ? `${requested}.0` : null;
    if (normalizedPatch && this.entries.has(normalizedPatch)) return normalizedPatch;
    throw new Error(`Unsupported ${this.manifest.channel} version "${requested}". Call list_versions for valid values.`);
  }

  entry(version = 'latest') {
    return this.entries.get(this.resolve(version));
  }

  info(version = 'latest') {
    const selected = this.entry(version);
    return {
      schemaVersion: this.manifest.schemaVersion,
      channel: this.manifest.channel,
      default: this.manifest.default,
      selected,
      availableVersions: this.manifest.versions.length,
    };
  }

  versionsBetween(fromVersion, toVersion) {
    const from = this.resolve(fromVersion ?? this.manifest.versions[0].version);
    const to = this.resolve(toVersion ?? this.manifest.default);
    const fromIndex = this.manifest.versions.findIndex((entry) => entry.version === from);
    const toIndex = this.manifest.versions.findIndex((entry) => entry.version === to);
    if (fromIndex > toIndex) throw new Error(`from_version ${from} is newer than to_version ${to}`);
    return this.manifest.versions.slice(fromIndex, toIndex + 1).map((entry) => this.entry(entry.version));
  }

  datasetPath(entry) {
    if (this.manifestPath instanceof URL) return new URL(entry.file, this.manifestPath);
    return path.resolve(path.dirname(this.manifestPath), entry.file);
  }

  async #readSnapshot(key, cache, pending, read) {
    if (cache.has(key)) {
      const snapshot = cache.get(key);
      cache.delete(key);
      cache.set(key, snapshot);
      return snapshot;
    }
    if (pending.has(key)) return pending.get(key);

    const load = read();
    pending.set(key, load);
    try {
      const snapshot = await load;
      if (this.cacheSize > 0) {
        cache.set(key, snapshot);
        if (cache.size > this.cacheSize) cache.delete(cache.keys().next().value);
      }
      return snapshot;
    } finally {
      pending.delete(key);
    }
  }

  async lookupResources(query, { version = 'latest', ...options } = {}) {
    const entry = this.entry(version);
    if (!entry.resourceFile) {
      const store = await this.store(version);
      const { resources } = store.dataset;
      if (resources !== undefined || entry.resourceCounts !== undefined || entry.resourceCoverage !== undefined) {
        validateResourceIndex(resources, entry);
      }
      return store.resources(query, options);
    }
    const resources = await this.#readSnapshot(entry.version, this.resourceCache, this.#resourceLoads, async () => {
      const file = this.datasetPath({ file: entry.resourceFile });
      const dataset = JSON.parse(gunzipSync(await readFile(file)));
      if (dataset?.schemaVersion !== 1 || !matchesSnapshot(dataset.source, entry)) {
        throw new Error('Resource snapshot does not match the selected API build');
      }
      validateResourceIndex(dataset.resources, entry);
      return dataset.resources;
    });
    return resourceMatches(resources, query, options);
  }

  async store(version = 'latest') {
    const entry = this.entry(version);
    return this.#readSnapshot(entry.version, this.cache, this.#apiLoads, async () => {
      const store = await loadStore(this.datasetPath(entry));
      if (!matchesSnapshot(store.dataset.source, entry)) throw new Error('API snapshot does not match the selected channel and build');
      if (!matchesCounts(entry.stats, store.dataset.stats, API_STATS)) {
        throw new Error('API snapshot statistics do not match the dataset manifest');
      }
      return store;
    });
  }
}

export async function loadCatalog(manifestPath, options = {}) {
  manifestPath ??= channelManifest(options.channel);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (options.channel && manifest?.channel !== options.channel) throw new Error('Manifest does not match the requested channel');
  const catalog = new DatasetCatalog(manifest, manifestPath, options.cacheSize ?? 2);
  for (const { version, commit, file } of catalog.manifest.versions) {
    if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/i.test(commit) || typeof file !== 'string' || !file.trim()) {
      throw new Error(`Dataset manifest entry ${version} is missing a valid source commit or API archive path`);
    }
  }
  return catalog;
}

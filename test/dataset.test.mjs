import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCatalog, loadStore } from '../src/data-store.mjs';

const store = await loadStore();

test('selects the pinned latest retail dataset by default', () => {
  assert.ok(Number.parseInt(store.info().source.version, 10) >= 12);
  assert.ok(store.info().source.commit);
  assert.ok(store.info().stats.functions > 4000);
});

test('contains 12.1 APIs and omits a removed API', () => {
  if (!store.info().source.version.startsWith('12.1.')) return;
  assert.equal(store.lookup('C_UnitAuras.GetHiddenGroupBuffs', 'function').length, 1);
  assert.equal(store.lookup('C_UnitAuras.TriggerPrivateAuraShowDispelType', 'function').length, 0);
  assert.equal(store.lookup('C_Discord', 'system')[0].entry.name, 'Discord');
});

test('normalizes Blizzard ScriptObject names and includes intrinsic widgets', () => {
  const frame = store.lookup('Frame', 'widget')[0].entry;
  assert.equal(frame.metadata.BlizzardSystemName, 'SimpleFrameAPI');
  assert.ok(store.widget('Frame').methods.some((method) => method.fullName === 'ScriptRegion:SetScript'));
  assert.equal(store.lookup('Frame:SetScript', 'function')[0].entry.fullName, 'ScriptRegion:SetScript');
  if (!store.info().source.version.startsWith('12.1.')) return;
  const auraContainer = store.lookup('AuraContainer', 'widget')[0].entry;
  assert.ok(auraContainer.methods.some((method) => method.fullName === 'AuraContainer:SetUnit'));
  assert.equal(auraContainer.methods.find((method) => method.name === 'SetUnit').sourceKind, 'framexml');
});

test('preserves 12.1 security metadata on functions and values', () => {
  if (!store.info().source.version.startsWith('12.1.')) return;
  const restricted = store.lookup('C_UnitAuras.GetAuraDataByIndex', 'function')[0].entry;
  assert.equal(restricted.metadata.RequiresUnitAuraAccess, true);
  assert.ok(store.restrictions('GetAuraDataByIndex').some((entry) => entry.fullName === restricted.fullName));

  const conditional = store.dataset.functions.find((entry) => (
    JSON.stringify([entry.arguments, entry.returns]).includes('ConditionalSecretContents')
  ));
  assert.ok(conditional, 'expected parameter or return-level ConditionalSecretContents metadata');
});

test('exposes enum values and event payloads', () => {
  const enumEntry = store.lookup('Enum.SpellBookSpellBank', 'enumeration')[0].entry;
  assert.ok(enumEntry.fields.some((field) => field.Name === 'Player'));
  const event = store.lookup('UNIT_AURA', 'event')[0].entry;
  assert.ok(event.payload.some((field) => field.Name === 'unitTarget'));
});

for (const channel of ['retail', 'forever']) {
  test(`${channel} lookups preserve enum, event and widget identities`, async () => {
    const catalog = await loadCatalog(undefined, { channel });
    const current = await catalog.store();
    assert.deepEqual(current.lookup('Enum.UnitStat'), []);
    assert.equal(current.lookup('UnitStat')[0].entry.fullName, 'UnitStat');
    assert.equal(current.lookup('enum.spellbookspellbank')[0].entryKind, 'enumeration');
    const event = current.lookup('ACCOUNT_CHARACTER_CURRENCY_DATA_RECEIVED', 'event')[0].entry;
    assert.strictEqual(current.lookup('C_CurrencyInfo.ACCOUNT_CHARACTER_CURRENCY_DATA_RECEIVED', 'event')[0]?.entry, event);
    const system = current.lookup('C_CurrencyInfo', 'system')[0].entry;
    assert.strictEqual(current.lookup(`${system.kind}:${system.namespace}:${system.name}`, 'system')[0]?.entry, system);
    assert.equal(current.lookup(' Frame : SetScript ', 'function')[0]?.entry.fullName, 'ScriptRegion:SetScript');
  });
}

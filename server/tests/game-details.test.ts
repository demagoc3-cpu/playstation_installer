import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gameDetails, type GameDetailsSource } from '../../shared/game-details.ts';
const source = (fields: Partial<GameDetailsSource> = {}) =>
  ({
    id: 'base',
    title: 'Game',
    titleId: 'PPSA00001',
    contentId: 'CONTENT',
    fileName: 'Base.ffpkg',
    type: 'Игра',
    size: 5_000_000_000,
    platform: 'ps5',
    format: 'ufs2',
    ...fields,
  }) as GameDetailsSource;
test('preview describes a deterministic base variant, not a larger patch', () => {
  const items = [
    source({
      id: 'patch',
      type: 'Патч',
      size: 9_000_000_000,
      appVersion: '09.00',
      installOrder: 1,
    }),
    source({ id: 'z', fileName: 'Z.ffpkg' }),
    source({
      id: 'a',
      fileName: 'A.ffpkg',
      appVersion: '01.02',
      masterVersion: '01.00',
      requiredFirmware: '09.00',
      sdkFirmware: '08.00',
      contentType: 'PS5GD',
    }),
  ];
  for (const list of [items, [...items].reverse()]) {
    const details = gameDetails(list)!;
    assert.equal(details.packageId, 'a');
    assert.equal(details.hasBase, true);
    assert.equal(details.size, 5_000_000_000);
    assert.equal(details.version, '01.02');
    assert.equal(details.firmware, '09.00');
    assert.equal(details.sdk, '08.00');
    assert.equal(details.masterVersion, '01.00');
    assert.equal(details.category, 'PS5GD');
  }
  assert.deepEqual(
    items.map((item) => item.id),
    ['patch', 'z', 'a'],
  );
});
test('patch-only and unknown metadata stay explicit without invented compatibility or installed status', () => {
  const details = gameDetails([
    source({ type: 'Патч', platform: 'unknown', format: 'unknown', contentId: '' }),
  ])!;
  assert.equal(details.hasBase, false);
  assert.equal(details.signature, 'unknown');
  assert.equal(details.version, '');
  assert.equal(details.sdk, '');
  assert.equal(details.contentId, '');
  assert.equal(details.platform, 'unknown');
  assert.equal(gameDetails([]), undefined);
  for (const key of ['installed', 'compatible', 'region', 'drm', 'conceptId'])
    assert.ok(!(key in details));
});
test('metadata allowlist excludes private paths, credentials and arbitrary source fields', () => {
  const privateSource = {
    ...source(),
    path: '/secret/file',
    libraryRoot: '/private/root',
    token: 'private-key',
    installedAt: 123,
    packageDigest: 'private-digest',
  };
  const details = gameDetails([privateSource])!;
  const json = JSON.stringify(details);
  for (const secret of ['secret', 'private', 'installedAt', 'packageDigest', 'libraryRoot'])
    assert.ok(!json.includes(secret));
  assert.equal(details.size, 5_000_000_000);
});

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier))
        return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { assessPackageFirmware } = await import('../utils/installation-firmware.ts');
const { assessContentFirmware } = await import('../../shared/installation-firmware.ts');

test('PS5 checks declared PARAM and SDK independently with numeric version comparisons', () => {
  const game = { contentType: 'PS5GD', requiredFirmware: '13.60', sdkFirmware: '12.00' };
  assert.equal(assessContentFirmware('13.60', game, 'ps5').state, 'compatible');
  assert.equal(assessContentFirmware('13.20', game, 'ps5').state, 'incompatible');
  assert.equal(
    assessContentFirmware('9.60', { ...game, requiredFirmware: '10.00' }, 'ps5').state,
    'incompatible',
  );
  assert.equal(
    assessContentFirmware(
      '9.60',
      { ...game, requiredFirmware: '5.10', sdkFirmware: '10.00' },
      'ps5',
    ).state,
    'incompatible',
  );
  assert.equal(assessContentFirmware('13.60', { contentType: 'PS5GD' }, 'ps5').state, 'unverified');
  assert.equal(assessContentFirmware(undefined, game, 'ps5').state, 'unavailable');
  assert.equal(
    assessContentFirmware('13.60', { contentType: 'PS5GD', requiredFirmware: '0.00' }, 'ps5').state,
    'compatible',
  );
  assert.equal(
    assessContentFirmware('13.60', { contentType: 'PS5GD', requiredFirmware: '4.xx' }, 'ps5').state,
    'unverified',
  );
});

test('compares both SDK and SYSTEM_VER; a lowered SDK alone does not certify a backport', () => {
  assert.equal(
    assessPackageFirmware('5.05', {
      contentType: 'PS4GP',
      requiredFirmware: '7.00',
      sdkFirmware: '5.05',
    }).state,
    'incompatible',
  );
  assert.equal(
    assessPackageFirmware('5.05', {
      contentType: 'PS4GP',
      requiredFirmware: '5.05',
      sdkFirmware: '7.00',
    }).state,
    'incompatible',
  );
  assert.equal(
    assessPackageFirmware('12.50', {
      contentType: 'PS4GP',
      requiredFirmware: '5.05',
      sdkFirmware: '5.05',
    }).state,
    'compatible',
  );
});

test('DLC without its own firmware requirement follows the base game; unverifiable games are skipped', () => {
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4AC' }).state, 'compatible');
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4AL' }).state, 'compatible');
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4GD' }).state, 'unverified');
  assert.equal(
    assessPackageFirmware('unknown', { contentType: 'PS4GD', requiredFirmware: '5.05' }).state,
    'unavailable',
  );
});

test('explicit zero SYSTEM_VER permits an app but does not bypass newer SDK or missing metadata', () => {
  assert.equal(
    assessPackageFirmware('12.50', { contentType: 'PS4GDE', requiredFirmware: '0.00' }).state,
    'compatible',
  );
  assert.equal(
    assessPackageFirmware('12.50', {
      contentType: 'PS4GDE',
      requiredFirmware: '0.00',
      sdkFirmware: '13.00',
    }).state,
    'incompatible',
  );
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4GDE' }).state, 'unverified');
});

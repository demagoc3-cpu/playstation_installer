import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) }
  catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context)
    throw error
  }
} })
const { assessPackageFirmware } = await import('../utils/installation-firmware.ts')

test('compares both SDK and SYSTEM_VER; a lowered SDK alone does not certify a backport', () => {
  assert.equal(assessPackageFirmware('5.05', { contentType: 'PS4GP', requiredFirmware: '7.00', sdkFirmware: '5.05' }).state, 'incompatible')
  assert.equal(assessPackageFirmware('5.05', { contentType: 'PS4GP', requiredFirmware: '5.05', sdkFirmware: '7.00' }).state, 'incompatible')
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4GP', requiredFirmware: '5.05', sdkFirmware: '5.05' }).state, 'compatible')
})

test('DLC without its own firmware requirement follows the base game; unverifiable games are skipped', () => {
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4AC' }).state, 'compatible')
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4AL' }).state, 'compatible')
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4GD' }).state, 'unverified')
  assert.equal(assessPackageFirmware('unknown', { contentType: 'PS4GD', requiredFirmware: '5.05' }).state, 'unavailable')
})

test('explicit zero SYSTEM_VER permits an app but does not bypass newer SDK or missing metadata', () => {
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4GDE', requiredFirmware: '0.00' }).state, 'compatible')
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4GDE', requiredFirmware: '0.00', sdkFirmware: '13.00' }).state, 'incompatible')
  assert.equal(assessPackageFirmware('12.50', { contentType: 'PS4GDE' }).state, 'unverified')
})

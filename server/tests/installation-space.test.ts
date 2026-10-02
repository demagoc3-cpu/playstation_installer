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
const { classifyInstallSpace, installSpaceMessage, requiredInstallSpace } = await import('../utils/installation-space.ts')

const GIB = 1024 ** 3

test('checks package bytes plus temporary installation reserve', () => {
  assert.equal(requiredInstallSpace(20 * GIB), 21 * GIB)
  assert.equal(classifyInstallSpace(21 * GIB, 20 * GIB).state, 'enough')
  const insufficient = classifyInstallSpace(20 * GIB, 20 * GIB)
  assert.equal(insufficient.state, 'insufficient')
  assert.match(installSpaceMessage(insufficient), /Недостаточно места/)
})

test('never treats missing or invalid console capacity as enough', () => {
  for (const bytes of [null, undefined, -1, Number.NaN, '1000000'])
    assert.equal(classifyInstallSpace(bytes, GIB).state, 'unavailable')
})

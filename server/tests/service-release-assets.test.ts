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

const { selectServiceReleaseAsset } = await import('../utils/service-updates.ts')
const asset = (name: string) => ({ name, size: 6619136, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: `https://github.com/demagoc3-cpu/playstation_installer/releases/download/PKG/${name}` })

test('release discovery picks the newest versioned PKG over legacy attachments', () => {
  assert.equal(selectServiceReleaseAsset([asset('PackageFlowService.pkg'), asset('PackageFlowService-1.48.pkg'), asset('PackageFlowService-1.49.pkg')])?.name, 'PackageFlowService-1.49.pkg')
  assert.equal(selectServiceReleaseAsset([asset('PackageFlowService.pkg')])?.name, 'PackageFlowService.pkg')
})

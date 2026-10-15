import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work = await mkdtemp(join(tmpdir(), 'pf-app-retry-'))
await build({ entryPoints:['server/utils/desktop-app-retry.ts'], outfile:join(work,'retry.mjs'), bundle:true, platform:'node', format:'esm' })
const { desktopAppRetryState } = await import(join(work,'retry.mjs'))

test('deletion after successful setup requires a fresh device read before a new request is allowed', async () => {
  let present = true, reads = 0
  const read = async () => { reads++; return {state:present?'installed':'absent', detail:''} }
  assert.equal(await desktopAppRetryState({state:'installed'},read),'installed')
  present = false
  assert.equal(await desktopAppRetryState({state:'installed'},read),'absent')
  assert.equal(reads,2)
})
test('active, lost and unconfirmed attempts never authorize a duplicate', async () => {
  for (const attempt of [undefined, {state:'unconfirmed'}, {state:'installing'}, {state:'pending'}, {state:'waiting'}]) {
    assert.equal(await desktopAppRetryState(attempt, async () => {assert.fail('must reconcile the old attempt first')}), !attempt || attempt.state==='unconfirmed' ? 'unconfirmed':'active')
  }
})
test('same version is current only after verified registration of the exact bundled bytes',async()=>{
 const revision={recordedSha256:'a'.repeat(64),targetSha256:'a'.repeat(64)},read=async()=>({state:'installed',detail:''})
 const installed={state:'installed',confirmation:'service-registration'}
 assert.equal(await desktopAppRetryState(installed,read,revision),'installed')
 for(const attempt of [{state:'failed'},{state:'installed'},{...installed,alreadyPresent:true}])assert.equal(await desktopAppRetryState(attempt,read,revision),'different-build')
 assert.equal(await desktopAppRetryState(installed,read,{...revision,targetSha256:'b'.repeat(64)}),'different-build')
 assert.equal(await desktopAppRetryState({state:'unconfirmed'},async()=>assert.fail(),revision),'unconfirmed')
})
test('terminal failure still needs live absence; unreachable and other versions cannot be reinstalled blindly', async () => {
  for (const state of ['failed','cancelled','skipped']) {
    for (const [live,expected] of [['absent','absent'],['installed','installed'],['unavailable','unavailable'],['base-present','different-version']]) {
      assert.equal(await desktopAppRetryState({state},async()=>({state:live,detail:''})),expected)
    }
  }
})
test.after(() => rm(work,{recursive:true,force:true}))

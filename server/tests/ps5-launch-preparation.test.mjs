import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

test('launch mounts the selected inactive source once; failures and lost acknowledgements never launch', async () => {
 const work=mkdtempSync(join(tmpdir(),'pf-launch-prepare-'))
 try{
  const file=join(work,'test.mjs');await build({entryPoints:[resolve('server/utils/ps5-launch-preparation.ts')],outfile:file,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
  const {preparePs5GameLaunch}=await import(pathToFileURL(file).href)
  const job={id:'a'.repeat(32),titleId:'PPSA95001',sourceIdentity:'b'.repeat(64),state:'unconfirmed'}
  const source={managed:true,sourceAvailable:true,canManageSource:true,sourceType:'image',installed:true,mounted:false,sourceIdentity:job.sourceIdentity}
  let mode='accepted',mounts=[],saved=[],active={complete:true,running:false},fresh={...source,mounted:true}
  const ports={save:v=>saved.push(structuredClone(v)),mount:async id=>{mounts.push(id);assert.equal(saved.at(-1).launchPreparation.state,'intent');if(mode==='lost')throw Error('timeout');return {requestId:id,titleId:job.titleId,action:'mount',state:mode,result:{status:mode==='accepted'?0:13}}},info:async()=>fresh,activity:async()=>active}
  const mounted=await preparePs5GameLaunch(job,source,ports);assert.equal(mounted.nativeLaunchDispatched,true);assert.equal(mounts.length,1)
  await preparePs5GameLaunch(job,{...source,mounted:true},ports);await preparePs5GameLaunch(job,{...source,sourceType:'pkg'},ports);assert.equal(mounts.length,1,'ordinary PKG and mounted sources retain their direct path')
  mode='failed';const rejected=await preparePs5GameLaunch(job,source,ports);assert.equal(rejected.state,'failed');assert.equal(rejected.nativeLaunchDispatched,undefined)
  mode='lost';const lost=await preparePs5GameLaunch(job,source,ports);assert.equal(lost.state,'unconfirmed');assert.equal(lost.nativeLaunchDispatched,undefined);assert.equal(mounts.length,3,'one POST for each independent intent, no timeout retry')
  mode='accepted';active={complete:true,running:true};const changed=await preparePs5GameLaunch(job,{...source,sourceType:'folder'},ports);assert.equal(changed.state,'failed');assert.equal(changed.result.error,'launch_source_changed')
  active={complete:true,running:false};fresh={...fresh,sourceIdentity:'c'.repeat(64)};assert.equal((await preparePs5GameLaunch(job,source,ports)).state,'failed')
 }finally{rmSync(work,{recursive:true,force:true})}
})

import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'

test('PyLoader exclusivity covers mixed/direct/restored queues; service queues remain independent',async()=>{
 const work=mkdtempSync(join(tmpdir(),'pf-ps4-admission-')),oldEnv=process.env.PACKAGEFLOW_DATA_DIR,oldFetch=globalThis.fetch
 process.env.PACKAGEFLOW_DATA_DIR=work
 try{
  const bundle=join(work,'api.mjs')
  await build({stdin:{contents:"export * from './server/utils/ps4-transport-admission';export * from './server/utils/installation-queue';export * from './server/utils/ps4-installer';export * from './server/utils/ps4-service-installer'",resolveDir:resolve('.')},bundle:true,platform:'node',format:'esm',outfile:bundle,logLevel:'silent'})
  const api=await import(pathToFileURL(bundle).href),one='192.168.1.4',two='192.168.1.6'
  let requests=0;globalThis.fetch=async()=>{requests++;throw Error('Unexpected hardware request')}
  const persist=(ip,transport,status='running')=>{
   const dir=join(work,'consoles',ip);mkdirSync(dir,{recursive:true})
   writeFileSync(join(dir,'installation-queue.json'),JSON.stringify({version:1,id:ip,psIp:ip,transport,status,items:[{packageId:'own-fixture',state:'pending',bytesSent:0,detail:'waiting'}]}))
  }
  for(const transport of ['payload','service'])for(const state of ['running','cancelling']){
   persist(one,transport,state)
   assert.throws(()=>api.startInstallationQueue({psIp:two,transport:'payload',packageIds:[],packageUrls:{}}),e=>e.statusCode===409&&/параллельной установки/.test(e.message))
   await assert.rejects(api.startInstaller(two),e=>e.statusCode===409&&/параллельной установки/.test(e.message))
   if(transport==='payload'){
    assert.throws(()=>api.startInstallationQueue({psIp:two,transport:'service',packageIds:[],packageUrls:{}}),e=>e.statusCode===409&&/параллельной установки/.test(e.message))
    for(const submit of [api.submitServicePackage,api.submitServiceLocalPackage,api.submitServiceUpdate])await assert.rejects(submit(two,{}),e=>e.statusCode===409&&/параллельной установки/.test(e.message))
   }
   else assert.doesNotThrow(()=>api.assertPs4TransportAdmission(two,'service'))
   assert.equal(requests,0,'rejected direct launch must not contact or replace the current installer')
  }
  persist(one,undefined)
  assert.throws(()=>api.assertPs4TransportAdmission(two,'service'),'missing transport in legacy queues is PyLoader')
  persist(two,'payload')
  const restored=api.getInstallationQueue(two)
  assert.equal(restored.status,'running');assert.match(restored.message,/параллельной установки/)
  assert.equal(restored.items[0].state,'pending');assert.equal(restored.items[0].bytesSent,0)
  assert.equal(requests,0,'restored conflicting queue must not dispatch an installer')
  for(const state of ['completed','cancelled','failed']){
   persist(one,'payload',state)
   assert.doesNotThrow(()=>api.assertPs4TransportAdmission(two,'payload'))
   assert.doesNotThrow(()=>api.assertPs4TransportAdmission(two,'service'))
  }
  const local={id:'a'.repeat(36),ip:one,path:'/data/own.pkg',pending:true}
  writeFileSync(join(work,'console-file-installations.json'),JSON.stringify({version:1,jobs:[local]}))
  assert.throws(()=>api.assertPs4TransportAdmission(two,'payload'),'local service installation blocks PyLoader on another PS4')
  assert.doesNotThrow(()=>api.assertPs4TransportAdmission(two,'service'))
  writeFileSync(join(work,'console-file-installations.json'),JSON.stringify({version:1,jobs:[{...local,pending:false,job:{state:'installed'}}]}))
  assert.doesNotThrow(()=>api.assertPs4TransportAdmission(two,'payload'))
  writeFileSync(join(work,'console-maintenance.json'),JSON.stringify({[one]:{kind:'selected-reinstall',state:'removing'}}))
  assert.throws(()=>api.assertPs4TransportAdmission(two,'payload'),'reinstallation reservation blocks PyLoader before its queue is created')
  assert.doesNotThrow(()=>api.assertPs4TransportAdmission(two,'service'))
 }finally{globalThis.fetch=oldFetch;if(oldEnv===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=oldEnv;rmSync(work,{recursive:true,force:true})}
})

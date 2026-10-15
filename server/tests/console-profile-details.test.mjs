import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'

test('PS4 profile exposes actual system/package versions, model, HEN and validated capacity without extra endpoints',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pf-profile-details-')),oldData=process.env.PACKAGEFLOW_DATA_DIR,oldFetch=globalThis.fetch
 process.env.PACKAGEFLOW_DATA_DIR=dir
 try {
  const out=join(dir,'api.mjs');await build({stdin:{contents:"export * from './server/utils/console-profiles'",resolveDir:resolve('.')},bundle:true,platform:'node',format:'esm',outfile:out,logLevel:'silent'})
  const api=await import(pathToFileURL(out).href),profile=api.saveConsoleProfile({name:'Own PS4',ip:'192.168.1.4',platform:'ps4'}).consoles[0]
  const identity={service:'PackegeFlowService',version:'0.3.0',environment:'ps4'}
  let offline=false;const calls=[]
  globalThis.fetch=async(url,init)=>{
   assert.equal(init?.method||'GET','GET');calls.push(new URL(url).pathname)
   if(offline)throw Error('fixture offline')
   const bodies={
    '/ping':{...identity,status:'ok'},
    '/system/info':{...identity,pkgVersion:'2.14',firmware:{version:'11.00'},model:{name:'PS4 Pro',family:'Pro'},hen:{name:'GoldHEN',version:'2.4b18',sdkVersion:'1.0'}},
    '/storage':{...identity,volumes:[{id:'internal',path:'/user',available:true,totalBytes:1000,freeBytes:450,availableBytes:400,usedBytes:550}]},
    '/status':{...identity,status:'ok',uptimeSeconds:10,requests:5,replies:4,processId:231,runtimeMode:'daemon'}
   }
   return new Response(JSON.stringify(bodies[new URL(url).pathname]||{}),{status:bodies[new URL(url).pathname]?200:404})
  }
  const p=(await api.probeConsoleProfile(profile.id)).consoles[0]
  assert.equal(p.model,'PS4 Pro');assert.equal(p.firmware,'11.00');assert.equal(p.version,'0.3.0');assert.equal(p.pkgVersion,'2.14')
  assert.equal(p.henName,'GoldHEN');assert.equal(p.henVersion,'2.4b18');assert.equal(p.henSdk,'1.0');assert.equal(p.servicePid,231);assert.equal(p.freeBytes,400);assert.equal(p.totalBytes,1000)
  assert.ok(calls.every(p=>['/ping','/install/capabilities','/system/info','/storage','/status'].includes(p)))
  const stored=JSON.parse(readFileSync(join(dir,'console-profiles.json'),'utf8')).consoles[0]
  assert.equal(stored.model,'PS4 Pro');assert.equal(stored.totalBytes,undefined);assert.equal(stored.servicePid,undefined)
  offline=true;const gone=(await api.probeConsoleProfile(profile.id)).consoles[0]
  assert.equal(gone.online,false);assert.equal(gone.totalBytes,undefined);assert.equal(gone.henVersion,undefined);assert.equal(gone.servicePid,undefined)
 }finally{globalThis.fetch=oldFetch;if(oldData===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=oldData;rmSync(dir,{recursive:true,force:true})}
})

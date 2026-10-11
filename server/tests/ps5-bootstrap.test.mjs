import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const work=await mkdtemp(join(tmpdir(),'pf-bootstrap-'))
await build({entryPoints:['server/utils/ps5-bootstrap-driver.ts'],outfile:join(work,'driver.mjs'),bundle:true,platform:'node',format:'esm'})
const {runPs5Bootstrap,bootstrapReceipt,bootstrapHealth}=await import(join(work,'driver.mjs'))
const flow=()=>({id:'a'.repeat(32),consoleId:'fixture',ip:'192.168.50.5',version:'0.1.0-dev',buildId:'fixture',sha256:'b'.repeat(64),firmware:'13.60',startedAt:1,state:'checking',message:''})
const receipt=(f)=>({status:200,body:{apiVersion:'v1',pid:11,firmwareRead:true,firmwareRaw:'0x13600001',serviceReport:{service:'PackageFlowService-PS5',platform:'ps5',consoleVerified:true,version:f.version,buildId:f.buildId}}})
test('first PS5 bootstrap persists sending before exactly one send and requires exact receipt',async()=>{
 const f=flow(),states=[];let sends=0,closed=0,reads=0
 await runPs5Bootstrap(f,new Uint8Array([1]),{idle:()=>true,health:async()=>++reads<=2?null:receipt(f),connect:async()=>({send:async()=>{assert.equal(states.at(-1),'sending');sends++},close:()=>closed++}),save:v=>states.push(v.state),pause:async()=>{}})
 assert.equal(f.state,'completed');assert.equal(sends,1);assert.equal(closed,1)
 assert.deepEqual(states,['sending','verifying','completed'])
})
test('existing service, busy queues and uncertain preflight must never send another ELF',async()=>{
 for(const scenario of ['existing','busy','timeout']) {
  const f=flow();let connects=0
  await runPs5Bootstrap(f,new Uint8Array(),{idle:()=>scenario!=='busy',health:async()=>{if(scenario==='timeout')throw Error('timeout');return {status:200,body:{unknown:true}}},connect:async()=>{connects++;throw Error('unexpected')},save:()=>{},pause:async()=>{}})
  assert.equal(f.state,'failed');assert.equal(connects,0)
 }
})
test('lost upload response and wrong build/firmware remain unconfirmed without replay',async()=>{
 for(const lost of [true,false]) {
  const f=flow();let sends=0,reads=0
  await runPs5Bootstrap(f,new Uint8Array(),{idle:()=>true,health:async()=>{if(++reads<=2)return null;const r=receipt(f);r.body.serviceReport.buildId='wrong';return r},connect:async()=>({send:async()=>{sends++;if(lost)throw Error('lost response')},close:()=>{}}),save:()=>{},pause:async()=>{}})
  assert.equal(f.state,'unconfirmed');assert.equal(sends,1)
 }
 const f=flow();assert.equal(bootstrapReceipt(f,receipt(f)),true)
 for(const mutate of [r=>r.body.firmwareRead=false,r=>r.body.firmwareRaw='0x12600000',r=>r.body.pid=0,r=>r.body.serviceReport.platform='ps4',r=>r.body.serviceReport.consoleVerified=false]) {const r=receipt(f);mutate(r);assert.equal(bootstrapReceipt(f,r),false)}
})
test('failure to persist sending intent prevents ELF delivery and closes the loader',async()=>{
 const f=flow();let sends=0,closed=0
 await assert.rejects(runPs5Bootstrap(f,new Uint8Array(),{idle:()=>true,health:async()=>null,connect:async()=>({send:async()=>{sends++},close:()=>closed++}),save:()=>{throw Error('disk full')},pause:async()=>{}}),/disk full/)
 assert.equal(sends,0);assert.equal(closed,1)
})
test('silent closed port requires explicit first-start confirmation; connected or malformed service never counts as absent',async()=>{
 const timeout=Object.assign(new Error('timeout'),{name:'TimeoutError'})
 const read=async()=>{throw timeout}
 await assert.rejects(bootstrapHealth(read,async()=>false,false),/timeout/)
 assert.equal(await bootstrapHealth(read,async()=>false,true),null)
 await assert.rejects(bootstrapHealth(read,async()=>true,true),/timeout/)
 await assert.rejects(bootstrapHealth(async()=>{throw new SyntaxError('bad JSON')},async()=>false,true),/bad JSON/)
 await assert.rejects(bootstrapHealth(read,async()=>{throw Error('network failed')},true),/network failed/)
 assert.equal(await bootstrapHealth(async()=>{throw Object.assign(new Error('refused'),{cause:{code:'ECONNREFUSED'}})},async()=>true,false),null)
 assert.deepEqual(await bootstrapHealth(async()=>({status:200,body:{service:'existing'}}),async()=>false,true),{status:200,body:{service:'existing'}})
})
test.after(()=>rm(work,{recursive:true,force:true}))

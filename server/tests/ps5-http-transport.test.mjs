import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const dir=mkdtempSync(join(tmpdir(),'pf-http-'))
await build({stdin:{contents:"export * from './server/utils/console-profiles';export * from './server/utils/event-log'",resolveDir:resolve('.')},bundle:true,platform:'node',format:'esm',outfile:join(dir,'api.mjs'),logLevel:'silent'})
const api=await import(pathToFileURL(join(dir,'api.mjs')).href)
test('batch opts out of retired socket reuse; only transfer gets a longer deadline; logs omit credentials and arbitrary error text',async()=>{
 const env=process.env.PACKAGEFLOW_DATA_DIR,fetch=globalThis.fetch,timeout=AbortSignal.timeout
 process.env.PACKAGEFLOW_DATA_DIR=dir
 try {
  const p=api.saveConsoleProfile({name:'own fixture',ip:'192.168.1.234',platform:'ps5'}).consoles.find(p=>p.ip==='192.168.1.234')
  const token='b'.repeat(64);writeFileSync(join(dir,'ps5-service-keys.json'),JSON.stringify({[p.ip]:token}))
  const deadlines=[];AbortSignal.timeout=ms=>{deadlines.push(ms);return timeout(ms)}
  let calls=0
  globalThis.fetch=async(url,opts)=>{calls++;assert.equal(opts.headers.Connection,'close');assert.equal(opts.headers.Authorization,'Bearer '+token);return new Response('{"ok":true}')}
  assert.equal((await api.ps5OperationRequest(p.id,'/api/v1/transfers/batch',{},Buffer.from('own fixture'))).body.ok,true)
  assert.deepEqual(deadlines,[90000])
  globalThis.fetch=async(url,opts)=>{calls++;assert.equal(opts.headers.Connection,undefined);return new Response('{}')}
  await api.ps5OperationRequest(p.id,'/api/v1/install/staged');assert.deepEqual(deadlines,[90000,15000])
  const fault=Object.assign(new Error('do not log credentials '+token),{cause:{code:'ECONNRESET'}})
  globalThis.fetch=async()=>{calls++;throw fault}
  const before=calls;await assert.rejects(api.ps5OperationRequest(p.id,'/api/v1/transfers/batch',{},Buffer.from('own fixture')),e=>e===fault)
  assert.equal(calls,before+1,'transport cannot blindly retry an uncertain mutation')
  const events=api.getEvents().entries;assert.match(events.at(-1).text,/ECONNRESET/);assert.ok(!JSON.stringify(events).includes(token));assert.ok(!JSON.stringify(events).includes(fault.message))
  const controller=new AbortController();controller.abort();const eventCount=events.length
  await assert.rejects(api.ps5OperationRequest(p.id,'/api/v1/transfers/batch',{},Buffer.alloc(0),controller.signal))
  assert.equal(api.getEvents().entries.length,eventCount,'intentional pause/cancel has no connection warning')
 }finally{globalThis.fetch=fetch;AbortSignal.timeout=timeout;if(env===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=env;rmSync(dir,{recursive:true,force:true})}
})

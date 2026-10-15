import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { transformSync } from 'esbuild'
const root = process.cwd(), directory = mkdtempSync(resolve(tmpdir(), 'pf-bootstrap-')), mode = process.argv[2]
process.chdir(directory); process.env.PACKAGEFLOW_DATA_DIR = resolve(directory, '.data'); mkdirSync('.data')
globalThis.createError = value => Object.assign(new Error(value.message), value)
globalThis.bootstrapCalls = { payload: 0, commands: 0 }
registerHooks({ resolve(s,c,next) { try { return next(s,c) } catch(e) { if(s.startsWith('.') && !/\.[a-z]+$/.test(s)) return next(`${s}.ts`,c); throw e } }, load(url,c,next) {
 if(url.endsWith('/server/utils/ps4-installer.ts')) return {format:'module',shortCircuit:true,source:`
 export async function getGoldHenStatus(){ return {ready: globalThis.bootstrapMode !== 'offline'} }
 export function savePsIp(ip){ globalThis.bootstrapIp = ip }
 export async function startInstaller(ip){ globalThis.bootstrapCalls.payload++; if(ip !== '192.168.88.147') throw new Error('Wrong console'); }
 export async function sendPackage(job){ globalThis.bootstrapCalls.commands++; globalThis.bootstrapJob = job; }
 `};
 if (url.endsWith('.ts')) return {format:'module',shortCircuit:true,source:transformSync(readFileSync(fileURLToPath(url),'utf8'),{loader:'ts',format:'esm'}).code}
 return next(url,c) } })
globalThis.bootstrapMode = mode
globalThis.fetch = async (url) => { assert.equal(new URL(url).pathname, '/ping'); return new Response(JSON.stringify(mode === 'running-service' ? {service:'PackegeFlowService'} : {}), {status: mode === 'running-service' ? 200 : 404}) }
function pkg(values) {
 const keys=Buffer.concat(Object.keys(values).map(k=>Buffer.from(`${k}\0`))), data=Buffer.concat(Object.values(values).map(v=>Buffer.from(`${v}\0`))), count=Object.keys(values).length
 const sfo=Buffer.alloc(20+16*count+keys.length+data.length); sfo.writeUInt32LE(0x46535000); sfo.writeUInt32LE(20+count*16,8); sfo.writeUInt32LE(20+count*16+keys.length,12); sfo.writeUInt32LE(count,16)
 let key=0,value=0; Object.entries(values).forEach(([k,v],i)=>{const at=20+i*16,n=Buffer.byteLength(v)+1;sfo.writeUInt16LE(key,at);sfo.writeUInt16LE(0x204,at+2);sfo.writeUInt32LE(n,at+4);sfo.writeUInt32LE(n,at+8);sfo.writeUInt32LE(value,at+12);key+=Buffer.byteLength(k)+1;value+=n})
 keys.copy(sfo,20+count*16);data.copy(sfo,20+count*16+keys.length)
 const p=Buffer.alloc(8192);Buffer.from('7f434e54','hex').copy(p);p.writeUInt32BE(1,0x10);p.writeUInt32BE(128,0x18);Buffer.from(values.CONTENT_ID).copy(p,0x40);p.writeUInt32BE(0x1000,128);p.writeUInt32BE(256,144);p.writeUInt32BE(sfo.length,148);sfo.copy(p,256);return p
}
const load = name => import(pathToFileURL(resolve(root, `server/utils/${name}.ts`)).href)
const until = async predicate => {for(let i=0;i<100;i++){if(predicate())return; await new Promise(done => setTimeout(done,50))}throw new Error('Timed out')}
try {
 const updates = await load('service-updates')
 const artifact = await updates.stageServicePackage(pkg({TITLE:'PackageFlowService',TITLE_ID:'PFLS00001',CONTENT_ID:'IV0000-PFLS00001_00-PACKAGEFLOWSRV00',CATEGORY:'gde',APP_VER:'01.92',SYSTEM_VER:'00000000'}))
 const path = updates.serviceArtifact(artifact.id).path
 const { bootstrapService } = await load('service-bootstrap')
 const calls = globalThis.bootstrapCalls, input = ['192.168.88.147', artifact.id, 'http://192.168.88.10:3000']
 if(mode === 'changed') { const data=readFileSync(path); data[4000] ^= 1;writeFileSync(path,data) }
 if(mode === 'stopping') (await load('desktop-lifecycle')).beginDesktopStop()
 if(mode === 'normal-no-service') {
  const {registerPackageFile}=await load('package-library')
  const game=await registerPackageFile(path)
  const {startInstallationQueue,getInstallationQueue,cancelInstallationQueue}=await load('installation-queue')
  startInstallationQueue({psIp:input[0],packageIds:[game.id],packageUrls:{[game.id]:`http://192.168.88.10:3000/json/${game.id}.json`},transport:'payload'})
  await new Promise(done=>setTimeout(done,1800))
  assert.equal(getInstallationQueue(input[0]).items[0].state,'waiting')
  assert.equal(calls.commands,1,'Ordinary PyLoader queues work without PackageFlowService')
  cancelInstallationQueue(input[0])
 } else if(mode === 'changed-after-acceptance') {
  const result=await bootstrapService(...input)
  const data=readFileSync(path);data[4000]^=1;writeFileSync(path,data)
  const {getInstallationQueue}=await load('installation-queue')
  await until(()=>getInstallationQueue(input[0]).status==='failed')
  assert.equal(calls.commands,0,'Changed accepted artifacts must never reach PyLoader')
  assert.equal(getInstallationQueue(input[0]).id,result.queue.id)
 } else if(!['success','late-download'].includes(mode)) {
  await assert.rejects(bootstrapService(...input), {statusCode: mode === 'offline' ? 502 : mode === 'stopping' ? 503 : 409})
  assert.equal(calls.payload,0);assert.equal(calls.commands,0)
 } else {
  const result = await bootstrapService(...input)
  assert.equal(result.version,'1.92'); assert.equal(result.queue.transport,'payload')
  const id=result.queue.items[0].packageId
  assert.equal(result.queue.items[0].url, `http://192.168.88.10:3000/ps4/manifest/${input[0]}/${id}.json`)
  assert.equal(result.queue.bootstrapArtifactId,artifact.id)
  await until(() => calls.commands === 1)
  assert.equal(globalThis.bootstrapJob.contentId,'IV0000-PFLS00001_00-PACKAGEFLOWSRV00')
  assert.equal(globalThis.bootstrapJob.contentType,'PS4GDE'); assert.equal(globalThis.bootstrapJob.size,artifact.size)
  const {getInstallationQueue}=await load('installation-queue')
  await assert.rejects(bootstrapService(...input),{statusCode:409})
  assert.equal(getInstallationQueue(input[0]).id,result.queue.id,'Duplicate clicks must preserve the accepted queue')
  assert.equal(calls.commands,1)
  const library=await load('package-library')
  const { inConsoleScope } = await load('console-scope')
  if(mode==='late-download') {
   const clock=Date.now
   try {
    let now=clock();Date.now=()=>now
    inConsoleScope(input[0],()=>library.recordPackageDelivery(id,0,1023,false))
    now+=31000
    await until(()=>getInstallationQueue(input[0]).status==='completed')
    assert.equal(getInstallationQueue(input[0]).items[0].state,'unconfirmed','Header-only delivery cannot claim full transfer')
    inConsoleScope(input[0],()=>library.recordPackageDelivery(id,1024,artifact.size-1,true))
    assert.equal(getInstallationQueue(input[0]).items[0].bytesSent,artifact.size,'Late body must refresh terminal queue progress')
   } finally { Date.now=clock }
  } else inConsoleScope(input[0], () => library.recordPackageDelivery(id,0,artifact.size-1,true))
  await until(() => getInstallationQueue(input[0]).status === 'completed')
  assert.equal(getInstallationQueue(input[0]).items[0].state,'delivered','PyLoader transfer is not an installation confirmation')
  assert.equal(library.getLibraryPackages(input[0]).find(item=>item.id===id).installedAt,undefined)
  assert.equal(globalThis.bootstrapIp,input[0]); assert.equal(calls.payload,1)
 }
 console.log(`PASS: service bootstrap ${mode}`)
} finally { await new Promise(done=>setTimeout(done,1200));process.chdir(root);rmSync(directory,{recursive:true,force:true}) }

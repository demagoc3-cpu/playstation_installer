import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createError } from 'h3'
import { putPs5ParamPkg } from './fixtures/ps5-param-pkg.mjs'

const work=mkdtempSync(join(tmpdir(),'pf-ps5-queue-')), bundle=join(work,'queue.mjs')
await build({stdin:{contents:"export * from './server/utils/ps5-queue-core'; export * from './server/utils/ps5-queue-driver'; export * from './server/utils/ps5-installation-queue'; export * from './server/utils/ps5-app-commands'; export * from './server/utils/console-profiles';",resolveDir:resolve('.')},outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
const initialData=process.env.PACKAGEFLOW_DATA_DIR
process.env.PACKAGEFLOW_DATA_DIR=join(work,'driver-data');mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
const api=await import(pathToFileURL(bundle).href)
const input=(id,branch='ps5:PPSA95001',order=0)=>({packageId:id,title:id,fileName:`${id}.pkg`,titleId:branch.split(':')[1],size:100,type:order===0?'Игра':order===1?'Патч':'DLC',platform:branch.split(':')[0],format:'pkg',branch,order})
const wait=async check=>{const end=Date.now()+4000;while(!check()){assert.ok(Date.now()<end,'queue timed out');await new Promise(r=>setTimeout(r,5))}}
const make=(driver,id='one')=>{let durable;const q=api.ps5BlankQueue(id,`192.168.1.${id==='one'?5:6}`);const runner=new api.Ps5QueueRunner(q,value=>{durable=structuredClone(value)},driver,5);return {runner,q,read:()=>structuredClone(durable)}}
test('installer creates its durable queue ID without appending to a nonexistent queue or replaying it',async()=>{
  let release, calls=0
  const {runner,q,read}=make({async run(){calls++;await new Promise(r=>{release=r});return{state:'installed'}},async cancel(){}})
  const id='b'.repeat(32)
  assert.throws(()=>runner.enqueue([input('app')],id),/Очередь изменилась/)
  assert.equal(q.status,'idle');assert.equal(calls,0)
  runner.enqueue([input('app')],undefined,id)
  await wait(()=>release)
  assert.equal(read().id,id);assert.equal(read().items[0].queueId,id)
  assert.throws(()=>runner.enqueue([input('app')],undefined,id),/Неверный номер/)
  assert.throws(()=>runner.enqueue([input('other')],undefined,'c'.repeat(32)),/Уже работает очередь/)
  runner.enqueue([input('app')],id)
  assert.equal(q.items.length,1)
  release();await runner.settled();assert.equal(calls,1)
  assert.throws(()=>runner.enqueue([input('app')],undefined,id),/Неверный номер/)
  assert.throws(()=>runner.enqueue([input('app')],undefined,'bad'),/Неверный номер/)
})
test('PS5 branch ordering, failed base dependencies, deduplicated append and clear',async()=>{
  const seen=[];let release
  const driver={async run(item,signal,save){seen.push(item.packageId);save({state:'sending'});if(item.packageId==='base')await new Promise(r=>{release=r});if(item.packageId==='bad')throw new api.Ps5QueueFailure('bad base');return{state:'installed'}},async cancel(){}}
  const {runner,q}=make(driver)
  runner.enqueue([input('dlc','ps5:PPSA95001',2),input('base'),input('bad','ps5:PPSA95002'),input('bad-patch','ps5:PPSA95002',1)])
  await wait(()=>release)
  runner.enqueue([input('patch','ps5:PPSA95001',1),input('dlc','ps5:PPSA95001',2)],q.id)
  release();await wait(()=>q.status!=='running')
  assert.deepEqual(seen,['base','patch','dlc','bad'])
  assert.equal(q.items.find(i=>i.packageId==='bad-patch').state,'skipped')
  assert.equal(q.items.filter(i=>i.packageId==='dlc').length,1)
  assert.equal(q.status,'failed');runner.clear();assert.ok(q.items.every(i=>i.hidden))
})
test('cancel active branch confirms transfer cancellation before advancing other games',async()=>{
  const seen=[];let cancellation=false
  const {runner,q}=make({async run(item,signal,save){seen.push(item.packageId);save({state:'sending'});if(item.packageId==='base')await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));else assert.equal(cancellation,true);return{state:'installed'}},async cancel(){cancellation=true}})
  runner.enqueue([input('base'),input('patch','ps5:PPSA95001',1),input('next','ps5:PPSA95002')]);await wait(()=>q.items[0].state==='sending')
  assert.throws(()=>runner.cancel('stale'),/Очередь изменилась/)
  runner.cancel(q.id,undefined,['ps5:PPSA95001']);await wait(()=>q.status==='completed')
  assert.deepEqual(seen,['base','next']);assert.equal(q.items[0].state,'cancelled');assert.equal(q.items[1].state,'cancelled')
})
test('cancel single active base skips dependencies but continues unrelated game',async()=>{
  const {runner,q}=make({async run(item,signal,save){save({state:'sending'});if(item.packageId==='base')await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return{state:'installed'}},async cancel(){}})
  runner.enqueue([input('base'),input('dlc','ps5:PPSA95001',2),input('next','ps5:PPSA95002')]);runner.cancel(q.id,['base']);await wait(()=>q.status==='failed')
  assert.equal(q.items.find(i=>i.packageId==='dlc').state,'skipped');assert.equal(q.items.find(i=>i.packageId==='next').state,'installed')
})
test('separate destinations and clear preserve active and queued tasks',async()=>{
  const releases=[]
  const driver={async run(item,signal,save){save({state:'sending'});await new Promise(r=>releases.push(r));return{state:'installed'}},async cancel(){}}
  const a=make(driver),b=make(driver,'two');a.runner.enqueue([input('same')]);b.runner.enqueue([input('same')])
  assert.notEqual(a.q.id,b.q.id);assert.notEqual(a.q.items[0].transferId,b.q.items[0].transferId)
  a.runner.clear();assert.equal(a.q.items[0].hidden,undefined)
  releases.forEach(r=>r());await wait(()=>a.q.status==='completed'&&b.q.status==='completed')
})
test('restart recovers durable dispatch intent and never resubmits an uncertain install',async()=>{
  let released,submitted=0
  const a=make({async run(item,signal,save){save({state:'installing',installDispatched:true});submitted++;await new Promise(r=>released=r);throw new api.Ps5QueueUncertain('unknown')},async cancel(){assert.fail('accepted install cannot use transfer cancel')}})
  a.runner.enqueue([input('base'),input('next','ps5:PPSA95002')]);const saved=a.read()
  assert.equal(saved.items[0].installDispatched,true)
  a.runner.cancel(a.q.id);assert.equal(a.q.items[0].cancelRequested,undefined);assert.equal(a.q.items[1].state,'cancelled')
  // Restart contract: restore the persisted object and inspect; do not call dispatch again.
  let recovery=0,finish=false
  const restored=new api.Ps5QueueRunner(saved,()=>{}, {async run(item){assert.equal(item.installDispatched,true);recovery++;if(!finish)throw new api.Ps5QueueUncertain('unknown');return{state:'installed'}},async cancel(){}},5)
  restored.wake();await wait(()=>saved.items[0].state==='unconfirmed')
  assert.equal(saved.items[1].state,'pending','uncertain install blocks advancement')
  // Cancel remaining queue, then reconcile a strong simulated backend receipt.
  restored.cancel(saved.id,['next']);finish=true;await wait(()=>saved.status==='completed')
  assert.ok(recovery>=2);assert.equal(submitted,1)
  released();await wait(()=>a.q.items[0].state==='unconfirmed')
  // Stop test-only unknown runner without changing production semantics.
  a.q.status='failed'
})

test('durable write failure prevents dispatch and does not crash the WEB worker',async()=>{
  let dispatched=0,durable
  const q=api.ps5BlankQueue('storage-test','192.168.1.5')
  const runner=new api.Ps5QueueRunner(q,value=>{if(value.items.some(i=>i.installDispatched))throw new Error('disk unavailable');durable=structuredClone(value)},
    {async run(item,signal,save){save({state:'installing',installDispatched:true});dispatched++;return{state:'installed'}},async cancel(){}},5)
  runner.enqueue([input('base')]);await runner.settled()
  assert.equal(dispatched,0);assert.equal(durable.items[0].installDispatched,undefined)
  assert.match(q.message,/приостановлена/);assert.equal(q.status,'running','unknown work cannot be replaced by a new queue')
})

test('driver reconciles lost chunk response, preserves hash and offset, and refuses a changed source',async()=>{
  const oldEnv=process.env.PACKAGEFLOW_DATA_DIR,oldFetch=globalThis.fetch,oldError=globalThis.createError
  globalThis.createError=createError
  try{
    let profile=api.saveConsoleProfile({name:'own test',platform:'ps5',ip:'192.168.1.5'}).consoles.find(c=>c.platform==='ps5')
    profile=api.saveConsoleProfile({...profile,firmware:'13.60'}).consoles.find(c=>c.platform==='ps5')
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR,'ps5-service-keys.json'),JSON.stringify({[profile.ip]:'a'.repeat(64)}))
    const contents=putPs5ParamPkg(Buffer.alloc(9*1024*1024+19,39)),source=join(work,'test.pkg');writeFileSync(source,contents)
    const pkg={...input('own'),id:'own',path:source,libraryRoot:work,size:contents.length,contentType:'PS5GD',contentId:'IV0000-PPSA95001_00-PACKAGEFLOWUI001',appVersion:'01.000.001',sourceModifiedAt:1,installOrder:0,icon:{offset:0,size:0},iconSize:0,packageDigest:''}
    writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR,'package-library.json'),JSON.stringify({version:2,packages:[pkg],deliveries:{}}))
    const item={...input('own'),size:contents.length,contentId:pkg.contentId,appVersion:pkg.appVersion,transferId:'1'.repeat(32),state:'pending',detail:'',bytesSent:0}
    let offset=0,hash='',lost=false,verified=false,installs=0,chunkMax; const chunkOffsets=[]
    const describe=()=>({id:item.transferId,bytesDurable:offset,size:item.size,blake3:hash,verified,cancelled:false,chunkMax})
    const response=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}})
    globalThis.fetch=async(url,opts)=>{
      assert.equal(new URL(url).hostname,profile.ip);if(new URL(url).pathname!=='/health')assert.equal(opts.headers.Authorization,`Bearer ${'a'.repeat(64)}`)
      const path=new URL(url).pathname
      if(path==='/health')return response({apiVersion:'v1',firmwareRead:true,firmwareRaw:'0x13600007',serviceReport:{service:'PackageFlowService-PS5',platform:'ps5',consoleVerified:true}})
      if(path==='/api/v1/capabilities')return response({service:'PackageFlowService-PS5',capabilities:{installPs4Pkg:true,installPs5Content:true}})
      if(path==='/api/v1/system')return response({service:'PackageFlowService-PS5',storageRead:false})
      if(path==='/api/v1/install/readiness')return response({service:'PackageFlowService-PS5',schemaVersion:1,route:'staged-pkg',ready:true,reason:'ready',formats:['pkg'],platforms:['ps4','ps5'],exactVersionReceipt:false})
      if(path==='/api/v1/management/status')return response({protocol:'ps5-management-v1',ready:true,catalog:true})
      if(path==='/api/v1/console/catalog')return response({revision:'a'.repeat(64),entries:[],next:0,done:true})
      if(path==='/api/v1/transfers/begin'){hash=opts.headers['X-PackageFlow-Blake3'];assert.match(hash,/^[0-9a-f]{64}$/);return response(describe())}
      if(path==='/api/v1/transfers/status')return response(describe())
      if(path==='/api/v1/transfers/chunk'){
        const start=Number(opts.headers['X-PackageFlow-Offset']);chunkOffsets.push(start);assert.equal(start,offset)
        assert.deepEqual(Buffer.from(opts.body),contents.subarray(start,start+opts.body.length));offset+=opts.body.length
        if(!lost){lost=true;throw new Error('reply lost after durable write')}
        return response(describe())
      }
      if(path==='/api/v1/transfers/commit'){verified=true;return response(describe())}
      if(path==='/api/v1/install/staged'){assert.ok(item.installDispatched,'intent saved before network dispatch');installs++;return response({state:'submitting'})}
      if(path==='/api/v1/install/status')return response({ok:true,job:'1-2'})
      if(path==='/api/v1/installer/job')return response({ok:true,phase:'done',bytes_served:item.size,total:item.size,code:0})
      assert.fail(path)
    }
    await api.probeConsoleProfile(profile.id)
    const driver=api.ps5QueueDriver(profile.id),save=patch=>Object.assign(item,patch)
    await assert.rejects(driver.run(item,new AbortController().signal,save),/reply lost/)
    assert.equal(item.bytesSent,0);assert.equal(offset,262144)
    chunkMax=4194304
    await driver.run(item,new AbortController().signal,save)
    assert.deepEqual(chunkOffsets,[0,262144,4456448,8650752]);assert.equal(installs,1);assert.equal(item.bytesSent,contents.length)
    await assert.rejects(driver.run(item,new AbortController().signal,save),api.Ps5QueueUncertain,'transport complete is not proof of installed version')
    assert.equal(installs,1)
    const changed={...item,installDispatched:false};writeFileSync(source,Buffer.alloc(contents.length,40))
    await assert.rejects(driver.run(changed,new AbortController().signal,patch=>Object.assign(changed,patch)),/изменился|PARAM/)
    // Production capabilities stay disabled: no transfer even for a known PKG.
    let transferCalls=0
    globalThis.fetch=async(url)=>{const path=new URL(url).pathname;if(path==='/api/v1/install/readiness')return response({service:'PackageFlowService-PS5',schemaVersion:1,route:'staged-pkg',ready:false,reason:'installer_unavailable',formats:[],platforms:[],exactVersionReceipt:false});if(path==='/health')return response({apiVersion:'v1',serviceReport:{service:'PackageFlowService-PS5',platform:'ps5',consoleVerified:true}});if(path==='/api/v1/capabilities')return response({service:'PackageFlowService-PS5',capabilities:{installPs4Pkg:false,installPs5Content:false}});if(path==='/api/v1/system')return response({service:'PackageFlowService-PS5',storageRead:false,freeBytes:0,totalBytes:0});transferCalls++;assert.fail(path)}
    await assert.rejects(api.startPs5Queue({consoleId:profile.id,packageIds:['own']}),/не подтвердил/)
    const command={consoleId:profile.id,requestId:'b'.repeat(32),action:'all',gameId:'ps5:PPSA95001'}
    const receipt=api.submitPs5AppCommand(command);assert.equal(receipt.state,'pending')
    await wait(()=>api.ps5AppCommand(profile.id,command.requestId).state==='failed')
    assert.equal(api.submitPs5AppCommand(command).state,'failed');assert.throws(()=>api.submitPs5AppCommand({...command,action:'dlc'}),/уже использован/)
    assert.equal(transferCalls,0)
    const queueFile=join(process.env.PACKAGEFLOW_DATA_DIR,'consoles',profile.id,'ps5-installation-queue.json');mkdirSync(join(process.env.PACKAGEFLOW_DATA_DIR,'consoles',profile.id),{recursive:true})
    const another=api.saveConsoleProfile({name:'corrupt',platform:'ps5',ip:'192.168.1.6'}).consoles.find(c=>c.ip==='192.168.1.6')
    const bad=join(process.env.PACKAGEFLOW_DATA_DIR,'consoles',another.id);mkdirSync(bad,{recursive:true});writeFileSync(join(bad,'ps5-installation-queue.json'),'broken')
    assert.throws(()=>api.getPs5Queue(another.id),/Сохранённый файл/);assert.equal(readFileSync(join(bad,'ps5-installation-queue.json'),'utf8'),'broken')
  }finally{globalThis.fetch=oldFetch;globalThis.createError=oldError;if(oldEnv===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=oldEnv}
})
test('human completion receipt is scoped, durable, idempotent and cannot be undone by an in-flight poll',async()=>{
 let release,marks=0,durable,rejectReceipt=false
 const q=api.ps5BlankQueue('receipt','192.168.1.5')
 const runner=new api.Ps5QueueRunner(q,value=>{if(rejectReceipt && value.items.some(i=>i.confirmation))throw new Error('disk unavailable');durable=structuredClone(value)}, {
  async run(item,signal,save){save({state:'installing',installDispatched:true,serviceJobId:'123-9',bytesSent:item.size});await new Promise(r=>release=r);save({state:'installing',detail:'stale polling response'});throw new api.Ps5QueueUncertain('stale poll')},async cancel(){assert.fail('no system cancellation dispatched')}
 },5,()=>marks++)
 runner.enqueue([input('own')]);await wait(()=>release)
 assert.throws(()=>runner.confirmInstalled('old','own'),/Задание/)
 rejectReceipt=true;assert.throws(()=>runner.confirmInstalled(q.id,'own'),/disk unavailable/);assert.equal(q.items[0].confirmation,undefined);assert.equal(q.items[0].state,'installing');rejectReceipt=false
 runner.confirmInstalled(q.id,'own');assert.equal(durable.items[0].confirmation,'user');assert.equal(durable.items[0].state,'installed')
 runner.confirmInstalled(q.id,'own');assert.equal(marks,1)
 release();await wait(()=>q.status==='completed');assert.equal(q.items[0].state,'installed');assert.equal(q.items[0].detail,'Установку подтвердил пользователь')
 const pending=make({async run(){return{state:'waiting'}},async cancel(){}});pending.runner.enqueue([input('pending')])
 assert.throws(()=>pending.runner.confirmInstalled(pending.q.id,'pending'),/после передачи/)
 pending.q.status='failed'
})
test('real PS5 request transport forwards the registration protocol and still rejects unrelated headers',async()=>{
 const originalFetch=globalThis.fetch, originalError=globalThis.createError
 globalThis.createError=createError
 const profile=api.saveConsoleProfile({name:'image transport',platform:'ps5',ip:'192.168.1.8'}).consoles.find(c=>c.ip==='192.168.1.8')
 const keys=join(process.env.PACKAGEFLOW_DATA_DIR,'ps5-service-keys.json')
 writeFileSync(keys,JSON.stringify({...JSON.parse(readFileSync(keys,'utf8')),[profile.ip]:'b'.repeat(64)}))
 let calls=0
 try {
  globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'http://192.168.1.8:8095/api/v1/images/commit');assert.equal(options.method,'POST');assert.equal(options.headers['X-PackageFlow-Image-Protocol'],'image-registration-v1');assert.equal(options.headers['X-PackageFlow-Transfer-Id'],'c'.repeat(32));return new Response(JSON.stringify({state:'publishing-image'}),{status:202})}
  const result=await api.ps5OperationRequest(profile.id,'/api/v1/images/commit',{'X-PackageFlow-Transfer-Id':'c'.repeat(32),'X-PackageFlow-Image-Protocol':'image-registration-v1'})
  assert.equal(result.status,202);assert.equal(calls,1)
  await assert.rejects(api.ps5OperationRequest(profile.id,'/api/v1/images/commit',{'X-Unrelated':'bad'}),/Invalid PS5 operation/)
  assert.equal(calls,1)
 } finally {globalThis.fetch=originalFetch;globalThis.createError=originalError}
})
test.after(()=>{if(initialData===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=initialData;rmSync(work,{recursive:true,force:true})})

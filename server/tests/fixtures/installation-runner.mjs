// Runs the production queue/client in a temporary cwd. Only the two external
// devices are simulated: payload commands and console HTTP replies.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.cwd()
const directory = mkdtempSync(resolve(tmpdir(), 'packageflow-queue-'))
const mode = process.argv[2]
process.chdir(directory)
mkdirSync('.data')
writeFileSync('game.pkg', Buffer.alloc(1024))
const item = { id: 'one', title: 'Test Game', fileName: 'game.pkg', size: 8589934592, type: 'Игра', titleId: 'CUSA00001', installOrder: 0,
  requiredFirmware: '5.05', sdkFirmware: '5.05',
  contentId: 'EP0000-CUSA00001_00-ABCDEFGHIJKLMNOP', contentType: 'PS4GD', packageDigest: 'a'.repeat(40), iconSize: 0,
  path: resolve('game.pkg'), libraryRoot: directory, sourceModifiedAt: 1, icon: { offset: 0, size: 0 } }
if (mode.startsWith('mini-app')) Object.assign(item, {title:'GameBaTo', titleId:'GBTX00001',contentId:'XX0000-GBTX00001_00-GBTXXXXXXXXXXXXX',contentType:'PS4GDE',requiredFirmware:'0.00',sdkFirmware:undefined})
if (mode === 'icon') {
  item.coverPath = resolve('icon.png')
  item.iconSize = 8
  writeFileSync(item.coverPath, Buffer.from('89504e470d0a1a0a', 'hex'))
}
writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [item], deliveries: {} }))
const ip = '192.168.88.147'
writeFileSync('.data/ps4.json', JSON.stringify({ ip }))
mkdirSync(`.data/consoles/${ip}`, { recursive: true })
const queueFile = mode === 'legacy' ? '.data/installation-queue.json' : `.data/consoles/${ip}/installation-queue.json`
const historyFile = `.data/consoles/${ip}/installation-history.json`
const token = 'abcdef0123456789abcdef0123456789'
const input = { psIp: ip, packageIds: ['one'], packageUrls: { one: 'http://192.168.88.10:3000/json/one.json' } }
const calls = { payload: 0, commands: 0, service: 0, submit: 0, pair: 0, cancel: 0, release: 0, icon: 0 }
globalThis.queueTestCalls = calls
globalThis.createError = value => Object.assign(new Error(value.message), value)
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  },
  load(url, context, next) {
    if (url.endsWith('/server/utils/ps4-installer.ts')) return { format: 'module', shortCircuit: true, source: `
      export async function startInstaller() { globalThis.queueTestCalls.payload++; if(globalThis.queueTestEarlySenderFailure)throw new Error('PyLoader offline before command send'); }
      export async function sendPackage() { globalThis.queueTestCalls.commands++; if (globalThis.queueTestPayloadRace && globalThis.queueTestCalls.commands === 1) await new Promise(resolve => { globalThis.finishPayloadSend = resolve; }); }
    ` }
    return next(url, context)
  },
})
let currentJob, offline = false
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const cap = { service: 'PackegeFlowService', version: '0.4.0', installApi: 1, ready: true, authentication: 'bearer', pairingMode:'automatic', contentTypes: ['PS4GD'], error: 0, errorHex: '0x00000000' }
if (mode === 'mini-app') cap.contentTypes.push('PS4GDE')
const makeJob = id => ({ service: 'PackegeFlowService', jobId: id, requestId: id, contentId: item.contentId, taskId: 43, state: 'downloading',
  totalBytes: item.size, downloadedBytes: 5368709120, downloadTotalBytes: item.size, error: 0, errorHex: '0x00000000', pollError: 0 })
globalThis.fetch = async (url, options) => {
  calls.service++
  const path = new URL(url).pathname
  if (path === '/system/info' && globalThis.cancelBeforeDispatch) { const cancel = globalThis.cancelBeforeDispatch;globalThis.cancelBeforeDispatch=undefined;await delay(0);cancel() }
  if (path.startsWith('/apps/title/') && mode === 'inventory-installed') return response({service:cap.service,complete:true,revision:'a'.repeat(16),app:{titleId:item.titleId,installed:true},total:1,next:null,components:[{kind:'base',version:'01.00',contentId:item.contentId}]})
  if (path.startsWith('/apps/title/')) return response({ service:cap.service, complete:true, revision:'a'.repeat(16), app:{titleId:path.split('/')[3],installed:false}, total:0, next:null, components:[] })
  if (path === '/system/info') return response({ service: cap.service, firmware: globalThis.queueFirmwareUnavailable ? {} : { version: '12.50' } })
  if (path === '/storage') return response({ service: cap.service, volumes: [{ id: 'internal', path: '/user', available: true,
    availableBytes: mode === 'space' ? 1024 : 20 * 1024 ** 3 }] })
  if (path === '/install/pair') { calls.pair++; assert.deepEqual(JSON.parse(options.body), { mode: 'automatic' }); return response({ service: cap.service, paired: true, pairingMode:'automatic', token }) }
  if (path === '/install/capabilities') return response(cap)
  assert.equal(options.headers.Authorization, `Bearer ${token}`)
  if (path === '/install/session') return response(cap)
  if (path === '/install/jobs/active') return response(currentJob&&!['installed','failed','cancelled'].includes(currentJob.state)?{...currentJob,active:true}:{service:cap.service,active:false})
  if (mode === 'busy-restart' && path === '/install/jobs/11111111-1111-4111-8111-111111111111' && !currentJob) return response({error:'job_not_found'},404)
  if (path === '/files/stat' && mode === 'icon') {
    assert.equal(JSON.parse(options.body).path, '/data/PackegeFlowService/install-icon-CUSA00001.png')
    return response({ error: 'not_found' }, 404)
  }
  if (path === '/files/upload/start' && mode === 'icon') {
    assert.equal(JSON.parse(options.body).size, 8)
    return response({ offset: 0 })
  }
  if (path === '/files/upload/11111111-1111-1111-1111-111111111111' && mode === 'icon') {
    assert.equal(Buffer.from(options.body).toString('hex'), '89504e470d0a1a0a')
    calls.icon++
    return response({ offset: 8 })
  }
  if (path === '/files/upload/finish' && mode === 'icon') return response({ completed: true })
  if (path === '/install/jobs' && options.method === 'POST') {
    if (mode === 'removed-job') assert.equal(calls.release, 1, 'the daemon must release its stale reservation before the successor')
    calls.submit++
    if (mode === 'already-installed' && calls.submit === 1) return response({ error: 'component_already_installed', errorHex: '0x00000000' }, 409)
    if (mode === 'busy-rejection' && calls.submit === 1) return response({ error: 'another_service_job_active', errorHex: '0x00000000' }, 409)
    if (mode !== 'busy-rejection') assert.equal(calls.submit, mode === 'already-installed' ? 2 : 1, 'accepted task must never be POSTed twice')
    if (mode === 'icon') assert.equal(calls.icon, 1, 'BGFT icon must be on the console before task registration')
    const body = JSON.parse(options.body); assert.equal(body.size, item.size); assert.equal(body.contentType, ['already-installed','inventory-installed','busy-rejection'].includes(mode) ? 'PS4AC' : mode.startsWith('mini-app') ? 'PS4GDE' : mode.startsWith('cancel-one') || mode === 'task-cancel-service' || ['cancel-game','cancel-selected','cancel-branches'].includes(mode) ? 'PS4GP' : 'PS4GD')
    currentJob = makeJob(body.requestId)
    currentJob.contentId = body.contentId
    throw new Error('Connection lost after PS4 accepted the task')
  }
  assert(currentJob && path.startsWith(`/install/jobs/${currentJob.jobId}`))
  if (offline && !path.endsWith('/cancel')) throw new Error('Temporary connection loss')
  if (path.endsWith('/release')) {
    assert.ok(!currentJob.installing, 'never release while AppInst is active'); calls.release++; currentJob.state='cancelled'
    if (mode === 'removed-job') throw new Error('Reply lost after the daemon released its reservation')
  }
  if (path.endsWith('/cancel')) { calls.cancel++; if (mode !== 'cancel-stuck') currentJob.state = 'cancelled' }
  return response(currentJob)
}
const load = name => import(name === 'installation-queue' && process.env.PACKAGEFLOW_QUEUE_TEST_BUNDLE
  ? pathToFileURL(process.env.PACKAGEFLOW_QUEUE_TEST_BUNDLE).href
  : name === 'ps4-service-installer' && process.env.PACKAGEFLOW_SERVICE_CLIENT_TEST_BUNDLE
    ? pathToFileURL(process.env.PACKAGEFLOW_SERVICE_CLIENT_TEST_BUNDLE).href
    : pathToFileURL(resolve(root, `server/utils/${name}.ts`)).href)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const readQueue = () => JSON.parse(readFileSync(existsSync(`.data/consoles/${ip}/installation-queue.json`) ? `.data/consoles/${ip}/installation-queue.json` : queueFile, 'utf8'))
const installed = () => JSON.parse(readFileSync('.data/package-library.json', 'utf8')).installations?.[ip]?.[`path:${item.path}`]
async function until(check) {
  const deadline = Date.now() + 8000
  while (!check()) { assert(Date.now() < deadline, `timed out in ${mode}`); await delay(30) }
}
try {
  if (mode === 'resume-tail') {
    writeFileSync('.data/ps4-service-keys.json',JSON.stringify({[ip]:token}))
    const accepted={packageId:'accepted',state:'failed',requestId:'22222222-2222-4222-8222-222222222222',serviceDispatchedAt:1,detail:'Receipt retained',bytesSent:0}
    const pending={packageId:'one',state:'pending',url:input.packageUrls.one,detail:'Waiting',bytesSent:0}
    writeFileSync(queueFile,JSON.stringify({version:1,id:'newer',psIp:ip,status:'completed',items:[],createdAt:2}))
    writeFileSync(historyFile,JSON.stringify([{version:1,id:'stopped',psIp:ip,status:'failed',transport:'service',items:[accepted,pending],createdAt:1}]))
    const queue=await load('installation-queue')
    const resumed=queue.resumeInstallationQueue('stopped',ip)
    assert.equal(resumed.items.length,1);assert.equal(resumed.items[0].packageId,'one');assert.notEqual(resumed.id,'stopped')
    assert.throws(()=>queue.resumeInstallationQueue('stopped',ip),'double click cannot replay a resumed tail')
    const old=queue.getInstallationHistory(ip).find(q=>q.id==='stopped')
    assert.deepEqual(old.items[0],accepted,'accepted receipt is preserved and never replayed')
    assert.equal(old.items[1].state,'cancelled')
    await until(()=>calls.submit===1&&readQueue().items[0].serviceJobId)
    currentJob.state='installed';await until(()=>readQueue().status==='completed')
    assert.equal(calls.submit,1)
    assert.throws(()=>queue.resumeInstallationQueue('stopped',ip),'finished resumed queue cannot be sent again')
  } else if (mode === 'service-speed' || mode === 'payload-speed') {
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
    const queue = await load('installation-queue'), scope = await load('console-scope'), tasks = await load('installation-tasks')
    const task = () => scope.inConsoleScope(ip, () => tasks.getInstallationTasks({ ip, view: 'tree' }).active[0])
    queue.startInstallationQueue({ ...input, transport: mode === 'service-speed' ? 'service' : 'payload' })
    if (mode === 'service-speed') {
      await until(() => readQueue().items[0].state === 'receiving')
      assert.equal(task().transferBytesPerSecond, 0, 'initial resumed bytes are not current transfer')
      const next = currentJob.downloadedBytes + 30 * 1048576
      currentJob.downloadedBytes = next
      await until(() => readQueue().items[0].bytesSent === next)
      assert(task().transferBytesPerSecond > 0, 'task API must publish actual PS4 service progress rate')
      assert.equal(task().consolePlatform, 'ps4')
      assert.equal(task().bytesSent, next)
      assert.equal('transferBytesPerSecond' in readQueue().items[0], false, 'live rate is not persisted')
      currentJob.state = 'installed'; currentJob.downloadedBytes = item.size
      await until(() => readQueue().status === 'completed')
      const done = scope.inConsoleScope(ip, () => tasks.getInstallationTasks({ ip, view: 'tree' }).items[0])
      assert.equal(done.transferBytesPerSecond, undefined)
    } else {
      await until(() => readQueue().items[0].state === 'waiting')
      const library = await load('package-library')
      scope.inConsoleScope(ip, () => library.recordPackageDelivery(item.id, 0, 150 * 1048576 - 1, false))
      await until(() => readQueue().items[0].bytesSent === 150 * 1048576)
      scope.inConsoleScope(ip, () => library.recordPackageDelivery(item.id, 0, 180 * 1048576 - 1, false))
      await until(() => readQueue().items[0].bytesSent === 180 * 1048576)
      assert(task().transferBytesPerSecond > 0, 'legacy HTTP delivery must publish its rate too')
      assert.equal(task().progressPhase, 'transfer')
      assert.equal('transferBytesPerSecond' in readQueue().items[0], false)
      queue.cancelInstallationQueue(); await until(() => readQueue().status === 'cancelled')
    }
  } else if (mode === 'removed-job') {
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({[ip]:token}))
    const next={...item,id:'two',title:'Second Game',titleId:'CUSA00002',contentId:'EP0000-CUSA00002_00-ABCDEFGHIJKLMNOP'};
    writeFileSync('.data/package-library.json',JSON.stringify({version:2,packages:[item,next],deliveries:{}}));
    const removedId='11111111-1111-1111-1111-111111111111';
    currentJob=makeJob(removedId);Object.assign(currentJob,{state:'uncertain',error:-2137456615,errorHex:'0x80990019',pollError:-2137456615,installing:true});
    writeFileSync(queueFile,JSON.stringify({version:1,id:'removed-queue',status:'running',transport:'service',psIp:ip,createdAt:1,items:[{packageId:'one',url:input.packageUrls.one,state:'verifying',detail:'',bytesSent:0,requestId:removedId,serviceDispatchedAt:1},{packageId:'two',url:'http://192.168.88.10:3000/json/two.json',state:'pending',detail:'',bytesSent:0}]}));
    const queue=await load('installation-queue');queue.ensureInstallationQueueRunning();await until(()=>readQueue().items[0].serviceTaskId===43);assert.equal(calls.submit,0,'wait while PS4 still reports installation in progress');currentJob.installing=false;await until(()=>calls.submit===1);assert.equal(readQueue().items[0].state,'unconfirmed','removed PS4 task is terminal without claiming installation');assert.equal(currentJob.contentId,next.contentId);currentJob.state='installed';await until(()=>readQueue().status==='completed');assert.equal(readQueue().items[1].state,'installed');assert.equal(calls.submit,1,'successor is dispatched once');
  } else if (mode === 'payload-early-failure') {
    const queue=await load('installation-queue')
    globalThis.queueTestEarlySenderFailure=true
    queue.startInstallationQueue({...input,transport:'payload'})
    await until(()=>readQueue().status==='failed')
    assert.equal(readQueue().currentIndex,0)
    assert.equal(readQueue().items[0].state,'failed','early failure must not leave a sending task in a stopped queue')
    assert.equal(calls.commands,0);assert.equal(calls.service,0)
  } else if (['payload-small-chain','payload-manifest-timeout','service-small-chain','service-rejected-chain','service-lost-receipt','missing-source-chain'].includes(mode)) {
    const packages=['one','two','three'].map((id,index)=>({...item,id,title:`Small package ${index}`,titleId:`CUSA9500${index}`,contentId:`IV0000-CUSA9500${index}_00-PACKAGEFLOWUI001`,packageDigest:String(index+1).repeat(40),size:32768+index*1024,path:resolve(`${id}.pkg`)}))
    for(const pkg of packages)writeFileSync(pkg.path,Buffer.alloc(pkg.size))
    writeFileSync('.data/package-library.json',JSON.stringify({version:2,packages,deliveries:{}}))
    const queue=await load('installation-queue'),scope=await load('console-scope'),library=await load('package-library')
    const requestIds=[]
    const payloadMode=mode.startsWith('payload-')
    if(!payloadMode) {
      writeFileSync('.data/ps4-service-keys.json',JSON.stringify({[ip]:token}))
      globalThis.fetch=async(url,options={})=>{
        const path=new URL(url).pathname;calls.service++
        if(path.startsWith('/apps/title/'))return response({service:cap.service,complete:true,revision:'a'.repeat(16),app:{titleId:path.split('/')[3],installed:false},total:0,next:null,components:[]})
        if(path==='/storage')return response({service:cap.service,volumes:[{id:'internal',path:'/user',available:true,availableBytes:20*1024**3}]})
        if(path==='/system/info')throw new Error('Optional PKG preflight is disabled')
        if(path==='/install/jobs/active')return response(currentJob&&!['installed','failed','cancelled'].includes(currentJob.state)?{...currentJob,active:true}:{service:cap.service,active:false})
        if(path==='/install/jobs'&&options.method==='POST') {
          const body=JSON.parse(options.body);calls.submit++;requestIds.push(body.requestId)
          assert.equal(new Set(requestIds).size,requestIds.length,'each accepted command is dispatched once')
          if(mode==='service-rejected-chain'&&calls.submit===1)return response({error:'invalid_game_request'},422)
          currentJob={...makeJob(body.requestId),contentId:body.contentId,totalBytes:body.size,downloadTotalBytes:body.size,downloadedBytes:body.size,state:mode==='service-small-chain'&&calls.submit===2?'failed':'installed',errorHex:mode==='service-small-chain'&&calls.submit===2?'0x80990077':'0x00000000'}
          if(mode==='missing-source-chain'&&calls.submit===1)rmSync(packages[1].path)
          if(mode==='service-lost-receipt'&&calls.submit===1)throw new Error('Accepted POST reply lost')
          return response(currentJob)
        }
        if(currentJob&&path===`/install/jobs/${currentJob.requestId}`) {
          if(mode==='service-lost-receipt'&&!globalThis.receiptRestored)return response({error:'job_not_found'},404)
          return response(currentJob)
        }
        throw new Error(`Unexpected request: ${path}`)
      }
    }
    queue.startInstallationQueue({...input,packageIds:packages.map(p=>p.id),packageUrls:Object.fromEntries(packages.map(p=>[p.id,`http://192.168.88.10:3000/json/${p.id}.json`])),transport:payloadMode?'payload':'service'})
    if(mode==='payload-manifest-timeout') {
      await until(()=>calls.commands===1&&readQueue().items[0].state==='waiting')
      const realClock=Date.now;let now=realClock();Date.now=()=>now
      try {
        scope.inConsoleScope(ip,()=>library.recordPackageRequest('one'))
        const unregister=scope.inConsoleScope(ip,()=>library.registerActiveTransfer('one',()=>{}))
        now+=31000;await delay(1600);assert.equal(calls.commands,1,'an active stream is never timed out while opening a slow source')
        scope.inConsoleScope(ip,unregister);now+=31000
        await until(()=>calls.commands===2)
        assert.equal(readQueue().items[0].state,'unconfirmed','manifest/HEAD alone must not stall the queue forever or claim installation')
        scope.inConsoleScope(ip,()=>library.recordPackageDelivery('two',0,packages[1].size-1,true))
        await until(()=>calls.commands===3)
        scope.inConsoleScope(ip,()=>library.recordPackageDelivery('three',0,packages[2].size-1,true))
        await until(()=>readQueue().status==='completed');assert.equal(calls.service,0)
      } finally {Date.now=realClock}
    } else if(mode==='payload-small-chain') {
      for(let index=0;index<packages.length;index++) {
        await until(()=>calls.commands===index+1&&readQueue().items[index].state==='waiting')
        const pkg=packages[index]
        scope.inConsoleScope(ip,()=>library.recordPackageDelivery(pkg.id,pkg.size-16,pkg.size-1,false))
        await delay(1600)
        assert.equal(calls.commands,index+1,'tail probes cannot release the next tiny package')
        scope.inConsoleScope(ip,()=>library.recordPackageDelivery(pkg.id,0,pkg.size-17,true))
      }
      await until(()=>readQueue().status==='completed')
      assert.equal(calls.service,0);assert.equal(calls.commands,3)
      assert.deepEqual(readQueue().items.map(p=>p.state),['delivered','delivered','delivered'])
      assert.equal(installed(),undefined,'HTTP completion does not claim installation')
    } else {
      if(mode==='service-lost-receipt') {
        await until(()=>readQueue().items[0].state==='verifying')
        await delay(1600);assert.equal(calls.submit,1,'lost receipt must not send the successor or replay POST')
        globalThis.receiptRestored=true
      }
      await until(()=>readQueue().status==='completed')
      assert.equal(calls.submit,mode==='missing-source-chain'?2:3)
      assert.deepEqual(readQueue().items.map(p=>p.state),['service-small-chain','missing-source-chain'].includes(mode)?['installed','failed','installed']:mode==='service-rejected-chain'?['failed','installed','installed']:['installed','installed','installed'])
    }
  } else if (mode === 'preference') {
    const preference = await load('installation-preference')
    assert.equal(preference.getInstallationPreference(), 'service')
    assert.equal(preference.setInstallationPreference('payload'), 'payload')
    assert.equal(preference.getInstallationPreference(), 'payload')
    assert.throws(() => preference.setInstallationPreference('auto'))
    assert.equal(preference.getInstallationPreference(), 'payload')
  } else if (mode === 'legacy') {
    writeFileSync(queueFile, JSON.stringify({ version: 1, status: 'running', psIp: ip, createdAt: 1,
      items: [{ packageId: 'one', url: input.packageUrls.one, state: 'waiting', detail: '', bytesSent: 0, dispatchedAt: Date.now() - 25000 }] }))
    const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
    await until(() => readQueue().status === 'completed')
    assert.equal(readQueue().transport, 'payload'); assert.equal(readQueue().items[0].state, 'unconfirmed')
    assert.equal(installed(), undefined); assert.equal(calls.service, 0); assert.equal(calls.commands, 0)
  } else if (mode === 'payload-firmware' || mode === 'payload-firmware-unavailable') {
    writeFileSync('.data/ps4-service-keys.json',JSON.stringify({[ip]:token}))
    const newer = { ...item, id: 'newer', title: 'Too New', requiredFirmware: '13.00' }
    writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [newer, item], deliveries: {} }))
    const queue = await load('installation-queue')
    globalThis.queueFirmwareUnavailable = mode === 'payload-firmware-unavailable'
    writeFileSync('.data/ps4-install-settings.json',JSON.stringify({verifyPkgBeforeSend:true}))
    if (!globalThis.queueFirmwareUnavailable) writeFileSync('.data/console-profiles.json',JSON.stringify({consoles:[{ip,platform:'ps4',firmware:'12.50'}]}))
    queue.startInstallationQueue({ ...input, packageIds: ['newer', 'one'], packageUrls: { ...input.packageUrls, newer: input.packageUrls.one }, transport: 'payload' })
    if (globalThis.queueFirmwareUnavailable) {
      await until(()=>calls.commands===1)
      assert.equal(calls.service,0,'unknown firmware does not create a dependency on PackageFlowService')
      queue.cancelInstallationQueue()
    } else {
      await until(() => calls.commands === 1)
      assert.equal(readQueue().items[0].state, 'skipped'); assert.match(readQueue().items[0].detail, /13\.00.*12\.50/)
      assert.equal(readQueue().items[1].packageId, 'one'); assert.equal(calls.payload, 1)
      queue.cancelInstallationQueue()
    }
  } else if (mode === 'payload') {
    const queue = await load('installation-queue')
    assert.throws(() => queue.startInstallationQueue({ ...input, transport: 'auto' }))
    assert.throws(() => queue.startInstallationQueue(input), /подключите|сопряжения/)
    const preference = await load('installation-preference')
    preference.setInstallationPreference('payload')
    queue.startInstallationQueue(input)
    await until(()=>calls.commands===1)
    assert.equal(calls.service,0,'unpaired PyLoader works with the service switched off')
    assert.equal(installed(),undefined,'sending a payload does not prove installation')
    queue.cancelInstallationQueue()
    writeFileSync('.data/ps4-service-keys.json',JSON.stringify({[ip]:token}))
    const result = queue.startInstallationQueue(input); assert.equal(result.transport, 'payload')
    await until(() => calls.commands === 2)
    assert.equal(calls.service,0,'even a paired PyLoader must not query the service'); assert.equal(calls.payload, 2)
    queue.cancelInstallationQueue(); assert.equal(readQueue().status, 'cancelled')
    await delay(1550); assert.equal(calls.commands, 2)
  } else if (mode === 'task-remove-pending') {
    writeFileSync('.data/package-library.json', JSON.stringify({version:2,packages:[item,{...item,id:'two',title:'Queued DLC'}],deliveries:{}}))
    writeFileSync(queueFile, JSON.stringify({version:1,transport:'payload',id:'tasks-test',status:'running',psIp:ip,createdAt:1,
      items:[{packageId:'one',url:input.packageUrls.one,state:'waiting',detail:'Active',bytesSent:123,dispatchedAt:Date.now()},
        {packageId:'two',url:input.packageUrls.one,state:'pending',detail:'',bytesSent:0}]}))
    const queue = await load('installation-queue')
    assert.throws(()=>queue.cancelInstallationItem('old','two',ip),/изменилось/)
    assert.throws(()=>queue.cancelInstallationItem('tasks-test','two','192.168.88.148'),/изменилось/)
    const result=queue.cancelInstallationItem('tasks-test','two',ip)
    assert.equal(result.items.length,2);assert.equal(result.items[0].state,'waiting');assert.equal(result.items[1].state,'cancelled')
    assert.match(result.items[1].detail,/не отправлен/)
    assert.throws(()=>queue.cancelInstallationItem('tasks-test','two',ip),/изменилось/)
    assert.equal(calls.commands,0)
    queue.cancelInstallationQueue()
    const failedQueue=readQueue();failedQueue.status='failed';failedQueue.items[0].state='failed';failedQueue.items[1].state='pending'
    writeFileSync(queueFile,JSON.stringify(failedQueue))
    const tasks=await load('installation-tasks')
    assert(tasks.getInstallationTasks({categories:'queued'}).items[0].canCancel,'pending rows remain removable after a queue error')
    queue.cancelInstallationItem('tasks-test','two',ip)
    assert.equal(readQueue().status,'cancelled','removing the last pending row releases a failed queue');assert.equal(readQueue().items[1].state,'cancelled');assert.equal(calls.commands,0)
  } else if (mode === 'task-cancel-payload-race') {
    writeFileSync('.data/ps4-service-keys.json',JSON.stringify({[ip]:token}))
    globalThis.queueTestPayloadRace=true
    writeFileSync('.data/package-library.json',JSON.stringify({version:2,packages:[item,{...item,id:'two',title:'Next package'}],deliveries:{}}))
    const queue=await load('installation-queue')
    queue.startInstallationQueue({...input,transport:'payload',packageIds:['one','two'],packageUrls:{...input.packageUrls,two:input.packageUrls.one}})
    await until(()=>calls.commands===1&&globalThis.finishPayloadSend)
    const result=queue.cancelInstallationItem(readQueue().id,'one',ip)
    assert.equal(result.items[0].state,'cancelled');assert.equal(result.items[1].state,'pending')
    globalThis.finishPayloadSend()
    await until(()=>calls.commands===2&&readQueue().items[1].state==='waiting')
    assert.equal(readQueue().items[0].state,'cancelled','late send response never resurrects the cancelled item')
    assert.equal(readQueue().items[1].state,'waiting','remaining queue continues')
    queue.cancelInstallationQueue()
  } else if (mode === 'task-clear') {
    const current={version:1,transport:'payload',id:'clear-current',status:'running',psIp:ip,createdAt:1,items:[
      {packageId:'one',state:'waiting',url:input.packageUrls.one,detail:'active',bytesSent:100,dispatchedAt:Date.now()+100000},
      {packageId:'two',state:'pending',detail:'queued',bytesSent:0},
      {packageId:'three',state:'installed',detail:'done',bytesSent:100},
      {packageId:'four',state:'failed',detail:'failed',bytesSent:0}]}
    writeFileSync(queueFile,JSON.stringify(current))
    writeFileSync(historyFile,JSON.stringify([{...current,id:'old',status:'completed',items:[{packageId:'old',state:'delivered',detail:'done',bytesSent:100}]}]))
    const tasks=await load('installation-tasks'), visibility=await load('task-visibility')
    const result=visibility.clearFinishedTasks([{hash:'a'.repeat(40),state:'uploading',progress:1},{hash:'b'.repeat(40),state:'downloading',progress:0.5}])
    assert.equal(result.cleared,3);assert.equal(Object.keys(result.hiddenTorrents).length,1)
    const after=tasks.getInstallationTasks();assert.deepEqual(after.counts,{active:1,queued:1,completed:0,failed:0});assert.equal(readQueue().items.length,4);assert.equal(readQueue().items[2].state,'installed');assert.equal(calls.commands,0)
    assert.equal(visibility.clearFinishedTasks().cleared,0)
    const next=readQueue();next.items[1].state='installed';writeFileSync(queueFile,JSON.stringify(next));assert.equal(tasks.getInstallationTasks().counts.completed,1,'future completions remain visible')
    assert.equal(readFileSync('.data/task-visibility.json','utf8').includes('clear-current:three'),true,'cleanup persists across restart')
  } else if (mode === 'task-history') {
    const previous={version:1,transport:'payload',id:'previous',status:'completed',psIp:ip,createdAt:1,
      items:Array.from({length:70},(_,index)=>({packageId:`old-${index}`,title:`Previous ${index}`,titleId:'CUSA00001',fileName:`Old-${index}.pkg`,size:1024,type:'DLC',state:index===0?'failed':'delivered',detail:'Previous detail',bytesSent:1024}))}
    writeFileSync(queueFile,JSON.stringify(previous))
    const queue=await load('installation-queue')
    queue.startInstallationQueue({...input,transport:'payload'})
    assert.equal(queue.getInstallationHistory()[0].items.length,70)
    queue.cancelInstallationQueue()
    const tasks=await load('installation-tasks')
    const all=tasks.getInstallationTasks()
    assert.equal(all.total,71);assert.equal(all.items.length,50);assert.equal(all.pages,2)
    assert.equal(tasks.getInstallationTasks({page:2}).items.length,21)
    const failed=tasks.getInstallationTasks({categories:'failed'})
    assert.equal(failed.total,1);assert.equal(failed.items[0].fileName,'Old-0.pkg');assert.equal(failed.counts.completed,70)
    assert.equal(tasks.getInstallationTasks({categories:''}).items.length,0)
    const tree=tasks.getInstallationTasks({view:'tree'})
    assert.equal(tree.unit,'games');assert.equal(tree.total,1);assert.equal(tree.items.length,71,'tree keeps a complete game branch on one page')
    assert.equal(tree.items[0].type,'Игра');assert(tree.items.every(task=>task.groupTitle==='Test Game'))
    assert.equal(tasks.getInstallationTasks({view:'tree',categories:'failed'}).items.length,1)

    assert(!JSON.stringify(all).includes('http://'));assert(!JSON.stringify(all).includes('game.pkg\\'))
  } else if (mode === 'append') {
    writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [item, { ...item, id: 'two', title: 'Queued Patch', contentType: 'PS4GP', installOrder: 1 }], deliveries: {} }))
    writeFileSync(queueFile, JSON.stringify({ version: 1, transport: 'payload', id: 'active', status: 'running', psIp: ip, createdAt: 1,
      items: [{ packageId: 'one', url: input.packageUrls.one, state: 'waiting', detail: 'PS4 скачивает пакет', bytesSent: 1234, dispatchedAt: Date.now() }] }))
    const queue = await load('installation-queue')
    const result = queue.appendInstallationQueue({ psIp: ip, queueId: 'active', packageIds: ['two'], packageUrls: { two: 'http://192.168.88.10:3000/json/two.json' } })
    assert.equal(result.items.length, 2)
    assert.equal(result.items[0].state, 'waiting'); assert.equal(result.items[0].bytesSent, 1234)
    assert.equal(result.items[1].state, 'pending')
    assert.throws(() => queue.appendInstallationQueue({ psIp: ip, queueId: 'active', packageIds: ['two'], packageUrls: {} }), /уже находятся/)
    assert.throws(() => queue.appendInstallationQueue({ psIp: ip, queueId: 'old', packageIds: ['two'], packageUrls: {} }), /изменилась/)
    queue.cancelInstallationQueue()
  } else if (['cancel-game','cancel-selected','cancel-branches'].includes(mode)) {
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({[ip]:token}))
    const packages = [item, {...item,id:'patch',contentType:'PS4GP',installOrder:1},
      {...item,id:'other',titleId:'CUSA00002',contentId:'EP0000-CUSA00002_00-ABCDEFGHIJKLMNOP',contentType:'PS4GP'},
      {...item,id:'done',contentType:'PS4AC',installOrder:2}]
    writeFileSync('.data/package-library.json', JSON.stringify({version:2,packages,deliveries:{}}))
    const id='11111111-1111-1111-1111-111111111111';currentJob=makeJob(id)
    writeFileSync(queueFile, JSON.stringify({version:1,transport:'service',id:'game-test',status:'running',psIp:ip,createdAt:1,
      items:[{packageId:'one',url:input.packageUrls.one,state:'receiving',detail:'',bytesSent:10,requestId:id,serviceDispatchedAt:1},
        {packageId:'patch',url:input.packageUrls.one,state:'pending',detail:'',bytesSent:0},
        {packageId:'other',url:input.packageUrls.one,state:'pending',detail:'',bytesSent:0},
        {packageId:'done',url:input.packageUrls.one,state:'installed',detail:'',bytesSent:0}]}))
    const queue = await load('installation-queue')
    assert.throws(()=>queue.cancelGameInstallation('old',ip,'CUSA00001'))
    assert.throws(()=>queue.cancelGameInstallation('game-test','192.168.88.148','CUSA00001'))
    assert.throws(()=>queue.cancelGameInstallation('game-test',ip,'CUSA00003'))
    if(mode==='cancel-selected'){
      assert.throws(()=>queue.cancelInstallationItems('old',['one','patch'],ip));assert.throws(()=>queue.cancelInstallationItems('game-test',['one'],'192.168.88.148'))
    }
    const result=mode==='cancel-selected'?queue.cancelInstallationItems('game-test',['one','patch','done'],ip):mode==='cancel-branches'?queue.cancelGameInstallations('game-test',ip,['CUSA00001']):queue.cancelGameInstallation('game-test',ip,'CUSA00001')
    assert.equal(result.items[0].cancelRequested,true);assert.equal(result.items[1].state,'cancelled')
    assert.equal(result.items[1].serviceDispatchedAt,undefined,'queued branch package is removed before dispatch')
    assert.equal(result.items[2].cancelRequested,undefined);assert.equal(result.items[3].cancelRequested,undefined)
    await until(()=>calls.submit===1&&readQueue().items[2].serviceDispatchedAt)
    assert.equal(calls.cancel,1);assert.equal(readQueue().items[0].state,'cancelled');assert.equal(readQueue().items[1].state,'cancelled')
    assert.equal(currentJob.contentId,packages[2].contentId)
    currentJob.state='installed';await until(()=>readQueue().status==='completed')
    assert.equal(readQueue().items[2].state,'installed');assert.equal(readQueue().items[3].state,'installed')
    assert.equal(calls.submit,1);assert.match(readQueue().message,/отменено — 2/)
  } else if (mode === 'cancel-one' || mode === 'cancel-one-before-dispatch' || mode === 'task-cancel-service') {
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({[ip]:token}))
    writeFileSync('.data/package-library.json', JSON.stringify({version:2,packages:[item,{...item,id:'two',title:'Next package',contentType:'PS4GP',installOrder:1}],deliveries:{}}))
    const queue = await load('installation-queue')
    if (mode === 'cancel-one' || mode === 'task-cancel-service') {
      const id='11111111-1111-1111-1111-111111111111';currentJob=makeJob(id)
      writeFileSync(queueFile,JSON.stringify({version:1,transport:'service',id:'current-test',status:'running',psIp:ip,createdAt:1,
        items:[{packageId:'one',url:input.packageUrls.one,state:'receiving',detail:'',bytesSent:10,requestId:id,serviceDispatchedAt:1},
          {packageId:'two',url:input.packageUrls.one,state:'pending',detail:'',bytesSent:0}]}))
      assert.throws(()=>queue.cancelCurrentInstallation('old','one',ip))
      assert.throws(()=>queue.cancelCurrentInstallation('current-test','two',ip))
      if (mode === 'task-cancel-service') queue.cancelInstallationItem('current-test','one',ip)
      else queue.cancelCurrentInstallation('current-test','one',ip)
    } else {
      writeFileSync('.data/ps4-install-settings.json',JSON.stringify({verifyPkgBeforeSend:true}))
      globalThis.cancelBeforeDispatch=()=>queue.cancelCurrentInstallation(readQueue().id,'one',ip)
      queue.startInstallationQueue({...input,transport:'service',packageIds:['one','two'],packageUrls:{...input.packageUrls,two:input.packageUrls.one}})
    }
    await until(()=>calls.submit===1&&currentJob&&readQueue().items[1].serviceDispatchedAt)
    assert.equal(readQueue().items[0].state,'cancelled');assert.equal(calls.cancel,mode==='cancel-one'||mode==='task-cancel-service'?1:0)
    assert.throws(()=>queue.cancelCurrentInstallation(readQueue().id,'one',ip))
    currentJob.state='installed';await until(()=>readQueue().status==='completed')
    assert.equal(readQueue().items[1].state,'installed');assert.equal(calls.submit,1);assert.match(readQueue().message,/с ошибкой — 0, отменено — 1/)
  } else if (mode === 'busy-restart') {
    writeFileSync('.data/ps4-service-keys.json',JSON.stringify({[ip]:token}))
    const id='busy-reinstall',requestId='11111111-1111-4111-8111-111111111111'
    writeFileSync('.data/console-maintenance.json',JSON.stringify({[ip]:{id,kind:'selected-reinstall',state:'failed',index:1,steps:[{dispatched:true}],message:'Service busy'}}))
    writeFileSync(queueFile,JSON.stringify({version:1,id,maintenanceId:id,transport:'service',psIp:ip,status:'failed',createdAt:1,items:[{packageId:'one',title:item.title,titleId:item.titleId,fileName:item.fileName,size:item.size,url:input.packageUrls.one,state:'failed',detail:'На PS4 уже есть активное задание сервиса (0x00000000)',bytesSent:0,requestId,serviceDispatchedAt:1}]}))
    const queue=await load('installation-queue');queue.getInstallationQueue(ip)
    await until(()=>calls.submit===1 && currentJob)
    assert.equal(currentJob.requestId,requestId)
    assert.equal(JSON.parse(readFileSync('.data/console-maintenance.json'))[ip].state,'installing')
    currentJob.state='installed';await until(()=>readQueue().status==='completed')
    assert.equal(calls.submit,1,'missing rejected receipt resumes installation without repeating deletion')
  } else if (mode === 'busy-wait') {
    writeFileSync('.data/ps4-service-keys.json',JSON.stringify({[ip]:token}))
    currentJob=makeJob('11111111-1111-4111-8111-111111111111')
    const queue=await load('installation-queue');queue.startInstallationQueue({...input,transport:'service'})
    await until(()=>readQueue().items[0].detail.includes('предыдущего задания'))
    assert.equal(calls.submit,0);assert.equal(readQueue().items[0].serviceDispatchedAt,undefined)
    currentJob.state='installed'
    await until(()=>calls.submit===1)
    currentJob.state='installed';await until(()=>readQueue().status==='completed');assert.equal(calls.submit,1)
  } else if (mode === 'space') {
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
    const queue = await load('installation-queue')
    queue.startInstallationQueue({ ...input, transport: 'service' })
    await until(() => readQueue().status === 'failed')
    assert.match(readQueue().items[0].detail, /Недостаточно места/)
    assert.equal(calls.submit, 0)
  } else if (mode === 'firmware') {
    writeFileSync('.data/ps4-install-settings.json',JSON.stringify({verifyPkgBeforeSend:true}))
    writeFileSync('.data/ps4-service-keys.json',JSON.stringify({[ip]:token}))
    const newer = { ...item, id: 'newer', title: 'Too New', requiredFirmware: '13.00', sdkFirmware: '13.00' }
    writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [newer, item], deliveries: {} }))
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
    const queue = await load('installation-queue')
    queue.startInstallationQueue({ ...input, packageIds: ['newer', 'one'], packageUrls: { ...input.packageUrls, newer: input.packageUrls.one }, transport: 'service' })
    await until(() => calls.submit === 1)
    assert.equal(readQueue().items[0].state, 'skipped')
    assert.match(readQueue().items[0].detail, /13\.00.*12\.50/)
    assert.equal(readQueue().items[1].packageId, 'one')
    currentJob.state = 'installed'
    await until(() => readQueue().status === 'completed')
    assert.equal(readQueue().items[1].state, 'installed')
    assert.match(readQueue().message, /пропущено.*1/)
  } else if (mode.startsWith('mini-app')) {
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({[ip]:token}))
    const queue = await load('installation-queue')
    queue.startInstallationQueue({...input,transport:'service'})
    if (mode === 'mini-app-old-service') {
      await until(()=>readQueue().status==='failed')
      assert.equal(calls.submit,0);assert.match(readQueue().items[0].detail,/1\.69/)
    } else {
      await until(()=>calls.submit===1&&currentJob)
      assert.equal(currentJob.contentId,item.contentId)
      currentJob.state='installed';await until(()=>readQueue().status==='completed')
      assert.equal(calls.submit,1);assert.equal(readQueue().items[0].state,'installed')
    }
  } else if (mode === 'firmware-unverified') {
    writeFileSync('.data/ps4-install-settings.json',JSON.stringify({verifyPkgBeforeSend:true}))
    writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [{ ...item, requiredFirmware: undefined, sdkFirmware: undefined }], deliveries: {} }))
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
    const queue = await load('installation-queue')
    queue.startInstallationQueue({ ...input, transport: 'service' })
    await until(() => readQueue().status === 'completed')
    assert.equal(readQueue().items[0].state, 'skipped')
    assert.equal(calls.submit, 0)
  } else {
    const client = await load('ps4-service-installer')
    if (mode === 'inventory-installed') {
      writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
      const next = { ...item, id:'two', title:'New DLC', type:'DLC', installOrder:2, contentType:'PS4AC', contentId:'EP0000-CUSA00001_00-NEWDLC0000000001',packageDigest:'b'.repeat(40) }
      writeFileSync('.data/package-library.json',JSON.stringify({version:2,packages:[{...item,appVersion:'01.00'},next],deliveries:{}}))
      const queue=await load('installation-queue')
      queue.startInstallationQueue({...input,packageIds:['one','two'],packageUrls:{...input.packageUrls,two:input.packageUrls.one},transport:'service'})
      await until(()=>calls.submit===1 && currentJob)
      assert.equal(readQueue().items[0].state,'skipped');assert.match(readQueue().items[0].detail,/уже установлен/)
      assert.equal(currentJob.contentId,next.contentId,'only the new DLC is sent')
      currentJob.state='installed';await until(()=>readQueue().status==='completed')
      assert.equal(calls.submit,1);assert.equal(readQueue().items[1].state,'installed');assert.ok(readQueue().items[0].installedAt)
    } else if (mode === 'already-installed' || mode === 'busy-rejection') {
      writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
      writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [{ ...item, contentType: 'PS4AC' }, { ...item, id: 'two', title: 'Next Package', contentType: 'PS4AC' }], deliveries: {} }))
      const queue = await load('installation-queue')
      queue.startInstallationQueue({ ...input, packageIds: ['one', 'two'], packageUrls: { ...input.packageUrls, two: input.packageUrls.one }, transport: 'service' })
      if (mode === 'busy-rejection') {
        await until(() => readQueue().items[0].detail.includes('предыдущего задания'))
        assert.equal(readQueue().status,'running')
        assert.equal(readQueue().items[0].state, 'pending')
        assert.equal(readQueue().items[0].serviceDispatchedAt,undefined)
        assert.equal(readQueue().items[1].state, 'pending')
        const requestId=readQueue().items[0].requestId
        await until(()=>calls.submit===2 && currentJob)
        assert.equal(currentJob.requestId,requestId,'only the explicitly rejected request may be tried again')
        currentJob.state='installed'
        await until(()=>calls.submit===3 && currentJob.requestId!==requestId)
        currentJob.state='installed';await until(()=>readQueue().status==='completed')
        assert.equal(calls.submit,3,'accepted commands are never repeated, and the successor runs')
      } else {
        await until(() => calls.submit === 2 && currentJob)
        assert.equal(readQueue().items[0].state, 'skipped')
        assert.match(readQueue().items[0].detail, /уже установлен/)
        currentJob.state = 'installed'
        await until(() => readQueue().status === 'completed')
        assert.equal(readQueue().items[1].state, 'installed')
        assert.match(readQueue().message, /пропущено — 1/)
      }
    } else if (mode === 'silent-stall') {
      writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
      writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [item, { ...item, id: 'two', title: 'Next Package' }], deliveries: {} }))
      const id = '11111111-1111-1111-1111-111111111111'
      currentJob = { ...makeJob(id), state: 'installing', downloadedBytes: item.size, installing: false, updating: 0 }
      writeFileSync(queueFile, JSON.stringify({ version: 1, transport: 'service', id: 'recovered', status: 'running', psIp: ip, createdAt: 1,
        items: [
          { packageId: 'one', url: input.packageUrls.one, state: 'installing', detail: '', bytesSent: item.size, requestId: id, serviceDispatchedAt: 1,
            serviceIdleSince: Date.now() - 16 * 60_000, serviceProgress: `${item.size}:${item.size}:::` },
          { packageId: 'two', url: input.packageUrls.one, state: 'pending', detail: 'Ожидает очереди', bytesSent: 0 },
        ] }))
      const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
      await until(() => calls.cancel === 1 && calls.submit === 1)
      assert.equal(readQueue().items[0].state, 'unconfirmed')
      assert.match(readQueue().items[0].detail, /не подтвердила установку/)
      currentJob.state = 'installed'
      await until(() => readQueue().status === 'completed')
      assert.equal(readQueue().items[1].state, 'installed')
    } else if (mode === 'terminal-failure') {
      writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
      writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [item, { ...item, id: 'two', title: 'Next Package' }], deliveries: {} }))
      const id = '11111111-1111-1111-1111-111111111111'
      currentJob = { ...makeJob(id), state: 'failed', error: -2137456521, errorHex: '0x80990077' }
      writeFileSync(queueFile, JSON.stringify({ version: 1, transport: 'service', id: 'recovered', status: 'running', psIp: ip, createdAt: 1,
        items: [
          { packageId: 'one', url: input.packageUrls.one, state: 'installing', detail: '', bytesSent: item.size, requestId: id, serviceDispatchedAt: 1 },
          { packageId: 'two', url: input.packageUrls.one, state: 'pending', detail: 'Ожидает очереди', bytesSent: 0 },
        ] }))
      const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
      await until(() => calls.submit === 1)
      assert.equal(readQueue().items[0].state, 'failed')
      assert.match(readQueue().items[0].detail, /0x80990077/i)
      currentJob.state = 'installed'
      await until(() => readQueue().status === 'completed')
      assert.equal(readQueue().items[1].state, 'installed')
      assert.match(readQueue().message, /с ошибкой — 1/)
      assert.equal(calls.submit, 1)
    } else if (mode === 'restart') {
      writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
      const id = '11111111-1111-1111-1111-111111111111'; currentJob = { ...makeJob(id), state: 'installed' }
      writeFileSync(queueFile, JSON.stringify({ version: 1, transport: 'service', id: 'restored', status: 'running', psIp: ip, createdAt: 1,
        items: [{ packageId: 'one', url: input.packageUrls.one, state: 'sending', detail: '', bytesSent: 0, requestId: id, serviceDispatchedAt: 1 }] }))
      const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
      await until(() => readQueue().status === 'completed')
      assert.equal(calls.submit, 0); assert.equal(calls.pair, 0); assert.equal(calls.payload, 0); assert(installed())
    } else {
      const result = await client.saveServiceKey(ip)
      if (mode === 'icon') {
        const queue = await load('installation-queue')
        const fixedId = '11111111-1111-1111-1111-111111111111'
        writeFileSync(queueFile, JSON.stringify({ version: 1, transport: 'service', id: 'icon', status: 'running', psIp: ip, createdAt: 1,
          items: [{ packageId: 'one', url: input.packageUrls.one, state: 'pending', detail: '', bytesSent: 0, requestId: fixedId }] }))
        queue.ensureInstallationQueueRunning()
        await until(() => calls.icon === 1 && calls.submit === 1)
        currentJob.state = 'installed'
        await until(() => readQueue().status === 'completed')
        assert.equal(calls.payload, 0)
      } else {
      assert.equal(result.configured, true); assert.equal(JSON.stringify(result).includes(token), false)
      assert(client.serviceKeyConfigured(ip)); assert.equal(calls.pair, 1)
      const queue = await load('installation-queue'); queue.startInstallationQueue({ ...input, transport: 'service' })
      await until(() => readQueue().items[0].state === 'receiving')
      assert.equal(readQueue().items[0].bytesSent, 5368709120); assert.equal(calls.submit, 1); assert.equal(calls.payload, 0)
      currentJob.downloadedBytes = currentJob.totalBytes
      await delay(1600); assert.equal(readQueue().status, 'running'); assert.equal(installed(), undefined)
      if (mode === 'interruption') {
        offline = true; await until(() => readQueue().items[0].state === 'verifying')
        assert.equal(calls.submit, 1); assert.equal(installed(), undefined)
        offline = false; currentJob.state = 'installed'
        await until(() => readQueue().status === 'completed'); assert(installed())
      } else if (mode === 'cancel') {
        queue.cancelInstallationQueue(); await until(() => readQueue().status === 'cancelled'); assert.equal(calls.cancel, 1); assert.equal(installed(), undefined)
      } else if (mode === 'cancel-removed') {
        currentJob.state = 'cancelling'; currentJob.error = -2137456615; currentJob.errorHex = '0x80990019'; currentJob.pollError = -2137456615
        queue.cancelInstallationQueue(); await until(() => readQueue().status === 'cancelled')
        assert.equal(readQueue().items[0].state, 'unconfirmed'); assert.equal(calls.cancel, 0); assert.equal(installed(), undefined)
      } else if (mode === 'cancel-stuck') {
        currentJob.state = 'cancelling'; currentJob.error = -5; currentJob.errorHex = '0xFFFFFFFB'
        const cancelled = queue.cancelInstallationQueue(); assert.equal(cancelled.status, 'cancelling')
        await until(() => calls.cancel >= 1)
        assert.throws(() => queue.resolveCancelledQueue('wrong'), /изменилась/)
        queue.resolveCancelledQueue(cancelled.id)
        assert.equal(readQueue().status, 'cancelled'); assert.equal(readQueue().items[0].state, 'unconfirmed')
        assert.equal(installed(), undefined); await delay(1550); assert.equal(readQueue().status, 'cancelled')
      } else {
        currentJob.state = 'installed'; await until(() => readQueue().status === 'completed'); assert(installed())
      }
      await client.getServiceInstallerStatus(ip); assert.equal(calls.pair, 1)
      assert.equal(calls.submit, 1); assert.equal(calls.payload, 0)
      }
    }
  }
  console.log(`PASS: ${mode}`)
} finally { rmSync(directory, { recursive: true, force: true }) }

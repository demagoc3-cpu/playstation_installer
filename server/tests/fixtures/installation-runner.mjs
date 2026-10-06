// Runs the production queue/client in a temporary cwd. Only the two external
// devices are simulated: payload commands and console HTTP replies.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
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
const token = 'abcdef0123456789abcdef0123456789'
const input = { psIp: ip, packageIds: ['one'], packageUrls: { one: 'http://192.168.88.10:3000/json/one.json' } }
const calls = { payload: 0, commands: 0, service: 0, submit: 0, pair: 0, cancel: 0, icon: 0 }
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
      export async function startInstaller() { globalThis.queueTestCalls.payload++; }
      export async function sendPackage() { globalThis.queueTestCalls.commands++; if (globalThis.queueTestPayloadRace && globalThis.queueTestCalls.commands === 1) await new Promise(resolve => { globalThis.finishPayloadSend = resolve; }); }
    ` }
    return next(url, context)
  },
})
let currentJob, offline = false
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const cap = { service: 'PackegeFlowService', version: '0.4.0', installApi: 1, ready: true, authentication: 'bearer', contentTypes: ['PS4GD'], error: 0, errorHex: '0x00000000' }
if (mode === 'mini-app') cap.contentTypes.push('PS4GDE')
const makeJob = id => ({ service: 'PackegeFlowService', jobId: id, requestId: id, contentId: item.contentId, taskId: 43, state: 'downloading',
  totalBytes: item.size, downloadedBytes: 5368709120, downloadTotalBytes: item.size, error: 0, errorHex: '0x00000000', pollError: 0 })
globalThis.fetch = async (url, options) => {
  calls.service++
  const path = new URL(url).pathname
  if (path === '/system/info' && globalThis.cancelBeforeDispatch) { const cancel = globalThis.cancelBeforeDispatch;globalThis.cancelBeforeDispatch=undefined;await delay(0);cancel() }
  if (path === '/system/info') return response({ service: cap.service, firmware: { version: '12.50' } })
  if (path === '/storage') return response({ service: cap.service, volumes: [{ id: 'internal', path: '/user', available: true,
    availableBytes: mode === 'space' ? 1024 : 20 * 1024 ** 3 }] })
  if (path === '/install/pair') { calls.pair++; assert.deepEqual(JSON.parse(options.body), { code: 'F7Y-YUH' }); return response({ service: cap.service, paired: true, token }) }
  if (path === '/install/capabilities') return response(cap)
  assert.equal(options.headers.Authorization, `Bearer ${token}`)
  if (path === '/install/session') return response(cap)
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
    calls.submit++
    if (mode === 'already-installed' && calls.submit === 1) return response({ error: 'component_already_installed', errorHex: '0x00000000' }, 409)
    if (mode === 'busy-rejection') return response({ error: 'another_service_job_active', errorHex: '0x00000000' }, 409)
    assert.equal(calls.submit, mode === 'already-installed' ? 2 : 1, 'accepted task must never be POSTed twice')
    if (mode === 'icon') assert.equal(calls.icon, 1, 'BGFT icon must be on the console before task registration')
    const body = JSON.parse(options.body); assert.equal(body.size, item.size); assert.equal(body.contentType, mode === 'already-installed' ? 'PS4AC' : mode.startsWith('mini-app') ? 'PS4GDE' : mode.startsWith('cancel-one') || mode === 'task-cancel-service' || mode === 'cancel-game' ? 'PS4GP' : 'PS4GD')
    currentJob = makeJob(body.requestId)
    currentJob.contentId = body.contentId
    throw new Error('Connection lost after PS4 accepted the task')
  }
  assert(currentJob && path.startsWith(`/install/jobs/${currentJob.jobId}`))
  if (offline && !path.endsWith('/cancel')) throw new Error('Temporary connection loss')
  if (path.endsWith('/cancel')) { calls.cancel++; if (mode !== 'cancel-stuck') currentJob.state = 'cancelled' }
  return response(currentJob)
}
const load = name => import(name === 'installation-queue' && process.env.PACKAGEFLOW_QUEUE_TEST_BUNDLE
  ? pathToFileURL(process.env.PACKAGEFLOW_QUEUE_TEST_BUNDLE).href
  : name === 'ps4-service-installer' && process.env.PACKAGEFLOW_SERVICE_CLIENT_TEST_BUNDLE
    ? pathToFileURL(process.env.PACKAGEFLOW_SERVICE_CLIENT_TEST_BUNDLE).href
    : pathToFileURL(resolve(root, `server/utils/${name}.ts`)).href)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const readQueue = () => JSON.parse(readFileSync('.data/installation-queue.json', 'utf8'))
const installed = () => JSON.parse(readFileSync('.data/package-library.json', 'utf8')).packages[0].installedAt
async function until(check) {
  const deadline = Date.now() + 8000
  while (!check()) { assert(Date.now() < deadline, `timed out in ${mode}`); await delay(30) }
}
try {
  if (mode === 'preference') {
    const preference = await load('installation-preference')
    assert.equal(preference.getInstallationPreference(), 'service')
    assert.equal(preference.setInstallationPreference('payload'), 'payload')
    assert.equal(preference.getInstallationPreference(), 'payload')
    assert.throws(() => preference.setInstallationPreference('auto'))
    assert.equal(preference.getInstallationPreference(), 'payload')
  } else if (mode === 'legacy') {
    writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, status: 'running', psIp: ip, createdAt: 1,
      items: [{ packageId: 'one', url: input.packageUrls.one, state: 'waiting', detail: '', bytesSent: 0, dispatchedAt: Date.now() - 25000 }] }))
    const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
    await until(() => readQueue().status === 'completed')
    assert.equal(readQueue().transport, 'payload'); assert.equal(readQueue().items[0].state, 'unconfirmed')
    assert.equal(installed(), undefined); assert.equal(calls.service, 0); assert.equal(calls.commands, 0)
  } else if (mode === 'payload') {
    const queue = await load('installation-queue')
    assert.throws(() => queue.startInstallationQueue({ ...input, transport: 'auto' }))
    assert.throws(() => queue.startInstallationQueue(input), /сопряжения/)
    const preference = await load('installation-preference')
    preference.setInstallationPreference('payload')
    const result = queue.startInstallationQueue(input); assert.equal(result.transport, 'payload')
    await until(() => calls.commands === 1)
    assert.equal(calls.service, 0); assert.equal(calls.payload, 1)
    queue.cancelInstallationQueue(); assert.equal(readQueue().status, 'cancelled')
    await delay(1550); assert.equal(calls.commands, 1)
  } else if (mode === 'task-remove-pending') {
    writeFileSync('.data/package-library.json', JSON.stringify({version:2,packages:[item,{...item,id:'two',title:'Queued DLC'}],deliveries:{}}))
    writeFileSync('.data/installation-queue.json', JSON.stringify({version:1,transport:'payload',id:'tasks-test',status:'running',psIp:ip,createdAt:1,
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
    writeFileSync('.data/installation-queue.json',JSON.stringify(failedQueue))
    const tasks=await load('installation-tasks')
    assert(tasks.getInstallationTasks({categories:'queued'}).items[0].canCancel,'pending rows remain removable after a queue error')
    queue.cancelInstallationItem('tasks-test','two',ip)
    assert.equal(readQueue().status,'failed');assert.equal(readQueue().items[1].state,'cancelled');assert.equal(calls.commands,0)
  } else if (mode === 'task-cancel-payload-race') {
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
    writeFileSync('.data/installation-queue.json',JSON.stringify(current))
    writeFileSync('.data/installation-history.json',JSON.stringify([{...current,id:'old',status:'completed',items:[{packageId:'old',state:'delivered',detail:'done',bytesSent:100}]}]))
    const tasks=await load('installation-tasks'), visibility=await load('task-visibility')
    const result=visibility.clearFinishedTasks([{hash:'a'.repeat(40),state:'uploading',progress:1},{hash:'b'.repeat(40),state:'downloading',progress:0.5}])
    assert.equal(result.cleared,3);assert.equal(Object.keys(result.hiddenTorrents).length,1)
    const after=tasks.getInstallationTasks();assert.deepEqual(after.counts,{active:1,queued:1,completed:0,failed:0});assert.equal(readQueue().items.length,4);assert.equal(readQueue().items[2].state,'installed');assert.equal(calls.commands,0)
    assert.equal(visibility.clearFinishedTasks().cleared,0)
    const next=readQueue();next.items[1].state='installed';writeFileSync('.data/installation-queue.json',JSON.stringify(next));assert.equal(tasks.getInstallationTasks().counts.completed,1,'future completions remain visible')
    assert.equal(readFileSync('.data/task-visibility.json','utf8').includes('clear-current:three'),true,'cleanup persists across restart')
  } else if (mode === 'task-history') {
    const previous={version:1,transport:'payload',id:'previous',status:'completed',psIp:ip,createdAt:1,
      items:Array.from({length:70},(_,index)=>({packageId:`old-${index}`,title:`Previous ${index}`,titleId:'CUSA00001',fileName:`Old-${index}.pkg`,size:1024,type:'DLC',state:index===0?'failed':'delivered',detail:'Previous detail',bytesSent:1024}))}
    writeFileSync('.data/installation-queue.json',JSON.stringify(previous))
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
    writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, transport: 'payload', id: 'active', status: 'running', psIp: ip, createdAt: 1,
      items: [{ packageId: 'one', url: input.packageUrls.one, state: 'waiting', detail: 'PS4 скачивает пакет', bytesSent: 1234, dispatchedAt: Date.now() }] }))
    const queue = await load('installation-queue')
    const result = queue.appendInstallationQueue({ psIp: ip, queueId: 'active', packageIds: ['two'], packageUrls: { two: 'http://192.168.88.10:3000/json/two.json' } })
    assert.equal(result.items.length, 2)
    assert.equal(result.items[0].state, 'waiting'); assert.equal(result.items[0].bytesSent, 1234)
    assert.equal(result.items[1].state, 'pending')
    assert.throws(() => queue.appendInstallationQueue({ psIp: ip, queueId: 'active', packageIds: ['two'], packageUrls: {} }), /уже находятся/)
    assert.throws(() => queue.appendInstallationQueue({ psIp: ip, queueId: 'old', packageIds: ['two'], packageUrls: {} }), /изменилась/)
    queue.cancelInstallationQueue()
  } else if (mode === 'cancel-game') {
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({[ip]:token}))
    const packages = [item, {...item,id:'patch',contentType:'PS4GP',installOrder:1},
      {...item,id:'other',titleId:'CUSA00002',contentId:'EP0000-CUSA00002_00-ABCDEFGHIJKLMNOP',contentType:'PS4GP'},
      {...item,id:'done',contentType:'PS4AC',installOrder:2}]
    writeFileSync('.data/package-library.json', JSON.stringify({version:2,packages,deliveries:{}}))
    const id='11111111-1111-1111-1111-111111111111';currentJob=makeJob(id)
    writeFileSync('.data/installation-queue.json', JSON.stringify({version:1,transport:'service',id:'game-test',status:'running',psIp:ip,createdAt:1,
      items:[{packageId:'one',url:input.packageUrls.one,state:'receiving',detail:'',bytesSent:10,requestId:id,serviceDispatchedAt:1},
        {packageId:'patch',url:input.packageUrls.one,state:'pending',detail:'',bytesSent:0},
        {packageId:'other',url:input.packageUrls.one,state:'pending',detail:'',bytesSent:0},
        {packageId:'done',url:input.packageUrls.one,state:'installed',detail:'',bytesSent:0}]}))
    const queue = await load('installation-queue')
    assert.throws(()=>queue.cancelGameInstallation('old',ip,'CUSA00001'))
    assert.throws(()=>queue.cancelGameInstallation('game-test','192.168.88.148','CUSA00001'))
    assert.throws(()=>queue.cancelGameInstallation('game-test',ip,'CUSA00003'))
    const result=queue.cancelGameInstallation('game-test',ip,'CUSA00001')
    assert.equal(result.items[0].cancelRequested,true);assert.equal(result.items[1].cancelRequested,true)
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
      writeFileSync('.data/installation-queue.json',JSON.stringify({version:1,transport:'service',id:'current-test',status:'running',psIp:ip,createdAt:1,
        items:[{packageId:'one',url:input.packageUrls.one,state:'receiving',detail:'',bytesSent:10,requestId:id,serviceDispatchedAt:1},
          {packageId:'two',url:input.packageUrls.one,state:'pending',detail:'',bytesSent:0}]}))
      assert.throws(()=>queue.cancelCurrentInstallation('old','one',ip))
      assert.throws(()=>queue.cancelCurrentInstallation('current-test','two',ip))
      if (mode === 'task-cancel-service') queue.cancelInstallationItem('current-test','one',ip)
      else queue.cancelCurrentInstallation('current-test','one',ip)
    } else {
      globalThis.cancelBeforeDispatch=()=>queue.cancelCurrentInstallation(readQueue().id,'one',ip)
      queue.startInstallationQueue({...input,transport:'service',packageIds:['one','two'],packageUrls:{...input.packageUrls,two:input.packageUrls.one}})
    }
    await until(()=>calls.submit===1&&currentJob&&readQueue().items[1].serviceDispatchedAt)
    assert.equal(readQueue().items[0].state,'cancelled');assert.equal(calls.cancel,mode==='cancel-one'||mode==='task-cancel-service'?1:0)
    assert.throws(()=>queue.cancelCurrentInstallation(readQueue().id,'one',ip))
    currentJob.state='installed';await until(()=>readQueue().status==='completed')
    assert.equal(readQueue().items[1].state,'installed');assert.equal(calls.submit,1);assert.match(readQueue().message,/с ошибкой — 0, отменено — 1/)
  } else if (mode === 'space') {
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
    const queue = await load('installation-queue')
    queue.startInstallationQueue({ ...input, transport: 'service' })
    await until(() => readQueue().status === 'failed')
    assert.match(readQueue().items[0].detail, /Недостаточно места/)
    assert.equal(calls.submit, 0)
  } else if (mode === 'firmware') {
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
    writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [{ ...item, requiredFirmware: undefined, sdkFirmware: undefined }], deliveries: {} }))
    writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
    const queue = await load('installation-queue')
    queue.startInstallationQueue({ ...input, transport: 'service' })
    await until(() => readQueue().status === 'completed')
    assert.equal(readQueue().items[0].state, 'skipped')
    assert.equal(calls.submit, 0)
  } else {
    const client = await load('ps4-service-installer')
    if (mode === 'already-installed' || mode === 'busy-rejection') {
      writeFileSync('.data/ps4-service-keys.json', JSON.stringify({ [ip]: token }))
      writeFileSync('.data/package-library.json', JSON.stringify({ version: 2, packages: [{ ...item, contentType: 'PS4AC' }, { ...item, id: 'two', title: 'Next Package', contentType: 'PS4AC' }], deliveries: {} }))
      const queue = await load('installation-queue')
      queue.startInstallationQueue({ ...input, packageIds: ['one', 'two'], packageUrls: { ...input.packageUrls, two: input.packageUrls.one }, transport: 'service' })
      if (mode === 'busy-rejection') {
        await until(() => readQueue().status === 'failed')
        assert.equal(readQueue().items[0].state, 'failed')
        assert.equal(readQueue().items[1].state, 'pending')
        assert.equal(calls.submit, 1)
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
      writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, transport: 'service', id: 'recovered', status: 'running', psIp: ip, createdAt: 1,
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
      writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, transport: 'service', id: 'recovered', status: 'running', psIp: ip, createdAt: 1,
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
      writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, transport: 'service', id: 'restored', status: 'running', psIp: ip, createdAt: 1,
        items: [{ packageId: 'one', url: input.packageUrls.one, state: 'sending', detail: '', bytesSent: 0, requestId: id, serviceDispatchedAt: 1 }] }))
      const queue = await load('installation-queue'); queue.ensureInstallationQueueRunning()
      await until(() => readQueue().status === 'completed')
      assert.equal(calls.submit, 0); assert.equal(calls.pair, 0); assert.equal(calls.payload, 0); assert(installed())
    } else {
      await assert.rejects(client.saveServiceKey(ip, 'invalid')); assert.equal(calls.service, 0)
      const result = await client.saveServiceKey(ip, 'f7y-yuh')
      if (mode === 'icon') {
        const queue = await load('installation-queue')
        const fixedId = '11111111-1111-1111-1111-111111111111'
        writeFileSync('.data/installation-queue.json', JSON.stringify({ version: 1, transport: 'service', id: 'icon', status: 'running', psIp: ip, createdAt: 1,
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

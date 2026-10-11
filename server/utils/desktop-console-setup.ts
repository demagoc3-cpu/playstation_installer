import { randomBytes } from 'node:crypto'
import { createConnection } from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { createError } from 'h3'
import { dataPath } from './data-path'
import { writeDurableJson } from './durable-json'
import { getConsoleProfile, probeConsoleProfile, ps5ServiceRequest } from './console-profiles'
import { consoleSetupBundle } from './console-setup-artifacts'
import { bootstrapHealth, bootstrapReceipt, runPs5Bootstrap, type BootstrapFlow } from './ps5-bootstrap-driver'
import { getPs5Queue, getPs5SetupAttempt, startPs5Queue } from './ps5-installation-queue'
import { checkPs5InstalledPackage } from './installed-package-check'
import { desktopAppRetryState } from './desktop-app-retry'
import { registerPs5ImageFile, getPackage } from './package-library'
import { claimConsoleWorker } from './console-worker-lock'
import { trackDesktopRequest } from './desktop-lifecycle'
import { assertNoPs5ServiceUpdate } from './ps5-service-updates'

const running = new Set<string>()
const flowPath = (id: string) => dataPath('console-setup', `bootstrap-${id}.json`)
function target(id: unknown) { const p = getConsoleProfile(id); if (p.platform !== 'ps5') throw createError({statusCode:400,message:'Для этого шага выберите PS5'}); return p }
function flow(id: string): BootstrapFlow | null {
  if (!existsSync(flowPath(id))) return null
  try {
    const f = JSON.parse(readFileSync(flowPath(id),'utf8'))
    if (f.consoleId !== id || !/^[a-f0-9]{32}$/.test(f.id) || !['checking','sending','verifying','completed','failed','unconfirmed'].includes(f.state) || !/^[a-f0-9]{64}$/.test(f.sha256) || typeof f.ip !== 'string' || !Number.isSafeInteger(f.startedAt)) throw new Error()
    return f
  } catch { throw createError({statusCode:503,message:'Не удалось прочитать результат отправки ELF. Повтор заблокирован'}) }
}
async function health(ip: string) {
  try { return await ps5ServiceRequest(ip,'/health') }
  catch (error: any) {
    // A timeout or malformed reply is uncertain, not proof that no service exists.
    if (error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') return null
    throw error
  }
}
function servicePortConnects(ip: string): Promise<boolean> {
  return new Promise((resolve,reject)=>{
    const socket=createConnection({host:ip,port:8095})
    const finish=(value:boolean)=>{socket.destroy();resolve(value)}
    socket.setTimeout(1500,()=>finish(false))
    socket.once('connect',()=>finish(true))
    socket.once('error',(error:any)=>{socket.destroy();if(['ECONNREFUSED','ETIMEDOUT'].includes(error.code))resolve(false);else reject(error)})
  })
}
function connect(ip: string) {
  return new Promise<{send(bytes: Uint8Array): Promise<void>;close(): void}>((done,fail) => {
    const s = createConnection({host:ip,port:9021})
    s.setTimeout(4000,()=>s.destroy(new Error('Загрузчик PS5 не ответил на порту 9021')))
    s.once('error',fail)
    s.once('connect',()=> { s.setTimeout(15000,()=>s.destroy(new Error('Таймаут передачи ELF'))); done({close:()=>s.destroy(),send:bytes=>new Promise((resolve,reject)=>{s.once('error',reject);s.end(bytes,()=>{s.off('error',reject);resolve()})})}) })
  })
}
function idle(id: string) {
  assertNoPs5ServiceUpdate(id)
  const q = getPs5Queue(id)
  return !['running','cancelling'].includes(q.status) && q.items.every(i=>['installed','failed','skipped','cancelled'].includes(i.state))
}
export async function desktopConsoleSetupInfo(id: unknown) {
  const p = target(id), previous = flow(p.id)
  if (previous && previous.ip === p.ip && !running.has(p.id) && ['sending','verifying','unconfirmed'].includes(previous.state)) {
    try { const r = await health(p.ip); if (r && bootstrapReceipt(previous,r)) { previous.state='completed';previous.message='Запуск ELF подтверждён';writeDurableJson(flowPath(p.id),previous) } } catch { /* GET is reconciliation only. */ }
  }
  let release: any = null, artifactMessage = 'Комплект PS5 пока не включён в эту сборку Windows'
  try { const b = await consoleSetupBundle({verifyFiles:false}); release = b.manifest; artifactMessage='Проверенный ELF и приложение PackageFlow готовы' } catch(e) { if ((e as any)?.code !== 'ENOENT') artifactMessage=e instanceof Error?e.message:artifactMessage }
  const profiles = await probeConsoleProfile(p.id), profile = profiles.consoles.find(v=>v.id===p.id)!
  let loader: boolean | null = null, installReady = false, shadowMount: boolean | null = null
  if (!profile.online) { try { const c = await connect(p.ip);c.close();loader=true } catch { loader=false } }
  if (profile.online && profile.paired) {
    try { const r = await ps5ServiceRequest(p.ip,'/api/v1/install/readiness');if(r.status===200&&r.body?.service==='PackageFlowService-PS5'){installReady=profile.capabilities.formats.includes(release?.app?.format);shadowMount=r.body?.images?.backend==='ShadowMountPlus-1.7beta3'&&r.body.images.ready===true ? true : null} } catch { /* Unknown stays unknown. */ }
  }
  const q = getPs5Queue(p.id)
  return {consoleId:p.id,profile,release,artifactMessage,flow:previous,loader,webKit:null,kstuff:null,shadowMount,installReady,queue:q}
}
export async function beginDesktopPs5Bootstrap(id: unknown, firmware: unknown, confirmedServiceStopped: unknown = false) {
  const p = target(id), b = await consoleSetupBundle().catch(e=>{throw createError({statusCode:409,message:e?.code==='ENOENT'?'В установщике нет проверенного комплекта PS5':e.message})}), previous = flow(p.id)
  assertNoPs5ServiceUpdate(p.id)
  if (firmware !== b.manifest.elf.firmware) throw createError({statusCode:409,message:'Перед первым запуском проверьте прошивку в настройках PS5. Этот ELF рассчитан только на 13.60'})
  if (running.has(p.id) || previous && !['failed','completed'].includes(previous.state)) return desktopConsoleSetupInfo(p.id)
  const lock = claimConsoleWorker('bootstrap',p.ip)
  if (!lock) throw createError({statusCode:409,message:'Другой мастер уже запускает ELF на этой приставке'})
  const f: BootstrapFlow = {id:randomBytes(16).toString('hex'),consoleId:p.id,ip:p.ip,version:b.manifest.elf.version,buildId:b.manifest.elf.buildId,sha256:b.manifest.elf.sha256,firmware:b.manifest.elf.firmware,startedAt:Date.now(),state:'checking',message:'Проверяем PS5 перед первым запуском ELF'}
  try { writeDurableJson(flowPath(p.id),f) } catch(e) {lock();throw e}
  running.add(p.id);const done=trackDesktopRequest()
  void runPs5Bootstrap(f,b.elf,{idle:()=>idle(p.id),health:()=>bootstrapHealth(()=>ps5ServiceRequest(p.ip,'/health'),()=>servicePortConnects(p.ip),confirmedServiceStopped===true),connect:()=>connect(p.ip),save:v=>writeDurableJson(flowPath(p.id),v),pause:()=>new Promise(resolve=>setTimeout(resolve,1000))})
    .finally(()=>{running.delete(p.id);lock();done()})
    .catch(()=>{console.error('PS5 bootstrap stopped: its durable journal could not be updated; automatic retry remains blocked')})
  return {consoleId:p.id,flow:f}
}
export async function installDesktopPs5App(id: unknown, requestId: unknown) {
  const p = target(id)
  if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId)) throw createError({statusCode:400,message:'Неверный номер установки приложения'})
  const receiptPath=dataPath('console-setup',`app-${p.id}-${requestId}.json`)
  if (existsSync(receiptPath)) {
    const receipt=JSON.parse(readFileSync(receiptPath,'utf8'))
    if(receipt.consoleId!==p.id||receipt.ip!==p.ip)throw createError({statusCode:409,message:'Профиль приставки изменился'})
    const retry = await desktopAppRetryState(getPs5SetupAttempt(p.id, receipt.queueId, receipt.packageId), () => {
      const source = getPackage(receipt.packageId)
      return checkPs5InstalledPackage(p.id, p.ip, source, AbortSignal.timeout(15000))
    })
    return {consoleId:p.id,receipt,queue:getPs5Queue(p.id),retry}
  }
  assertNoPs5ServiceUpdate(p.id)
  const b = await consoleSetupBundle(), snapshot=(await probeConsoleProfile(p.id)).consoles.find(x=>x.id===p.id)!
  if (!snapshot.online || !snapshot.paired || snapshot.firmware!==b.manifest.elf.firmware || !snapshot.capabilities.formats.includes(b.manifest.app.format)) throw createError({statusCode:409,message:'Сопрягите PS5 и запустите ShadowMount+. Установка этого формата должна быть подтверждена службой'})
  if (flow(p.id) && !['completed','failed'].includes(flow(p.id)!.state) || !idle(p.id)) throw createError({statusCode:409,message:'Дождитесь подтверждения ELF и завершения текущих заданий'})
  const lock=claimConsoleWorker('bootstrap',p.ip)
  if(!lock)throw createError({statusCode:409,message:'Другой мастер уже выполняет установку'})
  try {
    // Check again after taking the lock: concurrent clicks must share the receipt.
    if(existsSync(receiptPath))return {consoleId:p.id,receipt:JSON.parse(readFileSync(receiptPath,'utf8')),queue:getPs5Queue(p.id)}
    const item=await registerPs5ImageFile(b.appPath), source=getPackage(item.id)
    if(source.titleId!==b.manifest.app.titleId||source.contentId!==b.manifest.app.contentId||source.appVersion!==b.manifest.app.version)throw new Error('Приложение изменилось при подготовке')
    const receipt={consoleId:p.id,ip:p.ip,requestId,packageId:item.id,sha256:b.manifest.app.sha256,queueId:randomBytes(16).toString('hex'),state:'prepared',startedAt:Date.now()}
    writeDurableJson(receiptPath,receipt)
    try { const queue=await startPs5Queue({consoleId:p.id,packageIds:[item.id],newQueueId:receipt.queueId});receipt.state='queued';writeDurableJson(receiptPath,receipt);return {consoleId:p.id,receipt,queue} }
    catch(e){receipt.state='unconfirmed';writeDurableJson(receiptPath,receipt);throw e}
  } finally {lock()}
}

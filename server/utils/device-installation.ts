import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createError } from 'h3'
import { getConsoleProfile, getConsoleProfiles, refreshConsoleProfile, refreshConsoleProfiles } from './console-profiles'
import { getPackage, getLibraryPackages, installedPackageIdsForConsole } from './package-library'
import { presetSelection } from './presets'
import { filterContent, contentBranchKey } from '../../shared/content-platform'
import { deviceInstallReason } from '../../shared/device-eligibility'
import type { DeviceSelection, DeviceInstallPreview, DeviceActivity } from '../../shared/types/consoles'
import { getInstallationQueue, getInstallationHistory, appendInstallationQueue, startInstallationQueue } from './installation-queue'
import { getPs5Queue, getPs5TaskCounts, startPs5Queue } from './ps5-installation-queue'
import { latestInstallationAttempts } from '../../shared/latest-installation-attempts'
import { getTaskVisibility, taskVisibilityKey } from './task-visibility'
import { installationTaskCategory } from '../../shared/types/tasks'
import { getLocalIp } from './ps4-installer'
import { dataPath } from './data-path'
import { writeDurableJson } from './durable-json'
import { requiredInstallSpace } from './installation-space'

export function resolveDeviceSelection(selection: DeviceSelection): string[] {
  if (!selection || typeof selection !== 'object' || [selection.packageIds, selection.librarySelection, selection.preset].filter(value => value !== undefined).length !== 1)
    throw createError({ statusCode: 400, message: 'Выберите один набор файлов' })
  let ids: string[]
  if (selection.preset) ids = presetSelection(selection.preset.id, selection.preset.keys).map(item => item.id)
  else if (selection.librarySelection) {
    const s = selection.librarySelection
    if (!['all','dlc'].includes(s.scope) || s.platform !== undefined && !['all','ps4','ps5'].includes(s.platform) || s.titleId !== undefined && (typeof s.titleId !== 'string' || !s.titleId)) throw createError({ statusCode: 400, message: 'Неверный выбор библиотеки' })
    ids = filterContent(getLibraryPackages(), s.platform).filter(item => (s.scope !== 'dlc' || item.type === 'DLC') && (!s.titleId || item.titleId === s.titleId)).map(item => item.id)
  } else ids = selection.packageIds!
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id))) throw createError({ statusCode: 400, message: 'Выберите файлы для установки (не более 10000)' })
  // Resolve aliases once so duplicate source files cannot be sent twice.
  const library = getLibraryPackages()
  const aliases=new Map(library.flatMap(item=>[item.id,...(item.sourceIds || [])].map(id=>[id,item.id] as const)))
  return [...new Set(ids.map(id => {
    const canonical=aliases.get(id)
    if(!canonical) throw createError({statusCode:404,message:'Файл больше не доступен в библиотеке. Обновите выбор'})
    return canonical
  }))]
}
export function deviceQueue(id: string) {
  const profile = getConsoleProfile(id)
  return profile.platform === 'ps5' ? getPs5Queue(id) : getInstallationQueue(profile.ip)
}
export function deviceActivities(packageIds: string[] = []): DeviceActivity[] {
  const visible = new Set(packageIds)
  const hidden=new Set(getTaskVisibility().hidden)
  return getConsoleProfiles().consoles.map(profile => {
    try {
      const queue = deviceQueue(profile.id)
      const counts = profile.platform === 'ps5' ? getPs5TaskCounts(profile.id) : {active:0,queued:0,completed:0,failed:0}
      if(profile.platform==='ps4') {
        const attempts = [queue,...getInstallationHistory(profile.ip).filter(record=>record.id!==queue.id)].flatMap(record => record.items
          .filter(item => !hidden.has(taskVisibilityKey(record.id,item)) || !['completed','failed'].includes(installationTaskCategory(item.state)))
          .map(item => ({ ...item, psIp:profile.ip, createdAt:record.createdAt || 0 })))
        for (const item of latestInstallationAttempts(attempts)) counts[installationTaskCategory(item.state)]++
      }
      const running = ['running','cancelling'].includes(queue.status)
      return { consoleId:profile.id, status:queue.status, queueId:queue.id, message:queue.message, counts,
        activePackageIds:running ? queue.items.filter(item => ['sending','waiting','receiving','installing','verifying','unconfirmed'].includes(item.state)).map(item => item.packageId) : [],
        queuedPackageIds:running ? queue.items.filter(item => item.state === 'pending' && visible.has(item.packageId)).map(item => item.packageId) : [],
        installedPackageIds:visible.size ? installedPackageIdsForConsole(profile.ip,packageIds) : [] }
    } catch { return { consoleId:profile.id, status:'unavailable', message:'Не удалось прочитать задания устройства', counts:{ active:0,queued:0,completed:0,failed:0 }, activePackageIds:[],queuedPackageIds:[],installedPackageIds:[] } }
  })
}
export async function previewDeviceInstall(selection: DeviceSelection, destinations?: string[]): Promise<DeviceInstallPreview> {
  const ids = resolveDeviceSelection(selection), items = ids.map(id => getPackage(id))
  if (destinations) for (let offset=0;offset<destinations.length;offset+=8) await Promise.all(destinations.slice(offset,offset+8).map(id => refreshConsoleProfile(id, true)))
  else await refreshConsoleProfiles()
  const size = items.reduce((sum,item) => sum + item.size, 0)
  return { selection:{ packageIds:ids }, files:ids.length, size, devices:getConsoleProfiles().consoles.map(profile => {
    if (destinations && !destinations.includes(profile.id)) return null
    const queue = deviceQueue(profile.id), running = ['running','cancelling'].includes(queue.status)
    const existing = new Set(running ? queue.items.filter(item => item.state !== 'cancelled').map(item => item.packageId) : [])
    const additional = items.filter(item => !existing.has(item.id)).reduce((sum,item) => sum + item.size, 0)
    const pendingBytes = running ? queue.items.filter(item => ['pending','sending','waiting','receiving','installing','verifying','unconfirmed'].includes(item.state)).reduce((sum,item) => sum + (item.size || 0), 0) : 0
    // Conservative estimate: a staged PS5 PKG also needs room for its installed content.
    const sourceBytes=additional+pendingBytes
    const requiredBytes = sourceBytes ? profile.platform === 'ps5' ? sourceBytes*2 : requiredInstallSpace(sourceBytes) : 0
    const payloadBusy = profile.transport === 'payload' && getConsoleProfiles().consoles.some(other => other.id !== profile.id && other.platform === 'ps4' && getInstallationQueue(other.ip).transport === 'payload' && ['running','cancelling'].includes(getInstallationQueue(other.ip).status))
    const multiplePayload = profile.transport === 'payload' && !!destinations && getConsoleProfiles().consoles.filter(other => destinations.includes(other.id) && other.transport === 'payload').length > 1
    const reason = deviceInstallReason(profile,items,requiredBytes) || (payloadBusy || multiplePayload ? 'Для параллельной установки используйте PackageFlowService. PyLoader обслуживает одну приставку' : '') || (queue.status === 'cancelling' ? 'Дождитесь завершения отмены очереди' : '') ||
      (running && profile.platform === 'ps4' && queue.transport !== (profile.transport || 'service') ? 'Очередь использует другой способ установки' : '')
    return { profile, eligible:!reason, reason, pending:running ? queue.items.filter(item => item.state === 'pending').length : 0, requiredBytes }
  }).filter((item): item is NonNullable<typeof item> => item !== null) }
}

export async function dispatchDeviceInstall(id: string, packageIds: string[], host: string) {
  const profile = getConsoleProfile(id), queue = deviceQueue(id), running = queue.status === 'running'
  const seen = new Set(running ? queue.items.filter(item => item.state !== 'cancelled').map(item => item.packageId) : [])
  const ids = packageIds.filter(id => !seen.has(id)).map(id=>getPackage(id)).sort((a,b)=>contentBranchKey(a).localeCompare(contentBranchKey(b)) || a.installOrder-b.installOrder || (a.appVersion || '').localeCompare(b.appVersion || '',undefined,{numeric:true}) || a.fileName.localeCompare(b.fileName,undefined,{numeric:true})).map(item=>item.id)
  if (!ids.length) return queue
  if (profile.platform === 'ps5') return startPs5Queue({ consoleId:id, packageIds:ids, queueId:running ? queue.id : undefined })
  const pcIp = await getLocalIp(profile.ip), port = host.match(/:(\d+)$/)?.[1] || '3000'
  const input = { psIp:profile.ip, packageIds:ids, packageUrls:Object.fromEntries(ids.map(id => [id,`http://${pcIp}:${port}/json/${id}.json`])) }
  return running ? appendInstallationQueue({ ...input, queueId:queue.id! }) : startInstallationQueue({ ...input, transport:profile.transport || 'service' })
}

interface BatchResult { consoleId: string; name: string; state: 'pending'|'queued'|'failed'|'uncertain'; queueId?: string; message: string }
interface BatchRecord { id: string; fingerprint: string; state: 'pending'|'completed'; results: BatchResult[]; createdAt: number }
const batches = new Map<string, Promise<Omit<BatchRecord,'fingerprint'>>>()
function batchPath(id: string) { if (!/^[a-f0-9]{32}$/.test(id)) throw createError({ statusCode:400,message:'Неверный идентификатор установки' }); return dataPath('installation-batches',`${id}.json`) }
function publicBatch(value: BatchRecord) { const { fingerprint:_, ...result } = value; return result }
export function readDeviceBatch(id: string) {
  const path = batchPath(id)
  if (!existsSync(path)) throw createError({statusCode:404,message:'Установка не найдена'})
  return publicBatch(JSON.parse(readFileSync(path,'utf8')) as BatchRecord)
}
export async function installDeviceBatch(id: string, selection: DeviceSelection, destinations: string[], host: string) {
  const path = batchPath(id)
  if (!Array.isArray(destinations) || !destinations.length || destinations.some(id => typeof id !== 'string')) throw createError({statusCode:400,message:'Выберите устройства'})
  const targets = [...new Set(destinations)].sort(); targets.forEach(getConsoleProfile)
  const ids = resolveDeviceSelection(selection).sort()
  const fingerprint = createHash('sha256').update(JSON.stringify({targets,ids})).digest('hex')
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path,'utf8')) as BatchRecord
    if (saved.fingerprint !== fingerprint) throw createError({statusCode:409,message:'Этот идентификатор уже использован для другой установки'})
    if (batches.has(id)) return batches.get(id)!
    if (saved.state === 'pending') { saved.results = saved.results.map(result => result.state === 'pending' ? {...result,state:'uncertain',message:'WEB перезапускался. Проверьте очередь устройства; повторная установка не отправлена'} : result); saved.state='completed'; writeDurableJson(path,saved) }
    return publicBatch(saved)
  }
  const saved: BatchRecord = { id,fingerprint,state:'pending',createdAt:Date.now(),results:targets.map(consoleId => ({consoleId,name:getConsoleProfile(consoleId).name,state:'pending',message:'Проверяем устройство'})) }
  // Claim this ID synchronously before any network await.
  writeDurableJson(path,saved)
  const operation = (async () => {
    const preview = await previewDeviceInstall({packageIds:ids},targets)
    if (preview.devices.some(device => !device.eligible)) {
      saved.results = saved.results.map(result => ({...result,state:'failed',message:preview.devices.find(device=>device.profile.id===result.consoleId)?.reason || 'Установка не началась: проверьте остальные выбранные устройства'}))
    } else {
      // Separate results and queue identity for every console; one failure never stops the others.
      await Promise.all(saved.results.map(async result => {
        try { const queue = await dispatchDeviceInstall(result.consoleId,ids,host); result.state='queued'; result.queueId=queue.id; result.message='Файлы добавлены в очередь устройства' }
        catch (error: any) { result.state='failed'; result.message=error?.message || 'Не удалось запустить очередь устройства' }
        writeDurableJson(path,saved)
      }))
    }
    saved.state='completed'; writeDurableJson(path,saved); return publicBatch(saved)
  })().catch(error => { saved.results = saved.results.map(result=>result.state==='pending'?{...result,state:'failed',message:error?.message || 'Не удалось проверить устройства'}:result); saved.state='completed'; writeDurableJson(path,saved); return publicBatch(saved) }).finally(()=>batches.delete(id))
  batches.set(id,operation); return operation
}

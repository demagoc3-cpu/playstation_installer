import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createError } from 'h3'
import { dataPath } from './data-path'
import { captureLegacyConsole } from './console-scope'
import { readJsonFile, writeJsonFile } from './json-store'
import { writeDurableJson } from './durable-json'
import { getSavedPsIp, getGoldHenStatus } from './ps4-installer'
import { ps4ServiceIp, readPs4Service, getPs4SystemSnapshot } from './ps4-service'
import { getServiceInstallerStatus, serviceKeyConfigured, saveServiceKey, updatePairedServiceWebAddress } from './ps4-service-installer'
import { ps5WebAddressHeaders, ps5WebAddressAccepted } from './ps5-web-address'
import { ps5InstallCapabilities } from '../../shared/ps5-install-readiness'
import type { ConsoleProfile, ConsoleProfiles, ConsoleCapabilities, ConsolePlatform } from '../../shared/types/consoles'

const profilePath = () => dataPath('console-profiles.json')
const keyPath = () => dataPath('ps5-service-keys.json')
const emptyCapabilities = (): ConsoleCapabilities => ({ formats: [], installPs4: false, installPs5: false, background: false })
type StoredProfile = Omit<ConsoleProfile, 'online' | 'paired' | 'capabilities' | 'freeBytes' | 'checkedAt'>
interface Store { version: 1; activeId: string | null; consoles: StoredProfile[] }
const snapshots = new Map<string, Pick<ConsoleProfile, 'online' | 'paired' | 'capabilities' | 'freeBytes' | 'checkedAt'>>()

function store(): Store {
  captureLegacyConsole()
  const saved = readJsonFile<Store | null>(profilePath(), null)
  if (saved?.version === 1 && Array.isArray(saved.consoles) && saved.consoles.every(item =>
    item && typeof item.id === 'string' && typeof item.name === 'string' && ps4ServiceIp(item.ip) &&
    ['ps4', 'ps5'].includes(item.platform)) && new Set(saved.consoles.map(item => item.id)).size === saved.consoles.length &&
    new Set(saved.consoles.map(item => item.ip)).size === saved.consoles.length &&
    (saved.activeId === null || saved.consoles.some(item => item.id === saved.activeId))) return saved
  if (existsSync(profilePath())) throw createError({ statusCode: 500, message: 'Не удалось прочитать профили приставок. Сохранённый файл не изменён.' })
  const ip = ps4ServiceIp(getSavedPsIp())
  const consoles: StoredProfile[] = ip ? [{ id: randomUUID(), name: 'PS4', ip, platform: 'ps4', verified: false }] : []
  const initial: Store = { version: 1, activeId: consoles[0]?.id || null, consoles }
  writeJsonFile(profilePath(), initial)
  return initial
}

export function getConsoleProfile(id: unknown): StoredProfile {
  const value = store().consoles.find(item => item.id === id)
  if (!value) throw createError({ statusCode: 404, message: 'Приставка не найдена' })
  return value
}
export function consoleProfileForIp(ip: string) { return store().consoles.find(item => item.ip === ip) }
export function activeConsoleProfile() { const saved = store(); return saved.consoles.find(item => item.id === saved.activeId) }
function ps5Token(ip: string) { const value = readJsonFile<Record<string, string>>(keyPath(), {})[ip]; return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined }
const operationMethods = {
  '/api/v1/transfers/begin': 'POST', '/api/v1/transfers/status': 'GET', '/api/v1/transfers/chunk': 'POST',
  '/api/v1/transfers/commit': 'POST', '/api/v1/transfers/cancel': 'POST', '/api/v1/operations/status': 'GET',
  '/api/v1/install/staged': 'POST', '/api/v1/install/status': 'GET', '/api/v1/installer/job': 'GET',
  '/api/v1/install/verify': 'GET', '/api/v1/install/readiness': 'GET', '/api/v1/app/status': 'GET', '/api/v1/app/launch': 'POST',
  '/api/v1/app/stop': 'POST', '/api/v1/app/stop/status': 'GET',
  '/api/v1/folder/commit': 'POST', '/api/v1/folder/status': 'GET',
  '/api/v1/images/commit': 'POST', '/api/v1/images/status': 'GET',
  '/api/v1/web/config': 'POST',
  '/api/v1/management/status': 'GET', '/api/v1/console/catalog': 'GET',
  '/api/v1/saves/list': 'GET', '/api/v1/saves/manifest': 'GET',
  '/api/v1/saves/restore': 'POST', '/api/v1/saves/restore/status': 'GET', '/api/v1/saves/rollback': 'POST', '/api/v1/saves/finalize': 'POST',
  '/api/v1/console/games': 'GET', '/api/v1/console/info': 'GET', '/api/v1/console/command': 'POST', '/api/v1/console/command/status': 'GET', '/api/v1/console/storage': 'GET', '/api/v1/console/activity': 'GET',
  '/api/v1/status': 'GET', '/api/v1/shutdown': 'POST',
  '/api/v1/update/prepare': 'POST', '/api/v1/update/status': 'GET',
} as const
/** Fixed endpoints only. Callers cannot supply an address, credential or arbitrary path. */
export async function ps5OperationRequest(consoleId: string, path: keyof typeof operationMethods,
  headers: Record<string, string> = {}, body?: Uint8Array, signal?: AbortSignal) {
  const profile = getConsoleProfile(consoleId), token = ps5Token(profile.ip)
  if (profile.platform !== 'ps5' || !ps4ServiceIp(profile.ip) || !token) throw createError({ statusCode: 409, message: 'Требуется сопряжение PS5' })
  if (!Object.hasOwn(operationMethods, path) || Object.keys(headers).some(key => !/^X-PackageFlow-(Transfer-Id|Size|Blake3|Offset|Installer-Job|Web-Host|Web-Port|Console-Id|Update-Id|Request-Id|UI-Title|UI-Metadata-Hash|Title|Content|Version|User|Save-Kind|Save-Path|File-Id|Action|Destination|Source-Identity|Confirm-Title|Expected-App-Id)$/.test(key))) throw new Error('Invalid PS5 operation')
  const response = await fetch(`http://${profile.ip}:8095${path}`, { method: operationMethods[path],
    headers: { ...headers, Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) },
    body: body as BodyInit | undefined, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
  if (!response.body) throw new Error('Empty service response')
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = []
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) throw new Error('Response too large'); chunks.push(part.value) } }
  finally { await reader.cancel().catch(() => {}) }
  return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
}
/** Bounded binary reads only inside the service's validated savedata roots. */
export async function ps5SaveChunk(consoleId: string, headers: Record<string, string>) {
  const profile = getConsoleProfile(consoleId), token = ps5Token(profile.ip)
  if (profile.platform !== 'ps5' || !token) throw createError({ statusCode: 409, message: 'Требуется сопряжение PS5' })
  if (Object.keys(headers).some(key => !/^X-PackageFlow-(User|Title|Save-Kind|Save-Path|File-Id|Offset|Size)$/.test(key))) throw Error('Invalid save headers')
  const size = Number(headers['X-PackageFlow-Size'])
  if (!Number.isSafeInteger(size) || size < 0 || size > 1048576) throw Error('Invalid chunk size')
  const response = await fetch(`http://${profile.ip}:8095/api/v1/saves/read`, { headers: { ...headers, Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (response.status !== 200 || response.headers.get('content-type') !== 'application/octet-stream' || response.headers.get('content-length') !== String(size)) {
    await response.body?.cancel(); throw createError({ statusCode: 409, message: 'PS5 не подтвердила чтение сохранения. Закройте игру и повторите создание копии.' })
  }
  const reader = response.body?.getReader(); if (!reader) throw Error('Empty save response')
  const chunks: Uint8Array[] = []; let used = 0
  try { for (;;) { const part = await reader.read(); if (part.done) break; used += part.value.length; if (used > size) throw Error('Save chunk overflow'); chunks.push(part.value) } }
  finally { await reader.cancel().catch(() => {}) }
  if (used !== size) throw createError({ statusCode: 409, message: 'Чтение сохранения прервано; неполная копия не опубликована' })
  return Buffer.concat(chunks)
}
function publicProfile(item: StoredProfile): ConsoleProfile {
  const snapshot = snapshots.get(item.id)
  return { ...item, paired: false, capabilities: emptyCapabilities(), ...snapshot,
    online: !!snapshot?.online && Date.now() - (snapshot.checkedAt || 0) < 60000 }
}
export function getConsoleProfiles(): ConsoleProfiles { const saved = store(); return { activeId: saved.activeId, consoles: saved.consoles.map(publicProfile) } }

export function saveConsoleProfile(input: { id?: unknown; name?: unknown; ip?: unknown; platform?: unknown; model?: unknown; transport?: unknown }) {
  if (!input || typeof input !== 'object') throw createError({ statusCode: 400, message: 'Укажите параметры приставки' })
  const ip = ps4ServiceIp(input.ip)
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (input.model !== undefined && (typeof input.model !== 'string' || input.model.length > 64 || /[\x00-\x1f]/.test(input.model)) || input.transport !== undefined && !['service','payload'].includes(String(input.transport)))
    throw createError({ statusCode: 400, message: 'Проверьте модель и способ установки' })
  if (!ip || !name || name.length > 64 || /[\x00-\x1f]/.test(name) || !['ps4', 'ps5'].includes(String(input.platform)))
    throw createError({ statusCode: 400, message: 'Укажите имя, IPv4-адрес и платформу приставки' })
  const saved = store(), previous = input.id === undefined ? undefined : saved.consoles.find(item => item.id === input.id)
  if (input.id !== undefined && !previous) throw createError({ statusCode: 404, message: 'Приставка не найдена' })
  if (saved.consoles.some(item => item.ip === ip && item.id !== previous?.id)) throw createError({ statusCode: 409, message: 'Этот адрес уже добавлен' })
  if (previous && (previous.ip !== ip || previous.platform !== input.platform))
    throw createError({ statusCode: 409, message: 'Для другой приставки создайте отдельный профиль' })
  const profile: StoredProfile = { ...previous, id: previous?.id || randomUUID(), name, ip, platform: input.platform as ConsolePlatform, verified: previous?.verified || false }
  profile.model = input.model === undefined ? previous?.model : String(input.model).trim()
  profile.transport = profile.platform === 'ps5' ? 'service' : input.transport as 'service'|'payload' || previous?.transport || 'service'
  saved.consoles = [...saved.consoles.filter(item => item.id !== profile.id), profile]
  saved.activeId ||= profile.id
  snapshots.delete(profile.id); writeJsonFile(profilePath(), saved)
  return getConsoleProfiles()
}
export function selectConsoleProfile(id: unknown) { const profile = getConsoleProfile(id); const saved = store(); saved.activeId = profile.id; writeJsonFile(profilePath(), saved); return getConsoleProfiles() }
export function removeConsoleProfile(id: unknown) {
  const profile = getConsoleProfile(id), saved = store()
  saved.consoles = saved.consoles.filter(item => item.id !== profile.id)
  if (saved.activeId === profile.id) saved.activeId = saved.consoles[0]?.id || null
  snapshots.delete(profile.id); writeJsonFile(profilePath(), saved)
  return getConsoleProfiles()
}

/** Only the fixed PackageFlow port/path can be contacted. Credentials stay on WEB. */
export async function ps5ServiceRequest(ip: string, path: '/health' | '/api/v1/capabilities' | '/api/v1/system' | '/api/v1/pair' | '/api/v1/install/readiness', code?: string) {
  if (!ps4ServiceIp(ip)) throw createError({ statusCode: 400, message: 'Неверный адрес приставки' })
  const headers: Record<string, string> = {}
  if (path === '/api/v1/pair') headers['X-PackageFlow-Pairing-Code'] = code || ''
  else if (path !== '/health') {
    const token = ps5Token(ip)
    if (!token) throw createError({ statusCode: 409, message: 'Введите код сопряжения PS5' })
    headers.Authorization = `Bearer ${token}`
  }
  const response = await fetch(`http://${ip}:8095${path}`, { method: path === '/api/v1/pair' ? 'POST' : 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(3500) })
  if (!response.body) throw new Error('Empty service response')
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = []
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 16384) throw new Error('Response too large'); chunks.push(part.value) }
  } finally { await reader.cancel().catch(() => {}) }
  return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
}

export async function probeConsoleProfile(id: unknown) {
  const profile = getConsoleProfile(id)
  let online = false, paired = false, verified = false, version: string | undefined, pkgVersion: string | undefined, firmware: string | undefined
  let capabilities = emptyCapabilities()
  let freeBytes: number | undefined
  try {
    if (profile.platform === 'ps4' && profile.transport === 'payload') {
      online = (await getGoldHenStatus(profile.ip)).ready
      capabilities = { formats: online ? ['pkg'] : [], installPs4:online, installPs5:false, background:false }
      if(serviceKeyConfigured(profile.ip)){
        const status=await getServiceInstallerStatus(profile.ip),system=await getPs4SystemSnapshot(profile.ip)
        paired=status.paired===true;firmware=system.system?.firmware || undefined
        freeBytes=system.storage?.find(volume=>volume.available&&volume.path==='/user')?.availableBytes ?? undefined
      }
    } else if (profile.platform === 'ps4') {
      const ping = await readPs4Service(profile.ip, '/ping')
      if (ping.status !== 200 || (ping.body as any)?.service !== 'PackegeFlowService' || (ping.body as any)?.status !== 'ok') throw new Error('Unexpected service')
      online = verified = true; version = String((ping.body as any).version || '')
      const status = await getServiceInstallerStatus(profile.ip)
      paired = status.paired === true
      capabilities = { formats: status.ready ? ['pkg'] : [], installPs4: status.ready, installPs5: false, background: false, contentTypes:status.contentTypes }
      const system = await getPs4SystemSnapshot(profile.ip)
      pkgVersion = system.pkgVersion || undefined
      firmware = system.system?.firmware || undefined
      freeBytes = system.storage?.find(volume => volume.available && volume.path === '/user')?.availableBytes ?? undefined
    } else {
      const health = await ps5ServiceRequest(profile.ip, '/health'), report = health.body?.serviceReport
      if (health.status !== 200 || health.body?.apiVersion !== 'v1' || report?.service !== 'PackageFlowService-PS5' || (report.platform && report.platform !== 'ps5') || report.consoleVerified !== true) throw new Error('Unexpected service')
      online = verified = true; version = String(report.version || '')
      const raw = /^0x([0-9a-f]{2})([0-9a-f]{2})[0-9a-f]{4}$/i.exec(health.body.firmwareRaw || '')
      if (health.body.firmwareRead && raw && /^\d{2}$/.test(raw[1]) && /^\d{2}$/.test(raw[2])) firmware = `${Number(raw[1])}.${raw[2]}`
      if (ps5Token(profile.ip)) {
        const response = await ps5ServiceRequest(profile.ip, '/api/v1/capabilities')
        paired = response.status === 200 && response.body?.service === 'PackageFlowService-PS5'
        if (paired) {
          try {
            const readiness = await ps5ServiceRequest(profile.ip, '/api/v1/install/readiness')
            capabilities = ps5InstallCapabilities(readiness.status, readiness.body, firmware)
          } catch { capabilities = ps5InstallCapabilities(503, null, firmware) }
          capabilities.background = response.body.capabilities?.backgroundService === true
          const system = await ps5ServiceRequest(profile.ip,'/api/v1/system')
          if (system.status === 200 && system.body?.service === 'PackageFlowService-PS5' && system.body.storageRead === true && Number.isSafeInteger(system.body.freeBytes) && system.body.freeBytes >= 0 && Number.isSafeInteger(system.body.totalBytes) && system.body.totalBytes > 0 && system.body.freeBytes <= system.body.totalBytes) freeBytes=system.body.freeBytes
        }
      }
    }
  } catch { /* A stored token is not proof that the current service accepts it. */ }
  const latest = store(), current = latest.consoles.find(item => item.id === profile.id)
  if (!current || current.ip !== profile.ip || current.platform !== profile.platform) return getConsoleProfiles()
  if (verified) { current.verified = true; current.version = version; current.pkgVersion = pkgVersion; current.firmware = firmware; writeJsonFile(profilePath(), latest) }
  snapshots.set(profile.id, { online, paired, capabilities, freeBytes, checkedAt: Date.now() })
  return getConsoleProfiles()
}

const probes = new Map<string, Promise<ConsoleProfiles>>()
export function refreshConsoleProfile(id: string, force = false) {
  const snapshot = snapshots.get(id)
  if (!force && snapshot?.checkedAt && Date.now() - snapshot.checkedAt < 15000) return Promise.resolve(getConsoleProfiles())
  const existing = probes.get(id)
  if (existing) return existing
  const pending = probeConsoleProfile(id).finally(() => probes.delete(id))
  probes.set(id, pending); return pending
}
/** No device-count limit; bound the number of simultaneous network probes. */
export async function refreshConsoleProfiles() {
  const ids = getConsoleProfiles().consoles.map(item => item.id)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
    while (next < ids.length) { const id = ids[next++]!; await refreshConsoleProfile(id).catch(() => {}) }
  }))
  return getConsoleProfiles()
}

/** The app obtains the paired server from its local service, as on PS4. */
export async function updatePairedConsoleWebAddress(id: unknown, webUrl: string) {
  const profile = getConsoleProfile(id)
  if (profile.platform === 'ps4') return updatePairedServiceWebAddress(profile.ip, webUrl)
  const headers = ps5WebAddressHeaders(webUrl, profile.id)
  const response = await ps5OperationRequest(profile.id, '/api/v1/web/config', headers)
  if (response.status === 404)
    throw createError({ statusCode: 409, message: 'Обновите службу PS5 для автоматического адреса WEB' })
  if (response.status !== 200 || !ps5WebAddressAccepted(response.body, headers))
    throw createError({ statusCode: 502, message: 'Служба PS5 не подтвердила сохранение адреса WEB' })
  return { updated: true, configured: true, message: 'Адрес WEB на PS5 обновлён' }
}

export async function pairConsoleProfile(id: unknown, code: unknown, webUrl: string) {
  const profile = getConsoleProfile(id)
  if (profile.platform === 'ps4') await saveServiceKey(profile.ip, code, webUrl)
  else {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw createError({ statusCode: 400, message: 'Код PS5 должен содержать 6 цифр' })
    const health = await ps5ServiceRequest(profile.ip, '/health')
    if (health.status !== 200 || health.body?.apiVersion !== 'v1' || health.body?.serviceReport?.service !== 'PackageFlowService-PS5' || (health.body.serviceReport.platform && health.body.serviceReport.platform !== 'ps5') || health.body.serviceReport.consoleVerified !== true)
      throw createError({ statusCode: 409, message: 'По этому адресу не подтверждён сервис PS5' })
    const response = await ps5ServiceRequest(profile.ip, '/api/v1/pair', code)
    if (response.status !== 200 || response.body?.apiVersion !== 'v1' || !/^[0-9a-f]{64}$/.test(response.body?.token || ''))
      throw createError({ statusCode: response.status === 401 ? 401 : 409, message: 'Сопряжение PS5 не выполнено. Проверьте код и откройте новое окно сопряжения.' })
    writeDurableJson(keyPath(), { ...readJsonFile(keyPath(), {}), [profile.ip]: response.body.token })
    try {
      await updatePairedConsoleWebAddress(profile.id, webUrl)
    } catch {
      // Older services still pair. Keep the saved token and report only the
      // missing address synchronization, so the user does not pair again.
      const profiles = await probeConsoleProfile(profile.id)
      return { ...profiles, webAddress: { updated: false, message: 'Сопряжение сохранено. Для автоматического адреса WEB обновите службу PS5 и обновите адрес WEB в подключении.' } }
    }
  }
  return probeConsoleProfile(profile.id)
}

/** Icons only from /user/appmeta/<validated title>/icon0.png; credentials stay in WEB. */
export async function ps5ConsoleIcon(consoleId:string,titleId:string){
  const p=getConsoleProfile(consoleId),token=ps5Token(p.ip)
  if(p.platform!=='ps5'||!token||!/^(PPSA|CUSA)\d{5}$/.test(titleId))throw createError({statusCode:404,message:'Значок недоступен'})
  const r=await fetch(`http://${p.ip}:8095/api/v1/console/icon`,{headers:{Authorization:`Bearer ${token}`,'X-PackageFlow-Title':titleId},redirect:'error',signal:AbortSignal.timeout(5000)})
  const expected=Number(r.headers.get('content-length'))
  if(r.status!==200||r.headers.get('content-type')!=='image/png'||!Number.isSafeInteger(expected)||expected<8||expected>1048576){await r.body?.cancel();throw createError({statusCode:404,message:'Значок недоступен'})}
  const reader=r.body?.getReader();if(!reader)throw Error('Empty icon');const chunks:Uint8Array[]=[];let bytes=0
  try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>expected)throw Error('Icon overflow');chunks.push(part.value)}}finally{await reader.cancel().catch(()=>{})}
  const data=Buffer.concat(chunks);if(bytes!==expected||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw createError({statusCode:404,message:'Значок повреждён'});return data
}

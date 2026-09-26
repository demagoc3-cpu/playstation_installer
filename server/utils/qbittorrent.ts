import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { stat } from 'node:fs/promises'

const settingsPath = resolve(process.cwd(), '.data/qbittorrent.json')
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface QbitSettings { baseUrl: string; username: string; password: string; downloadPath: string }
export interface PublicQbitSettings { baseUrl: string; username: string; downloadPath: string; configured: boolean }

const blankSettings = (): QbitSettings => ({ baseUrl: 'http://127.0.0.1:8080', username: '', password: '', downloadPath: '' })

function writeSettings(settings: QbitSettings) {
  mkdirSync(dirname(settingsPath), { recursive: true })
  const temporary = `${settingsPath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(settings))
  renameSync(temporary, settingsPath)
}

function readSettings(): QbitSettings {
  try { return { ...blankSettings(), ...JSON.parse(readFileSync(settingsPath, 'utf8')) } } catch { return blankSettings() }
}

function publicSettings(settings: QbitSettings): PublicQbitSettings {
  return { baseUrl: settings.baseUrl, username: settings.username, downloadPath: settings.downloadPath, configured: existsSync(settingsPath) }
}

function validateSettings(input: Partial<QbitSettings>): QbitSettings {
  const settings = { ...readSettings(), ...input }
  let url: URL
  try { url = new URL(settings.baseUrl) } catch { throw createError({ statusCode: 400, statusMessage: 'Укажите URL qBittorrent, например http://127.0.0.1:8080' }) }
  if (!['http:', 'https:'].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname === '::1' ? '[::1]' : url.hostname)) {
    throw createError({ statusCode: 400, statusMessage: 'Для безопасности разрешён только локальный qBittorrent (127.0.0.1, localhost).' })
  }
  if (!settings.downloadPath.trim()) throw createError({ statusCode: 400, statusMessage: 'Укажите папку загрузок qBittorrent' })
  return { ...settings, baseUrl: url.origin }
}

function timeoutFetch(url: string, init: RequestInit = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

async function request(path: string, init: RequestInit = {}) {
  const settings = readSettings()
  if (!existsSync(settingsPath)) throw createError({ statusCode: 409, statusMessage: 'Сначала сохраните настройки qBittorrent' })
  const verified = validateSettings(settings)
  const login = await timeoutFetch(`${verified.baseUrl}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: verified.username, password: verified.password })
  })
  const cookie = login.headers.get('set-cookie')?.match(/SID=[^;]+/)?.[0]
  if (!login.ok || !cookie) throw createError({ statusCode: 502, statusMessage: 'qBittorrent отклонил подключение. Проверьте Web UI, адрес и пароль.' })
  const response = await timeoutFetch(`${verified.baseUrl}/api/v2${path}`, { ...init, headers: { ...init.headers, Cookie: cookie } })
  if (!response.ok) throw createError({ statusCode: 502, statusMessage: `qBittorrent вернул ошибку ${response.status}` })
  return response
}

export function getQbitSettings() { return publicSettings(readSettings()) }

export async function saveQbitSettings(input: Partial<QbitSettings>) {
  const settings = validateSettings(input)
  writeSettings(settings)
  await request('/app/version')
  return publicSettings(settings)
}

export async function getQbitStatus() {
  const settings = getQbitSettings()
  if (!settings.configured) return { ...settings, ready: false, version: '' }
  try { return { ...settings, ready: true, version: await (await request('/app/version')).text() } } catch { return { ...settings, ready: false, version: '' } }
}

export async function addTorrent(source: string, installAfterDownload = false) {
  if (!/^magnet:\?xt=urn:btih:/i.test(source) && !/^https?:\/\//i.test(source)) throw createError({ statusCode: 400, statusMessage: 'Добавьте magnet-ссылку или HTTPS-ссылку на .torrent' })
  const settings = validateSettings(readSettings())
  const response = await request('/torrents/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ urls: source, savepath: settings.downloadPath, tags: installAfterDownload ? 'packageflow,packageflow-auto-install' : 'packageflow' })
  })
  const result = await response.text()
  if (result.trim() !== 'Ok.') throw createError({ statusCode: 502, statusMessage: 'qBittorrent не принял торрент-задачу' })
}

export async function getTorrents() {
  const response = await request('/torrents/info?tag=packageflow')
  const torrents = await response.json() as Array<Record<string, unknown>>
  return torrents.map((torrent) => ({
    hash: String(torrent.hash || ''), name: String(torrent.name || 'Без названия'), state: String(torrent.state || 'unknown'), size: Number(torrent.size || 0), progress: Number(torrent.progress || 0),
    downloaded: Number(torrent.downloaded || 0), speed: Number(torrent.dlspeed || 0), eta: Number(torrent.eta || 0), seeds: Number(torrent.num_seeds || 0), autoInstall: String(torrent.tags || '').split(',').includes('packageflow-auto-install'), contentPath: String(torrent.content_path || ''), savePath: String(torrent.save_path || '')
  }))
}

export async function setTorrentAutoInstall(hash: string, enabled: boolean) {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор торрент-задачи' })
  await request(enabled ? '/torrents/addTags' : '/torrents/removeTags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ hashes: hash, tags: 'packageflow-auto-install' })
  })
}

export async function getTorrentFiles(hash: string) {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор торрент-задачи' })
  const response = await request(`/torrents/files?hash=${encodeURIComponent(hash)}`)
  const files = await response.json() as Array<Record<string, unknown>>
  return files.map((file) => ({ index: Number(file.index || 0), name: String(file.name || ''), size: Number(file.size || 0), progress: Number(file.progress || 0), priority: Number(file.priority || 0) }))
}

export async function setTorrentFilesPriority(hash: string, ids: number[], priority: 0 | 1) {
  if (!/^[a-f0-9]{40}$/i.test(hash) || !ids.length || ids.some((id) => !Number.isInteger(id) || id < 0)) throw createError({ statusCode: 400, statusMessage: 'Некорректный список файлов торрент-задачи' })
  await request('/torrents/filePrio', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hash, id: ids.join('|'), priority: String(priority) }) })
}

export async function getCompletedTorrentDirectory(hash: string) {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор торрент-задачи' })
  const response = await request(`/torrents/info?hashes=${encodeURIComponent(hash)}`)
  const torrent = (await response.json() as Array<Record<string, unknown>>)[0]
  if (!torrent || !String(torrent.tags || '').split(',').includes('packageflow')) throw createError({ statusCode: 404, statusMessage: 'Задача PackageFlow не найдена' })
  if (Number(torrent.progress || 0) < 1) throw createError({ statusCode: 409, statusMessage: 'Torrent ещё не завершён' })
  const source = String(torrent.content_path || torrent.save_path || '')
  const path = resolve(source)
  const info = await stat(path).catch(() => undefined)
  if (!info) throw createError({ statusCode: 404, statusMessage: 'Загруженные файлы не найдены на диске' })
  const root = info.isDirectory() ? path : dirname(path)
  const settings = validateSettings(readSettings())
  if (relative(resolve(settings.downloadPath), root).startsWith('..')) throw createError({ statusCode: 403, statusMessage: 'Файлы torrent находятся вне настроенной папки загрузок' })
  return root
}

export async function controlTorrent(hash: string, action: 'pause' | 'resume' | 'delete') {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw createError({ statusCode: 400, statusMessage: 'Некорректный идентификатор торрент-задачи' })
  const path = action === 'delete' ? '/torrents/delete' : `/torrents/${action}`
  await request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(action === 'delete' ? { hashes: hash, deleteFiles: 'false' } : { hashes: hash }) })
}

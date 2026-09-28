import { logEvent } from './event-log'
import { existsSync, readFileSync } from 'node:fs'
import { writeJsonFile } from './json-store'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { stat } from 'node:fs/promises'

const settingsPath = resolve(process.cwd(), '.data/qbittorrent.json')

/**
 * downloadPath — the downloads folder as seen from this PC (PackageFlow reads PKGs there).
 * remotePath   — the same folder as seen by qBittorrent, when it runs on another machine
 *                (NAS, Docker, server). Empty when qBittorrent sees the same paths as this PC.
 */
export interface QbitSettings { baseUrl: string; username: string; password: string; downloadPath: string; remotePath: string }
export interface PublicQbitSettings { baseUrl: string; username: string; downloadPath: string; remotePath: string; hasPassword: boolean; configured: boolean }

const blankSettings = (): QbitSettings => ({ baseUrl: 'http://127.0.0.1:8080', username: '', password: '', downloadPath: '', remotePath: '' })

function writeSettings(settings: QbitSettings) {
  writeJsonFile(settingsPath, settings)
}

function readSettings(): QbitSettings {
  try { return { ...blankSettings(), ...JSON.parse(readFileSync(settingsPath, 'utf8')) } } catch { return blankSettings() }
}

function publicSettings(settings: QbitSettings): PublicQbitSettings {
  return { baseUrl: settings.baseUrl, username: settings.username, downloadPath: settings.downloadPath, remotePath: settings.remotePath, hasPassword: Boolean(settings.password), configured: existsSync(settingsPath) }
}

function validateSettings(input: Partial<QbitSettings>): QbitSettings {
  const stored = readSettings()
  const settings = { ...stored, ...input }
  // An empty password field in the form means "keep the saved password".
  if (!input.password) settings.password = stored.password
  const address = String(settings.baseUrl || '').trim()
  let url: URL
  try { url = new URL(/^[a-z]+:\/\//i.test(address) ? address : `http://${address}`) } catch { throw createError({ statusCode: 400, message: 'Укажите адрес qBittorrent Web UI, например http://192.168.1.10:8080' }) }
  if (!['http:', 'https:'].includes(url.protocol)) throw createError({ statusCode: 400, message: 'Адрес qBittorrent должен начинаться с http:// или https://' })
  if (url.username || url.password) throw createError({ statusCode: 400, message: 'Укажите логин и пароль в отдельных полях, а не в адресе' })
  if (!settings.downloadPath.trim()) throw createError({ statusCode: 400, message: 'Укажите папку загрузок на этом компьютере' })
  const basePath = url.pathname.replace(/\/+$/, '') // qBittorrent behind a reverse proxy may live under a sub-path
  return { ...settings, baseUrl: `${url.origin}${basePath}`, downloadPath: settings.downloadPath.trim(), remotePath: String(settings.remotePath || '').trim() }
}

const slashes = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')

/** Translates a path reported by qBittorrent into the same place on this PC (see remotePath). */
function toLocalPath(settings: QbitSettings, source: string) {
  if (!settings.remotePath) return source
  const remote = slashes(settings.remotePath)
  const path = slashes(source)
  if (path.toLowerCase() !== remote.toLowerCase() && !path.toLowerCase().startsWith(`${remote.toLowerCase()}/`)) return source
  return join(settings.downloadPath, path.slice(remote.length))
}

function timeoutFetch(url: string, init: RequestInit = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

async function request(path: string, init: RequestInit = {}) {
  const settings = readSettings()
  if (!existsSync(settingsPath)) throw createError({ statusCode: 409, message: 'Сначала сохраните настройки qBittorrent' })
  const verified = validateSettings(settings)
  const login = await timeoutFetch(`${verified.baseUrl}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: verified.username, password: verified.password })
  }).catch(() => { throw createError({ statusCode: 502, message: `Не удалось связаться с qBittorrent по адресу ${verified.baseUrl}. Запущен ли он и включён ли Web UI?` }) })
  const loginBody = (await login.text().catch(() => '')).trim()
  // qBittorrent < 5.2: 200 "Ok." / 200 "Fails." and cookie "SID".
  // qBittorrent >= 5.2: 204 (empty) / 401 and cookie "QBT_SID_<port>".
  if (login.status === 403) throw createError({ statusCode: 502, message: 'qBittorrent временно заблокировал вход с этого IP после неудачных попыток. Подождите или перезапустите qBittorrent.' })
  if (login.status === 401 || /^fails/i.test(loginBody)) throw createError({ statusCode: 502, message: 'qBittorrent: неверный логин или пароль Web UI.' })
  if (!login.ok) throw createError({ statusCode: 502, message: `qBittorrent ответил на вход ошибкой ${login.status}` })
  const setCookies = typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie') || '']
  const cookie = setCookies.map((value) => value.split(';')[0]?.trim() || '').filter((value) => /^(?:QBT_)?SID(?:_\d+)?=/i.test(value)).join('; ')
  // No session cookie with a successful login means "bypass authentication for localhost" is enabled.
  const response = await timeoutFetch(`${verified.baseUrl}/api/v2${path}`, { ...init, headers: { ...init.headers, ...(cookie ? { Cookie: cookie } : {}) } })
  if (response.status === 403) throw createError({ statusCode: 502, message: 'qBittorrent отклонил сессию (403). Проверьте логин и пароль Web UI.' })
  if (!response.ok) throw createError({ statusCode: 502, message: `qBittorrent вернул ошибку ${response.status}` })
  return response
}

export function getQbitSettings() { return publicSettings(readSettings()) }

export async function saveQbitSettings(input: Partial<QbitSettings>) {
  const settings = validateSettings(input)
  writeSettings(settings)
  const version = await (await request('/app/version')).text()
  logEvent('info', `qBittorrent подключён: ${version.trim()} (${settings.baseUrl})`)
  return publicSettings(settings)
}

export async function getQbitStatus() {
  const settings = getQbitSettings()
  if (!settings.configured) return { ...settings, ready: false, version: '' }
  try { return { ...settings, ready: true, version: await (await request('/app/version')).text() } } catch { return { ...settings, ready: false, version: '' } }
}

export async function addTorrent(source: string, installAfterDownload = false) {
  if (!/^magnet:\?xt=urn:btih:/i.test(source) && !/^https?:\/\//i.test(source)) throw createError({ statusCode: 400, message: 'Добавьте magnet-ссылку или HTTPS-ссылку на .torrent' })
  const settings = validateSettings(readSettings())
  const response = await request('/torrents/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ urls: source, savepath: settings.remotePath || settings.downloadPath, tags: installAfterDownload ? 'packageflow,packageflow-auto-install' : 'packageflow' })
  })
  const result = await response.text()
  if (/^fails/i.test(result.trim())) throw createError({ statusCode: 502, message: 'qBittorrent не принял торрент-задачу' })
}

/** qBittorrent joins tags with ", " (comma + space); older builds used a bare comma. */
function torrentTags(torrent: Record<string, unknown>) { return String(torrent.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean) }

export async function getTorrents() {
  const response = await request('/torrents/info?tag=packageflow')
  const torrents = await response.json() as Array<Record<string, unknown>>
  return torrents.map((torrent) => ({
    hash: String(torrent.hash || ''), name: String(torrent.name || 'Без названия'), state: String(torrent.state || 'unknown'), size: Number(torrent.size || 0), progress: Number(torrent.progress || 0),
    downloaded: Number(torrent.downloaded || 0), speed: Number(torrent.dlspeed || 0), eta: Number(torrent.eta || 0), seeds: Number(torrent.num_seeds || 0), autoInstall: torrentTags(torrent).includes('packageflow-auto-install'), contentPath: String(torrent.content_path || ''), savePath: String(torrent.save_path || '')
  }))
}

export async function setTorrentAutoInstall(hash: string, enabled: boolean) {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw createError({ statusCode: 400, message: 'Некорректный идентификатор торрент-задачи' })
  await request(enabled ? '/torrents/addTags' : '/torrents/removeTags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ hashes: hash, tags: 'packageflow-auto-install' })
  })
}

export async function getTorrentFiles(hash: string) {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw createError({ statusCode: 400, message: 'Некорректный идентификатор торрент-задачи' })
  const response = await request(`/torrents/files?hash=${encodeURIComponent(hash)}`)
  const files = await response.json() as Array<Record<string, unknown>>
  return files.map((file) => ({ index: Number(file.index || 0), name: String(file.name || ''), size: Number(file.size || 0), progress: Number(file.progress || 0), priority: Number(file.priority || 0) }))
}

export async function setTorrentFilesPriority(hash: string, ids: number[], priority: 0 | 1) {
  if (!/^[a-f0-9]{40}$/i.test(hash) || !ids.length || ids.some((id) => !Number.isInteger(id) || id < 0)) throw createError({ statusCode: 400, message: 'Некорректный список файлов торрент-задачи' })
  await request('/torrents/filePrio', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hash, id: ids.join('|'), priority: String(priority) }) })
}

export async function getCompletedTorrentDirectory(hash: string) {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw createError({ statusCode: 400, message: 'Некорректный идентификатор торрент-задачи' })
  const response = await request(`/torrents/info?hashes=${encodeURIComponent(hash)}`)
  const torrent = (await response.json() as Array<Record<string, unknown>>)[0]
  if (!torrent || !torrentTags(torrent).includes('packageflow')) throw createError({ statusCode: 404, message: 'Задача PackageFlow не найдена' })
  if (Number(torrent.progress || 0) < 1) throw createError({ statusCode: 409, message: 'Torrent ещё не завершён' })
  const settings = validateSettings(readSettings())
  const source = String(torrent.content_path || torrent.save_path || '')
  const path = resolve(toLocalPath(settings, source))
  const info = await stat(path).catch(() => undefined)
  if (!info) {
    const hint = settings.remotePath ? 'Проверьте, что «Папка в qBittorrent» и «Папка на этом ПК» указывают на одно и то же место.' : 'Если qBittorrent работает на другом компьютере, укажите в настройках «Папку в qBittorrent».'
    throw createError({ statusCode: 404, message: `Загруженные файлы не найдены: ${path}. ${hint}` })
  }
  const root = info.isDirectory() ? path : dirname(path)
  const inside = relative(resolve(settings.downloadPath), root)
  // On Windows a path on another drive comes back absolute, not as "..".
  if (inside.startsWith('..') || isAbsolute(inside)) throw createError({ statusCode: 403, message: 'Файлы torrent находятся вне настроенной папки загрузок' })
  return root
}

export async function controlTorrent(hash: string, action: 'pause' | 'resume' | 'delete') {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw createError({ statusCode: 400, message: 'Некорректный идентификатор торрент-задачи' })
  const post = (path: string) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(action === 'delete' ? { hashes: hash, deleteFiles: 'false' } : { hashes: hash }) })
  if (action === 'delete') { await post('/torrents/delete'); return }
  // qBittorrent 5.0 renamed pause/resume to stop/start; older versions only know pause/resume.
  const modern = action === 'pause' ? '/torrents/stop' : '/torrents/start'
  try { await post(modern) } catch (error: any) {
    if (!/ошибку 404/.test(error?.message || '')) throw error
    await post(`/torrents/${action}`)
  }
}

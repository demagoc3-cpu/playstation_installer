<script setup lang="ts">
const { t, locale, formatLocale } = useAppLocale()
useHead(() => ({ htmlAttrs: { lang: locale.value } }))

import type { InstallationTransport } from '../shared/types/installation'
import type { SearchResult } from '#shared/types/search'
import { packageHasId, packageIdentity } from '#shared/package-identity'
type PackageType = 'Игра' | 'Патч' | 'Бэкпорт' | 'DLC'
type Section = 'library' | 'console' | 'saves' | 'torrents' | 'search' | 'log' | 'ftp' | 'system' | 'donate'
const SECTIONS: Section[] = ['library', 'console', 'saves', 'torrents', 'search', 'log', 'ftp', 'system', 'donate']
const donationConfig = useRuntimeConfig().public.donation
const donationBtc = String(donationConfig?.btc || '').trim()
const donationUsdtTrc20 = String(donationConfig?.usdtTrc20 || '').trim()
const hasDonations = Boolean(donationBtc || donationUsdtTrc20)
type PackageState = 'ready' | 'sending' | 'queued' | 'receiving' | 'installing' | 'delivered' | 'installed' | 'skipped' | 'failed'
interface ServerPackage { id: string; sourceIds?: string[]; title: string; fileName: string; appVersion?: string; masterVersion?: string; requiredFirmware?: string; sdkFirmware?: string; packageVolume?: 'application' | 'patch' | 'add-on' | 'unknown'; packageDigest?: string; size: number; iconSize?: number; type: PackageType; titleId: string; installOrder: number; url: string; contentId: string; contentType: string; libraryRoot: string; installedAt?: number }
interface PackageItem extends ServerPackage { rowId: string; state: PackageState; detail: string; bytesSent: number; completedAt?: number; iconUrl?: string }
interface GameGroup { id: string; title: string; items: PackageItem[]; cover?: string }
interface TorrentItem { hash: string; name: string; state: string; size: number; progress: number; downloaded: number; speed: number; eta: number; seeds: number; autoInstall: boolean }
interface TorrentFile { index: number; name: string; size: number; progress: number; priority: number }
interface QbitStatus { baseUrl: string; username: string; downloadPath: string; remotePath?: string; hasPassword?: boolean; configured: boolean; ready: boolean; version: string }
interface SearchSettings { name: string; endpoint: string; categories: string; hasApiKey: boolean; configured: boolean }
interface InstallationQueueItem { packageId: string; state: 'pending' | 'sending' | 'waiting' | 'receiving' | 'installing' | 'verifying' | 'delivered' | 'installed' | 'unconfirmed' | 'skipped' | 'failed' | 'cancelled'; detail: string; bytesSent: number; completedAt?: number; installedAt?: number }
interface InstallationQueue { id?: string; status: 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'; transport?: InstallationTransport; currentIndex?: number; items: InstallationQueueItem[]; message?: string }

const psIp = ref('10.1.200.5')
const activeSection = ref<Section>('library')
const saveFocusTitleId = ref('')
const connected = ref(false)
const showIpEditor = ref(false)
const statusMessage = ref('Проверяем подключение к PlayStation…')
const packages = ref<PackageItem[]>([])
const selected = ref(new Set<string>())
const tooltipPositions = reactive<Record<string, { top: string; left: string }>>({})
const reinstallTarget = ref<PackageItem | null>(null)
const expanded = ref(new Set<string>())
const isSending = ref(false)
const installationMethod = ref<InstallationTransport>('service')
async function restoreInstallationMethod() {
  try {
    const setting = await $fetch<{ transport: InstallationTransport }>('/api/ps4/installation-method')
    if (setting.transport === 'payload' || setting.transport === 'service') installationMethod.value = setting.transport
  } catch { /* Keep the service default while the server starts. */ }
}
async function selectInstallationMethod(value: InstallationTransport) {
  const previous = installationMethod.value
  installationMethod.value = value
  try { await $fetch('/api/ps4/installation-method', { method: 'POST', body: { transport: value } }) }
  catch (error: any) { installationMethod.value = previous; statusMessage.value = errorText(error) || 'Не удалось сохранить способ установки' }
}
const queueMethod = ref<InstallationTransport>('payload')
const queueStatus = ref<InstallationQueue['status']>('idle')
const queueId = ref('')
const queueItems = ref<InstallationQueueItem[]>([])
const serviceConnected = ref(false)
const consoleConnected = ref(false)
const installationConnected = computed(() => activeSection.value === 'console' ? consoleConnected.value : installationMethod.value === 'service' ? serviceConnected.value : connected.value)
const deliveryTimers = new Map<string, number>()
const qbit = ref<QbitStatus>({ baseUrl: 'http://127.0.0.1:8080', username: '', downloadPath: '', configured: false, ready: false, version: '' })
const torrents = ref<TorrentItem[]>([])
const torrentSource = ref('')
const installAfterDownload = ref(false)
const showTorrentSettings = ref(false)
const torrentSettings = reactive({ baseUrl: 'http://127.0.0.1:8080', username: '', password: '', downloadPath: '', remotePath: '' })
const torrentFiles = ref<Record<string, TorrentFile[]>>({})
const searchSettings = reactive({ name: 'Torznab', endpoint: '', apiKey: '', categories: '1180' })
const searchHasApiKey = ref(false)
const searchConfigured = ref(false)
const searchQuery = ref('')
const searchResults = ref<SearchResult[]>([])
const showSearchSettings = ref(false)
const searchBusy = ref(false)
const searchWasRun = ref(false)
const searchStatus = ref('')
const searchDownloadPending = ref('')
const searchDownloadMessage = ref('')
let torrentTimer: number | undefined
interface LogEntry { id: number; time: number; level: 'info' | 'warn' | 'error'; text: string; count: number }
const logEntries = ref<LogEntry[]>([])
const logBox = ref<HTMLElement>()
let logLastId = 0
let logTimer: number | undefined
const activeTorrents = computed(() => torrents.value.filter((torrent) => torrent.progress < 1).length)
const logProblems = computed(() => logEntries.value.filter((entry) => entry.level !== 'info').length)
let installationTimer: number | undefined
let torrentRefreshRunning = false
const totalSize = computed(() => formatBytes(packages.value.reduce((sum, item) => sum + item.size, 0)))
const deliveredCount = computed(() => packages.value.filter((item) => item.state === 'delivered').length)
const installedCount = computed(() => packages.value.filter((item) => item.state === 'installed').length)
const selectedItems = computed(() => packages.value.filter((item) => selected.value.has(item.rowId)))
const selectedReadyCount = computed(() => selectedItems.value.filter((item) => item.state === 'ready').length)
const anyReady = computed(() => packages.value.some((item) => item.state === 'ready'))
const groups = computed<GameGroup[]>(() => {
  const byTitle = new Map<string, PackageItem[]>()
  for (const item of packages.value) byTitle.set(item.titleId, [...(byTitle.get(item.titleId) || []), item])
  return [...byTitle.entries()].map(([id, items]) => {
    items.sort((a, b) => a.installOrder - b.installOrder || a.title.localeCompare(b.title) || (a.appVersion || '').localeCompare(b.appVersion || '', undefined, { numeric: true }) || a.fileName.localeCompare(b.fileName, undefined, { numeric: true }))
    const game = items.find((item) => item.type === 'Игра')
    return { id, title: game?.title || `Игра ${id}`, items, cover: game?.iconUrl || items.find((item) => item.iconUrl)?.iconUrl }
  }).sort((a, b) => a.title.localeCompare(b.title))
})

/** qBittorrent < 5.0 reports pausedDL/pausedUP, 5.0+ reports stoppedDL/stoppedUP. */
function isTorrentStopped(torrent: TorrentItem) { return /paused|stopped/i.test(torrent.state) }
function logTime(time: number) { return new Date(time).toLocaleTimeString(formatLocale.value) }
async function refreshLog() {
  try {
    const result = await $fetch<{ entries: LogEntry[]; lastId: number }>('/api/logs', { query: { after: logLastId } })
    if (result.lastId < logLastId) { logEntries.value = []; logLastId = 0; return refreshLog() } // server restarted
    if (!result.entries.length) return
    const box = logBox.value
    const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 40
    const next = [...logEntries.value]
    for (const entry of result.entries) {
      // A repeated event comes back with a higher count: replace the previous line.
      const last = next.at(-1)
      if (entry.count > 1 && last && last.text === entry.text && last.level === entry.level) next.pop()
      next.push(entry)
    }
    logEntries.value = next.slice(-200)
    logLastId = result.lastId
    if (atBottom) await nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight })
  } catch { /* the log is best-effort */ }
}
async function clearLog() { try { await $fetch('/api/logs', { method: 'DELETE' }); logEntries.value = [] } catch { /* ignore */ } }
/** Server errors carry their (Russian) text in `message`; `statusMessage` is kept ASCII-only by h3. */
function errorText(error: any): string | undefined { return error?.data?.message || error?.data?.statusMessage || undefined }
function formatBytes(value: number) { if (!value) return '0 Б'; const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1); return `${(value / 1024 ** index).toLocaleString(formatLocale.value, { minimumFractionDigits: index >= 3 ? 1 : 0, maximumFractionDigits: index >= 3 ? 1 : 0, useGrouping: false })} ${units[index]}` }
function typeClass(type: PackageType) { return ({ Игра: 'game', Патч: 'patch', Бэкпорт: 'backport', DLC: 'dlc' })[type] }
function placePackageTooltip(event: MouseEvent | FocusEvent, rowId: string) {
  const button = event.currentTarget as HTMLElement
  const popup = button.nextElementSibling as HTMLElement | null
  if (!popup) return
  const trigger = button.getBoundingClientRect()
  const height = popup.offsetHeight
  const width = popup.offsetWidth
  const above = trigger.top - height - 8
  const preferredTop = above >= 80 ? above : trigger.bottom + 8
  tooltipPositions[rowId] = {
    top: `${Math.max(80, Math.min(preferredTop, window.innerHeight - height - 8))}px`,
    left: `${Math.max(8, Math.min(trigger.left + trigger.width / 2 - width / 2, window.innerWidth - width - 8))}px`,
  }
}
function iconFor(item: ServerPackage) { return item.iconSize ? `/api/packages/${item.id}?asset=icon` : undefined }
function isOpen(id: string) { return expanded.value.has(id) }
function toggleGroup(id: string) { const next = new Set(expanded.value); next.has(id) ? next.delete(id) : next.add(id); expanded.value = next }
function isSelected(id: string) { return selected.value.has(id) }
function toggleSelected(id: string) { const next = new Set(selected.value); next.has(id) ? next.delete(id) : next.add(id); selected.value = next }
function setGroupSelected(group: GameGroup, checked: boolean) { const next = new Set(selected.value); group.items.forEach((item) => checked ? next.add(item.rowId) : next.delete(item.rowId)); selected.value = next }
function groupQueueCurrent(group: GameGroup) {
  if (queueStatus.value !== 'running' && queueStatus.value !== 'cancelling') return undefined
  const active = queueItems.value.find((entry) => ['sending', 'waiting', 'receiving', 'installing', 'verifying'].includes(entry.state) && group.items.some((item) => packageHasId(item, entry.packageId)))
  return active && group.items.find((item) => packageHasId(item, active.packageId))
}
function groupQueuePending(group: GameGroup) {
  if (queueStatus.value !== 'running' && queueStatus.value !== 'cancelling') return []
  return queueItems.value.filter((entry) => entry.state === 'pending').map((entry) => group.items.find((item) => packageHasId(item, entry.packageId))).filter((item): item is PackageItem => !!item)
}
function groupQueueSkipped(group: GameGroup) {
  return queueItems.value.filter((entry) => entry.state === 'skipped' && group.items.some((item) => packageHasId(item, entry.packageId)))
}
function pendingSummary(items: PackageItem[]) { return items.slice(0, 2).map((item) => `${item.type}: ${item.title}`).join(' · ') + (items.length > 2 ? ` · ещё ${items.length - 2}` : '') }
async function connect() { showIpEditor.value = false; if (installationMethod.value === 'payload') statusMessage.value = 'Проверяем PyLoader на порту 9090…'; try { const result = await $fetch<{ ready: boolean }>('/api/ps4/status', { method: 'POST', body: { ip: psIp.value } }); connected.value = result.ready; if (installationMethod.value === 'payload') statusMessage.value = result.ready ? 'PyLoader готов к работе на PlayStation 4' : 'PyLoader не ответил на порту 9090' } catch (error: any) { connected.value = false; if (installationMethod.value === 'payload') statusMessage.value = errorText(error) || 'Не удалось проверить соединение с консолью' } }
function samePackage(a: ServerPackage, b: ServerPackage) {
  const identity = packageIdentity(a)
  return packageHasId(a, b.id) || packageHasId(b, a.id) || Boolean(identity && identity === packageIdentity(b))
}
function appendPackages(items: ServerPackage[]) {
  const additions: PackageItem[] = []
  for (const item of items) {
    const title = item.titleId === 'PFLS00001' ? 'PackageFlowService' : item.title
    const matches = [...packages.value, ...additions].filter(entry => samePackage(entry, item))
    const existing = matches.find(entry => ['sending', 'queued', 'receiving', 'installing'].includes(entry.state)) || matches[0]
    if (existing) {
      const duplicates = new Set(matches.filter(entry => entry !== existing).map(entry => entry.rowId))
      const next = new Set(selected.value)
      for (const entry of matches) if (duplicates.has(entry.rowId)) {
        if (next.has(entry.rowId)) next.add(existing.rowId)
        next.delete(entry.rowId); stopDeliveryWatch(entry)
      }
      packages.value = packages.value.filter(entry => !duplicates.has(entry.rowId))
      for (let i = additions.length - 1; i >= 0; i--) if (duplicates.has(additions[i]!.rowId)) additions.splice(i, 1)
      selected.value = next
      Object.assign(existing, item, { title, iconUrl: iconFor(item) })
      continue
    }
    additions.push({ ...item, title, rowId: `${Date.now()}-${Math.random().toString(36).slice(2)}`, state: item.installedAt ? 'installed' : 'ready', detail: item.installedAt ? 'Отмечен как установленный' : 'Готов к отправке', bytesSent: 0, iconUrl: iconFor(item) })
  }
  packages.value.push(...additions)
  return additions
}
async function scanDirectory(directory: string) { try { statusMessage.value = 'Сканируем исходные файлы — они не будут скопированы…'; const result = await $fetch<{ packages: ServerPackage[] }>('/api/packages/scan', { method: 'POST', body: { directory, psIp: psIp.value } }); const additions = appendPackages(result.packages); statusMessage.value = additions.length ? `Добавлено пакетов: ${additions.length}` : 'Подходящих .pkg или .fpkg не найдено' } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось просканировать папку' } }
async function scanServerFolder() { const directory = window.prompt(t('Введите полный путь к папке с .pkg/.fpkg на этом компьютере')); if (directory?.trim()) await scanDirectory(directory) }
async function chooseFolder() {
  try {
    statusMessage.value = 'Выбираем папку с PKG…'
    const result = await $fetch<{ directory: string; cancelled: boolean; manual?: boolean; docker?: boolean; suggestedDirectory?: string }>('/api/packages/select-directory', { method: 'POST', body: { initial: packages.value.at(-1)?.libraryRoot } })
    if (result.manual) {
      const directory = window.prompt(t(result.docker
        ? 'Введите путь к папке внутри Docker, например /games. Папка с ПК должна быть подключена к контейнеру.'
        : 'Системное окно выбора папки недоступно. Введите полный путь к папке с PKG на компьютере, где запущен PackageFlow.'), result.suggestedDirectory || '')
      if (directory?.trim()) await scanDirectory(directory.trim())
      else statusMessage.value = 'Выбор папки отменён'
      return
    }
    if (result.cancelled || !result.directory) { statusMessage.value = 'Выбор папки отменён'; return }
    await scanDirectory(result.directory)
  } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось выбрать папку' }
}
async function restoreLibrary() { try { const result = await $fetch<{ packages: ServerPackage[] }>('/api/packages', { query: { psIp: psIp.value } }); const additions = appendPackages(result.packages); if (additions.length) statusMessage.value = `Восстановлено из библиотеки: ${additions.length}` } catch { /* Подключение к библиотеке будет повторено при следующем запуске. */ } }
async function refreshConsoleLibrary() {
  const result = await $fetch<{ packages: ServerPackage[] }>('/api/packages', { query: { psIp: psIp.value } })
  for (const item of packages.value) {
    const value = result.packages.find(p => samePackage(p, item))
    if (value && item.installedAt && !value.installedAt) { stopDeliveryWatch(item); item.installedAt = undefined; item.state = 'ready'; item.detail = 'Удалено на PS4; пакет готов к повторной установке'; item.bytesSent = 0 }
    else if (value?.installedAt && !item.installedAt) { item.installedAt = value.installedAt; item.state = 'installed'; item.detail = 'Установка подтверждена PS4' }
  }
  appendPackages(result.packages)
}
function applyInstallationQueue(queue: InstallationQueue) { const states: Record<InstallationQueueItem['state'], PackageState> = { pending: 'queued', sending: 'sending', waiting: 'queued', receiving: 'receiving', installing: 'installing', verifying: 'queued', delivered: 'delivered', installed: 'installed', unconfirmed: 'skipped', skipped: 'skipped', failed: 'failed', cancelled: 'ready' }; for (const queued of queue.items) { const item = packages.value.find((entry) => packageHasId(entry, queued.packageId)); if (!item) continue; item.state = states[queued.state]; item.detail = queued.detail; item.bytesSent = queued.bytesSent; item.completedAt = queued.completedAt; item.installedAt = queued.installedAt } isSending.value = queue.status === 'running' || queue.status === 'cancelling'; queueStatus.value = queue.status; queueId.value = queue.id || ''; queueItems.value = queue.items; queueMethod.value = queue.transport || 'payload'; if (queue.message) statusMessage.value = queue.message }
async function restoreInstallationQueue() { try { applyInstallationQueue(await $fetch<InstallationQueue>('/api/ps4/installation')) } catch { /* Библиотека и ручная установка остаются доступны, если сервер только запускается. */ } }
async function importCompletedTorrent(item: TorrentItem) { if (item.progress < 1) return; try { const result = await $fetch<{ packages: ServerPackage[]; alreadyIndexed: boolean }>(`/api/torrents/${item.hash}/library`, { method: 'POST', body: { psIp: psIp.value } }); const additions = appendPackages(result.packages); if (additions.length) statusMessage.value = `Из torrent добавлено в библиотеку: ${additions.length} пак.`; /* Automatic installation is started by the server (torrent-autoinstall), even with this page closed. */ } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось запустить автоматическую установку torrent' } }
/** Copies the saved settings into the form. Never while the form is open, or the 2 s poll would overwrite what the user types. */
function toggleTorrentSettings() { if (!showTorrentSettings.value) syncTorrentForm(); showTorrentSettings.value = !showTorrentSettings.value }
function syncTorrentForm() { torrentSettings.baseUrl = qbit.value.baseUrl; torrentSettings.username = qbit.value.username; torrentSettings.downloadPath = qbit.value.downloadPath; torrentSettings.remotePath = qbit.value.remotePath || ''; torrentSettings.password = '' }
async function refreshTorrents() { if (torrentRefreshRunning) return; torrentRefreshRunning = true; try { qbit.value = await $fetch<QbitStatus>('/api/torrents/settings'); if (!showTorrentSettings.value) syncTorrentForm(); if (qbit.value.ready) { torrents.value = await $fetch<TorrentItem[]>('/api/torrents'); for (const item of torrents.value.filter((torrent) => torrent.progress >= 1)) await importCompletedTorrent(item) } else torrents.value = [] } catch { qbit.value.ready = false; torrents.value = [] } finally { torrentRefreshRunning = false } }
async function saveTorrentSettings() { try { qbit.value = await $fetch<QbitStatus>('/api/torrents/settings', { method: 'POST', body: torrentSettings }); showTorrentSettings.value = false; await refreshTorrents(); statusMessage.value = `qBittorrent подключён${qbit.value.version ? `: ${qbit.value.version}` : ''}` } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось подключиться к qBittorrent' } }
async function addTorrent() { if (!torrentSource.value.trim()) return; try { await $fetch('/api/torrents/add', { method: 'POST', body: { source: torrentSource.value, installAfterDownload: installAfterDownload.value } }); torrentSource.value = ''; statusMessage.value = installAfterDownload.value ? 'Torrent добавлен: после загрузки начнётся установка на PS4' : 'Торрент передан qBittorrent'; await refreshTorrents() } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось добавить торрент' } }
async function controlTorrent(item: TorrentItem, action: 'pause' | 'resume' | 'delete') { try { await $fetch(`/api/torrents/${item.hash}/${action}`, { method: 'POST' }); await refreshTorrents() } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось изменить торрент-задачу' } }
async function setTorrentAutoInstall(item: TorrentItem, enabled: boolean) { try { await $fetch(`/api/torrents/${item.hash}/auto-install`, { method: 'POST', body: { enabled } }); await refreshTorrents(); if (enabled && item.progress >= 1) statusMessage.value = 'Автоустановка включена: добавляем завершённый torrent в очередь…' } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось изменить автоустановку torrent' } }
async function loadSearchSettings() { try { const data = await $fetch<SearchSettings>('/api/search/settings'); searchSettings.name = data.name; searchSettings.endpoint = data.endpoint; searchSettings.categories = data.categories ?? '1180'; searchHasApiKey.value = !!data.hasApiKey; searchConfigured.value = data.configured } catch { searchConfigured.value = false } }
async function saveSearchSettings() { try { const data = await $fetch<SearchSettings>('/api/search/settings', { method: 'POST', body: searchSettings }); searchSettings.name = data.name; searchSettings.endpoint = data.endpoint; searchSettings.categories = data.categories ?? '1180'; searchHasApiKey.value = !!data.hasApiKey; searchConfigured.value = data.configured; searchSettings.apiKey = ''; showSearchSettings.value = false; statusMessage.value = 'Источник поиска сохранён' } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось сохранить источник поиска' } }
async function searchTorrents() { if (!searchQuery.value.trim() || searchBusy.value) return; searchBusy.value = true; searchWasRun.value = true; searchStatus.value = ''; searchDownloadMessage.value = ''; try { searchResults.value = await $fetch<SearchResult[]>('/api/search', { query: { q: searchQuery.value } }); searchStatus.value = searchResults.value.length ? `Найдено результатов: ${searchResults.value.length}` : 'По запросу ничего не найдено' } catch (error: any) { searchResults.value = []; searchWasRun.value = false; searchStatus.value = errorText(error) || 'Не удалось выполнить поиск' } finally { searchBusy.value = false } }
async function downloadSearchResult(result: SearchResult, autoInstall = false) {
  if (searchDownloadPending.value || !qbit.value.ready) return
  searchDownloadPending.value = result.source; searchDownloadMessage.value = ''
  try {
    await $fetch('/api/torrents/add', { method: 'POST', body: { source: result.source, installAfterDownload: autoInstall } })
    searchDownloadMessage.value = autoInstall ? 'Torrent добавлен: после загрузки начнётся установка на PS4' : 'Результат передан qBittorrent'
    statusMessage.value = searchDownloadMessage.value; await refreshTorrents()
  } catch (error: any) { searchDownloadMessage.value = errorText(error) || 'Не удалось добавить результат в загрузки'; statusMessage.value = searchDownloadMessage.value }
  finally { searchDownloadPending.value = '' }
}
async function toggleTorrentFiles(item: TorrentItem) { if (torrentFiles.value[item.hash]) { const next = { ...torrentFiles.value }; delete next[item.hash]; torrentFiles.value = next; return } try { torrentFiles.value = { ...torrentFiles.value, [item.hash]: await $fetch<TorrentFile[]>(`/api/torrents/${item.hash}/files`) } } catch (error: any) { statusMessage.value = errorText(error) || 'Файлы станут доступны после получения metadata torrent' } }
async function setTorrentFile(item: TorrentItem, file: TorrentFile, selected: boolean) { try { await $fetch(`/api/torrents/${item.hash}/files`, { method: 'POST', body: { ids: [file.index], priority: selected ? 1 : 0 } }); torrentFiles.value = { ...torrentFiles.value, [item.hash]: await $fetch<TorrentFile[]>(`/api/torrents/${item.hash}/files`) } } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось изменить выбор файлов' } }
async function dispatchPackage(item: PackageItem) { await $fetch('/api/ps4/queue', { method: 'POST', body: { url: item.url, title: item.title, contentId: item.contentId, contentType: item.contentType, size: item.size, packageId: item.id } }) }
function stopDeliveryWatch(item: PackageItem) { const timer = deliveryTimers.get(item.rowId); if (timer) window.clearInterval(timer); deliveryTimers.delete(item.rowId) }
async function checkDelivery(item: PackageItem) { if (item.state === 'failed' || item.state === 'delivered') { stopDeliveryWatch(item); return item.state === 'delivered' } try { const data = await $fetch<{ bytesSent: number; size: number; completedAt?: number }>(`/api/packages/${item.id}?asset=delivery`); item.bytesSent = Math.min(data.bytesSent, data.size); if (data.completedAt) { item.completedAt = data.completedAt; item.state = 'delivered'; item.detail = 'Файл полностью передан PlayStation; можно передавать следующий пакет'; stopDeliveryWatch(item); return true } if (data.bytesSent > 0) { item.state = 'receiving'; item.detail = `PS4 получила ${formatBytes(item.bytesSent)} из ${formatBytes(data.size)}` } } catch { /* Не подменяем статус догадкой после перезапуска сервера. */ } return false }
function startDeliveryWatch(item: PackageItem) { stopDeliveryWatch(item); void checkDelivery(item); deliveryTimers.set(item.rowId, window.setInterval(() => void checkDelivery(item), 1500)) }
function ordered(items: PackageItem[]) { return [...items].filter((item) => item.state === 'ready').sort((a, b) => a.installOrder - b.installOrder || a.title.localeCompare(b.title) || (a.appVersion || '').localeCompare(b.appVersion || '', undefined, { numeric: true }) || a.fileName.localeCompare(b.fileName, undefined, { numeric: true })) }
async function installItems(items: PackageItem[]) {
  const queue = ordered(items)
  if (!queue.length) { statusMessage.value = 'Нет готовых выбранных пакетов'; return }
  const appending = queueStatus.value === 'running' && !!queueId.value
  if (isSending.value && !appending) { statusMessage.value = 'Очередь завершается или отменяется. Дождитесь ответа PS4.'; return }
  if (!appending && installationMethod.value === 'payload') {
    if (!connected.value) await connect()
    if (!connected.value) { showIpEditor.value = true; return }
  } else if (!appending) {
    try {
      const status = await $fetch<{ ready: boolean; message: string }>('/api/ps4/service-installer', { query: { ip: psIp.value } })
      if (!status.ready) { statusMessage.value = status.message; return }
    } catch (error: any) { statusMessage.value = errorText(error) || 'Сервис недоступен'; return }
  }
  try {
    const packageUrls = Object.fromEntries(queue.map(item => [item.id, item.url]))
    if (appending) {
      applyInstallationQueue(await $fetch<InstallationQueue>('/api/ps4/installation/append', { method: 'POST', body: { ip: psIp.value, queueId: queueId.value, packageIds: queue.map(item => item.id), packageUrls } }))
      statusMessage.value = `Добавлено в текущую очередь: ${queue.length} пак.`
    } else applyInstallationQueue(await $fetch<InstallationQueue>('/api/ps4/installation', { method: 'POST', body: { ip: psIp.value, packageIds: queue.map(item => item.id), packageUrls, transport: installationMethod.value } }))
  } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось передать очередь установщику' }
}
function installOne(item: PackageItem) { return installItems([item]) }
function installDlc(group?: GameGroup) { return installItems((group?.items || packages.value).filter((item) => item.type === 'DLC')) }
async function toggleInstalled(item: PackageItem) { if (item.state !== 'ready') return resetPackage(item); try { await $fetch(`/api/packages/${item.id}/installed`, { method: 'POST', body: { installed: true } }); stopDeliveryWatch(item); item.installedAt = Date.now(); item.state = 'installed'; item.detail = 'Отмечен как установленный' } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось изменить отметку установки' } }
async function resetPackage(item: PackageItem) { try { await $fetch(`/api/packages/${item.id}/reset`, { method: 'POST' }); stopDeliveryWatch(item); item.installedAt = undefined; item.completedAt = undefined; item.bytesSent = 0; item.state = 'ready'; item.detail = 'Готов к отправке'; statusMessage.value = `«${item.title}» можно установить заново` } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось сбросить статус пакета' } }
const isCancelling = ref(false)
async function cancelInstallation() { if (!window.confirm(t(queueMethod.value === 'service' ? 'Запросить отмену задания на PS4? WEB дождётся ответа консоли; следующие пакеты не будут отправлены.' : 'Отменить установку? Текущая передача на PS4 будет прервана, оставшиеся пакеты не будут отправлены.'))) return; isCancelling.value = true; try { applyInstallationQueue(await $fetch<InstallationQueue>('/api/ps4/installation/cancel', { method: 'POST' })) } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось отменить установку' } finally { isCancelling.value = false } }
async function resolveCancellation() { if (!queueId.value || !window.confirm(t('Вы уже отменили эту загрузку в «Уведомления → Загрузки» на PS4? WEB снимет ожидание, но не сможет подтвердить результат установки.'))) return; isCancelling.value = true; try { applyInstallationQueue(await $fetch<InstallationQueue>('/api/ps4/installation/resolve-cancel', { method: 'POST', body: { id: queueId.value } })) } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось снять ожидание отмены' } finally { isCancelling.value = false } }
async function removePackage(item: PackageItem) { if (!window.confirm(t(`Убрать «${item.title}» из библиотеки? Исходный PKG останется на диске.`))) return; try { await $fetch(`/api/packages/${item.id}`, { method: 'DELETE' }); stopDeliveryWatch(item); packages.value = packages.value.filter((entry) => entry.rowId !== item.rowId); const next = new Set(selected.value); next.delete(item.rowId); selected.value = next; statusMessage.value = 'Пакет удалён из списка. Исходный файл не изменён.' } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось удалить пакет из списка' } }
async function reindexBranch(group: GameGroup) { const root = group.items[0]?.libraryRoot; if (!root) { statusMessage.value = 'Не найден исходный путь ветки. Просканируйте папку заново.'; return } try { statusMessage.value = `Переиндексируем ${group.id}…`; const result = await $fetch<{ packages: ServerPackage[] }>('/api/packages/scan', { method: 'POST', body: { directory: root, psIp: psIp.value, titleId: group.id } }); group.items.forEach(stopDeliveryWatch); const removedIds = new Set(group.items.map((item) => item.rowId)); packages.value = packages.value.filter((item) => !removedIds.has(item.rowId)); const next = new Set(selected.value); removedIds.forEach((id) => next.delete(id)); selected.value = next; const additions = appendPackages(result.packages); statusMessage.value = `Ветка переиндексирована: ${additions.length} пак.` } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось переиндексировать ветку' } }
async function removeBranch(group: GameGroup) { if (!window.confirm(t(`Убрать всю ветку ${group.id}: игру, патчи и DLC? Исходные PKG останутся на диске.`))) return; try { await $fetch('/api/packages/branch', { method: 'DELETE', query: { titleId: group.id } }); group.items.forEach(stopDeliveryWatch); const ids = new Set(group.items.map((item) => item.rowId)); packages.value = packages.value.filter((item) => !ids.has(item.rowId)); const next = new Set(selected.value); ids.forEach((id) => next.delete(id)); selected.value = next; statusMessage.value = `Ветка ${group.id} удалена из библиотеки` } catch (error: any) { statusMessage.value = errorText(error) || 'Не удалось удалить ветку' } }
onBeforeUnmount(() => { deliveryTimers.forEach((timer) => window.clearInterval(timer)); if (torrentTimer) window.clearInterval(torrentTimer); if (installationTimer) window.clearInterval(installationTimer); if (logTimer) window.clearInterval(logTimer) })
async function restorePsIp() { try { const saved = await $fetch<{ ip: string }>('/api/ps4/settings'); if (saved.ip) { psIp.value = saved.ip; return true } } catch { /* Сервер ещё запускается — останется адрес по умолчанию. */ } return false }
// The open section lives in the URL hash (#torrents, #log…) so a reload keeps it.
function sectionFromHash() { const name = window.location.hash.slice(1) as Section; return SECTIONS.includes(name) && (name !== 'donate' || hasDonations) ? name : 'library' }
function openSaves(titleId: string) { saveFocusTitleId.value = titleId; activeSection.value = 'saves' }
watch(activeSection, (section) => { const hash = section === 'library' ? '' : `#${section}`; if (window.location.hash !== hash) history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`); if (section === 'log') void nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight }) })
onMounted(() => { activeSection.value = sectionFromHash(); window.addEventListener('hashchange', () => { activeSection.value = sectionFromHash() }) })
onMounted(() => { void restoreInstallationMethod().then(restorePsIp).then((restored) => { if (restored) return connect(); showIpEditor.value = true; statusMessage.value = 'Укажите IP-адрес PlayStation и нажмите «Подключить»' }).then(() => restoreLibrary()).then(restoreInstallationQueue);  void refreshTorrents(); void loadSearchSettings(); torrentTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshTorrents() }, 2000); installationTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void restoreInstallationQueue() }, 1500); void refreshLog(); logTimer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshLog() }, 2000) })
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <GithubStats />
      <div class="brand"><img class="brand-logo" :src="`/brand/packageflow-${locale}.svg`" alt="PackageFlow" width="223" height="52"></div>
      <div class="topbar-controls">
      <div class="connection">
        <span class="status-dot" :class="{ offline: !installationConnected }" />
        <span>{{ t(installationConnected ? 'PS4 подключена' : 'PS4 не подключена') }}</span>
        <button class="ip-button" @click="showIpEditor = !showIpEditor">{{ psIp }}</button>
        <form v-if="showIpEditor" class="ip-editor" @submit.prevent="connect">
          <input v-model="psIp" inputmode="decimal"><button>{{ t("Подключить") }}</button>
        </form>
      </div>
      <LanguageSwitcher />
      </div>
    </header>
    <nav class="sidebar" :aria-label="t(&quot;Разделы PackageFlow&quot;)">
      <span class="sidebar-caption">{{ t("РАЗДЕЛЫ") }}</span>
      <button :class="{ active: activeSection === 'library' }" :title="t(&quot;Библиотека&quot;)" @click="activeSection = 'library'"><span aria-hidden="true">▦</span><span class="nav-label">{{ t("Библиотека") }}</span><small v-if="isSending" class="nav-badge live" :title="t(&quot;Идёт установка&quot;)">●</small></button><button :class="{ active: activeSection === 'console' }" :title="t(&quot;На консоли&quot;)" @click="activeSection = 'console'"><span aria-hidden="true">▣</span><span class="nav-label">{{ t("На консоли") }}</span></button><button :class="{ active: activeSection === 'saves' }" :title="t(&quot;Сохранения&quot;)" @click="activeSection = 'saves'"><span aria-hidden="true">▤</span><span class="nav-label">{{ t("Сохранения") }}</span></button><button :class="{ active: activeSection === 'torrents' }" :title="t(&quot;Загрузки torrent&quot;)" @click="activeSection = 'torrents'"><span aria-hidden="true">⇣</span><span class="nav-label">{{ t("Загрузки") }}</span><small v-if="activeTorrents" class="nav-badge">{{ t(activeTorrents) }}</small></button><button :class="{ active: activeSection === 'search' }" :title="t(&quot;Поиск torrent&quot;)" @click="activeSection = 'search'"><span aria-hidden="true">⌕</span><span class="nav-label">{{ t("Поиск") }}</span></button><button :class="{ active: activeSection === 'log' }" :title="t(&quot;Журнал&quot;)" @click="activeSection = 'log'"><span aria-hidden="true">☰</span><span class="nav-label">{{ t("Журнал") }}</span><small v-if="logProblems" class="nav-badge warn">{{ t(logProblems) }}</small></button>

      <button :class="{ active: activeSection === 'ftp' }" :title="t(&quot;Файлы консоли&quot;)" @click="activeSection = 'ftp'"><span aria-hidden="true">⇅</span><span class="nav-label">{{ t("Файлы") }}</span></button>
      <button :class="{ active: activeSection === 'system' }" :title="t(&quot;О системе&quot;)" @click="activeSection = 'system'"><span aria-hidden="true">ⓘ</span><span class="nav-label">{{ t("О системе") }}</span></button>
      <button v-if="hasDonations" class="donate-link" :class="{ active: activeSection === 'donate' }" :title="t(&quot;Поддержать проект&quot;)" @click="activeSection = 'donate'"><span aria-hidden="true">♥</span><span class="nav-label">{{ t("Поддержать") }}</span></button><span class="sidebar-note">PS4 {{ psIp }}</span>
    </nav>
    <section v-show="activeSection === 'library'" class="content"><div class="intro"><div><p class="eyebrow">{{ t("ЛОКАЛЬНАЯ БИБЛИОТЕКА") }}</p><h1>{{ t("Игры и дополнения") }}</h1><p>{{ t("Пакеты автоматически объединяются по CUSA. Исходные файлы остаются в выбранной папке.") }}</p></div><div class="pickers"><button class="primary" @click="chooseFolder">{{ t("Выбрать папку") }}</button></div></div>
      <section class="stats"><article><span>{{ t("ИГРЫ") }}</span><strong>{{ t(groups.length) }}</strong><small>{{ t(packages.length) }} {{ t("пакетов") }}</small></article><article><span>{{ t("ВЫБРАНО") }}</span><strong>{{ t(selectedItems.length) }}</strong><small>{{ t(formatBytes(selectedItems.reduce((sum, item) => sum + item.size, 0))) }}</small></article><article><span>{{ t("ПЕРЕДАНО PS4") }}</span><strong>{{ t(deliveredCount) }}</strong><small>{{ t("из") }} {{ t(packages.length) }} {{ t("пакетов") }}</small></article><article><span>{{ t("УСТАНОВЛЕНО") }}</span><strong>{{ t(installedCount) }}</strong><small>{{ t("подтверждено или отмечено вручную") }}</small></article></section>
      <ReinstallGame :ip="psIp" :pkg="reinstallTarget" @close="reinstallTarget = null" @changed="refreshConsoleLibrary" /><InstallationMethod :model-value="installationMethod" :ip="psIp" :disabled="isSending" @update:model-value="selectInstallationMethod" @status="serviceConnected = $event" />
      <section class="library">
        <div class="library-head">
          <div><h2>{{ t("Очередь установки") }}</h2><p>{{ t(statusMessage) }}</p></div>
          <div class="actions">
            <button class="secondary" :disabled="queueStatus === 'cancelling' || !selectedReadyCount" @click="installItems(selectedItems)">{{ t(queueStatus === 'running' ? 'Добавить выбранное' : 'Установить выбранное') }}</button>
            <button class="secondary" :disabled="queueStatus === 'cancelling' || !packages.some((item) => item.type === 'DLC' && item.state === 'ready')" @click="installDlc()">{{ t(queueStatus === 'running' ? 'Добавить DLC' : 'Все DLC') }}</button>
            <button v-if="queueStatus === 'running'" class="danger" :disabled="isCancelling" @click="cancelInstallation">{{ t(isCancelling ? 'Отменяем…' : 'Отменить установку') }}</button>
            <button v-if="queueStatus === 'cancelling'" class="secondary" :disabled="isCancelling" @click="resolveCancellation">{{ t(isCancelling ? 'Проверяем…' : 'Снять ожидание') }}</button>
            <button class="primary" :disabled="queueStatus === 'cancelling' || !anyReady" @click="installItems(packages)">{{ t(queueStatus === 'running' ? 'Добавить всё' : 'Установить всё') }}</button>
          </div>
        </div>
        <p v-if="!groups.length" class="empty">{{ t("Выберите файлы или папку. Для пути на ПК можно использовать «Сканировать путь» ниже.") }}</p>
        <article v-for="group in groups" :key="group.id" class="game-group">
          <div class="game-head">
            <button class="expand" @click="toggleGroup(group.id)"><span :class="{ open: isOpen(group.id) }">›</span></button>
            <div class="game-cover"><img v-if="group.cover" :src="group.cover" alt=""><span v-else>{{ group.title.charAt(0) }}</span></div>
            <button class="game-name" @click="toggleGroup(group.id)">
              <strong>{{ group.title }}</strong>
              <span>{{ t(group.id) }} · {{ t(group.items.length) }} {{ t("пак.") }}</span>
              <span v-if="groupQueueCurrent(group)" class="group-current">{{ t("Сейчас:") }} {{ t(groupQueueCurrent(group)?.type) }} · {{ groupQueueCurrent(group)?.title }} · {{ t(groupQueueCurrent(group)?.detail) }}</span>
              <span v-if="groupQueuePending(group).length" class="group-pending">{{ t("В очереди:") }} {{ t(pendingSummary(groupQueuePending(group))) }}</span>
              <span v-if="groupQueueSkipped(group).length" class="group-skipped">{{ t("Пропущено:") }} {{ t(groupQueueSkipped(group).length) }} · {{ t(groupQueueSkipped(group)[0]?.detail) }}</span>
            </button>
            <div class="group-actions">
              <label class="select-all"><input type="checkbox" :checked="group.items.every((item) => isSelected(item.rowId))" @change="setGroupSelected(group, ($event.target as HTMLInputElement).checked)"> {{ t("все") }}</label>
              <button class="tiny" :disabled="queueStatus === 'cancelling' || !group.items.some((item) => item.type === 'DLC' && item.state === 'ready')" @click="installDlc(group)">DLC</button>
              <button class="tiny" :disabled="isSending" @click="reindexBranch(group)">{{ t("Переиндекс.") }}</button>
              <button class="tiny" :disabled="isSending" @click="removeBranch(group)">{{ t("Удалить ветку") }}</button>
            </div>
          </div>
          <div v-show="isOpen(group.id)" class="package-list">
            <div v-for="item in group.items" :key="item.rowId" class="package-row">
              <input type="checkbox" :checked="isSelected(item.rowId)" @change="toggleSelected(item.rowId)">
              <div class="cover"><img v-if="item.iconUrl" :src="item.iconUrl" alt=""><span v-else>{{ t(item.type === 'Игра' ? item.title.charAt(0) : item.type) }}</span></div>
              <div class="package-name">
                <strong>{{ item.title }}</strong>
                <div v-if="item.state === 'receiving' || item.state === 'installing' || item.state === 'delivered'" class="progress"><i :style="{ width: `${Math.min(100, item.bytesSent / item.size * 100)}%` }" /></div>
              </div>
              <div class="package-type-wrap">
                <button type="button" class="type" :class="typeClass(item.type)" :aria-label="t(`Сведения о PKG: ${item.title}`)" :aria-describedby="`pkg-meta-${item.rowId}`" @mouseenter="placePackageTooltip($event, item.rowId)" @focus="placePackageTooltip($event, item.rowId)">{{ t(item.type) }}</button>
                <div :id="`pkg-meta-${item.rowId}`" class="package-metadata-popover" :style="tooltipPositions[item.rowId]" role="tooltip">
                  <strong>{{ t("Сведения о пакете") }}</strong>
                  <dl>
                    <dt>{{ t("Файл") }}</dt><dd>{{ item.fileName }}</dd>
                    <dt>{{ t("Игра") }}</dt><dd>{{ item.titleId }}</dd>
                    <dt>Content ID</dt><dd>{{ item.contentId }}</dd>
                    <template v-if="item.appVersion"><dt>{{ t("Версия") }}</dt><dd>{{ t(item.appVersion) }}</dd></template>
                    <template v-if="item.masterVersion"><dt>{{ t("Исходная версия") }}</dt><dd>{{ t(item.masterVersion) }}</dd></template>
                    <template v-if="item.requiredFirmware"><dt>{{ t("Прошивка PKG") }}</dt><dd>{{ t(item.requiredFirmware) }}</dd></template>
                    <template v-if="item.sdkFirmware"><dt>{{ t("Версия SDK") }}</dt><dd>{{ t(item.sdkFirmware) }}</dd></template>
                    <dt>{{ t("Тип PKG") }}</dt><dd>{{ t(item.packageVolume === 'application' ? 'Игра' : item.packageVolume === 'patch' ? 'Патч' : item.packageVolume === 'add-on' ? 'DLC' : item.contentType || 'Неизвестен') }}</dd>
                    <dt>{{ t("Категория") }}</dt><dd>{{ t(item.contentType) }}</dd>
                    <dt>{{ t("Размер") }}</dt><dd>{{ t(formatBytes(item.size)) }}</dd>
                    <template v-if="item.libraryRoot"><dt>{{ t("Папка") }}</dt><dd>{{ item.libraryRoot }}</dd></template>
                    <template v-if="item.packageDigest"><dt>{{ t("Отпечаток PKG") }}</dt><dd>{{ item.packageDigest }}</dd></template>
                  </dl>
                </div>
              </div>
              <span class="size">{{ t(formatBytes(item.size)) }}</span>
              <span class="state" :class="item.state">{{ t(item.detail) }}</span>
              <div class="package-actions">
                <button class="tiny install-one" :disabled="queueStatus === 'cancelling' || item.state !== 'ready'" @click="installOne(item)">{{ t(queueStatus === 'running' ? 'В очередь' : 'Установить') }}</button>
                <button v-if="item.contentType === 'PS4GD'" class="tiny" :disabled="isSending" @click="reinstallTarget = item">{{ t("Переустановить") }}</button>
                <button class="tiny mark" :class="{ reset: item.state !== 'ready' }" :disabled="isSending && item.state !== 'ready' && item.state !== 'installed' && item.state !== 'delivered' && item.state !== 'failed'" :title="t(item.state === 'ready' ? 'Отметить как уже установленный' : 'Сбросить статус, чтобы установить заново')" @click="toggleInstalled(item)">{{ t(item.state === 'ready' ? 'Установлено' : 'Сбросить') }}</button>
                <button class="remove" :title="t(&quot;Убрать из списка&quot;)" @click="removePackage(item)">×</button>
              </div>
            </div>
          </div>
        </article>
      </section><section class="path-card"><div><strong>{{ t("Сканировать путь на ПК") }}</strong><p>{{ t("Альтернатива системному выбору папки. PKG никогда не копируются во временный кэш.") }}</p></div><button class="secondary" @click="scanServerFolder">{{ t("Указать путь") }}</button></section><p class="notice">{{ t("Статус «файл полностью передан» подтверждается по HTTP-раздаче пакета. PyLoader не возвращает финальный результат установки. PackageFlowService дополнительно сообщает состояние системного задания и подтверждение установки.") }}</p></section>
    <section v-show="activeSection === 'torrents'" class="content tool-page"><p class="eyebrow">QBITTORRENT</p><h1>{{ t("Загрузки torrent") }}</h1><p class="page-status">{{ t(statusMessage) }}</p><section class="torrent-card"><div class="torrent-head"><div><h2>{{ t("Загрузки torrent") }}</h2><p>{{ t(qbit.ready ? `qBittorrent подключён${qbit.version ? ` · ${qbit.version}` : ''}` : 'Подключите qBittorrent Web UI (на этом ПК или в локальной сети), чтобы добавить разрешённую magnet- или .torrent-ссылку.') }}</p></div><div class="actions"><button class="secondary" @click="refreshTorrents">{{ t("Обновить") }}</button><button class="secondary" @click="toggleTorrentSettings">{{ t("Настроить") }}</button></div></div><form v-if="showTorrentSettings" class="torrent-settings" @submit.prevent="saveTorrentSettings"><label class="wide"><span>{{ t("Адрес qBittorrent Web UI — этот ПК, NAS или другой компьютер в сети") }}</span><input v-model="torrentSettings.baseUrl" placeholder="http://192.168.1.10:8080"></label><label><span>{{ t("Логин") }}</span><input v-model="torrentSettings.username" placeholder="admin" autocomplete="username"></label><label><span>{{ t("Пароль") }}</span><input v-model="torrentSettings.password" type="password" :placeholder="t(qbit.hasPassword ? 'пусто — оставить сохранённый' : '')" autocomplete="current-password"></label><label><span>{{ t("Папка загрузок на этом ПК — отсюда PackageFlow берёт PKG") }}</span><input v-model="torrentSettings.downloadPath" :placeholder="t(&quot;D:\\Torrents или /home/user/Downloads&quot;)"></label><label><span>{{ t("Та же папка в qBittorrent — если он на другом компьютере (необязательно)") }}</span><input v-model="torrentSettings.remotePath" placeholder="/downloads"></label><div class="wide"><button class="primary">{{ t("Сохранить и проверить") }}</button></div></form><form class="torrent-add" @submit.prevent="addTorrent"><input v-model="torrentSource" :disabled="!qbit.ready" :placeholder="t(&quot;Вставьте разрешённую magnet- или HTTPS .torrent-ссылку&quot;)"><label class="torrent-auto"><input v-model="installAfterDownload" type="checkbox" :disabled="!qbit.ready"> {{ t("Установить после загрузки") }}</label><button class="primary" :disabled="!qbit.ready || !torrentSource.trim()">{{ t("Скачать") }}</button></form><p v-if="!torrents.length && qbit.ready" class="empty">{{ t("Нет torrent-задач PackageFlow.") }}</p><div v-for="torrent in torrents" :key="torrent.hash" class="torrent-row"><div class="torrent-name"><strong>{{ torrent.name }}</strong><span>{{ t(formatBytes(torrent.downloaded)) }} {{ t("из") }} {{ t(formatBytes(torrent.size)) }} · {{ t(torrent.seeds) }} {{ t("сидов ·") }} {{ t(formatBytes(torrent.speed)) }}{{ t("/с") }}</span><div class="progress"><i :style="{ width: `${Math.round(torrent.progress * 100)}%` }" /></div></div><span class="torrent-percent">{{ t(Math.round(torrent.progress * 100)) }}%</span><label class="torrent-auto"><input type="checkbox" :checked="torrent.autoInstall" @change="setTorrentAutoInstall(torrent, ($event.target as HTMLInputElement).checked)"> {{ t("Автоустановка") }}</label><button class="tiny" @click="toggleTorrentFiles(torrent)">{{ t(torrentFiles[torrent.hash] ? 'Скрыть файлы' : 'Файлы') }}</button><button class="tiny" @click="controlTorrent(torrent, isTorrentStopped(torrent) ? 'resume' : 'pause')">{{ t(isTorrentStopped(torrent) ? 'Продолжить' : 'Пауза') }}</button><button class="remove" :title="t(&quot;Убрать задачу, не удаляя файлы&quot;)" @click="controlTorrent(torrent, 'delete')">×</button><div v-if="torrentFiles[torrent.hash]" class="torrent-files"><label v-for="file in torrentFiles[torrent.hash]" :key="file.index"><input type="checkbox" :checked="file.priority > 0" @change="setTorrentFile(torrent, file, ($event.target as HTMLInputElement).checked)"><span>{{ file.name }}</span><small>{{ t(formatBytes(file.size)) }} · {{ t(Math.round(file.progress * 100)) }}%</small></label></div></div></section></section><section v-show="activeSection === 'search'" class="content tool-page"><p class="eyebrow">TORZNAB</p><h1>{{ t("Поиск torrent") }}</h1><p class="page-status">{{ t(searchStatus) }}</p><section class="search-card"><div class="search-head"><div><p class="eyebrow">{{ t("РАЗРЕШЁННЫЙ ИСТОЧНИК") }}</p><h2>{{ t("Поиск torrent") }}</h2></div><button class="secondary" @click="showSearchSettings = !showSearchSettings">{{ t("Источник") }}</button></div><form v-if="showSearchSettings" class="search-settings" @submit.prevent="saveSearchSettings"><input v-model="searchSettings.name" :placeholder="t(&quot;Название источника&quot;)"><input v-model="searchSettings.endpoint" placeholder="URL Torznab API"><input v-model="searchSettings.apiKey" type="password" :placeholder="t(searchHasApiKey ? 'API‑ключ сохранён — пусто, чтобы оставить' : 'API‑ключ (если нужен)')"><input v-model="searchSettings.categories" :placeholder="t('Категории: 1180 (PS4)')" :title="t('Категории Torznab: номера через запятую, пусто — все')"><button class="primary">{{ t("Сохранить") }}</button></form><p v-if="showSearchSettings" class="search-note">{{ t("1180 — игры PS4. Пустое поле категорий — поиск по всем платформам.") }}</p><form class="search-form" @submit.prevent="searchTorrents"><input v-model="searchQuery" :disabled="!searchConfigured" :placeholder="t(&quot;Название пакета&quot;)"><button class="primary" :disabled="!searchConfigured || !searchQuery.trim() || searchBusy">{{ t(searchBusy ? 'Ищем…' : 'Найти') }}</button></form><p v-if="!searchConfigured" class="search-note">{{ t("Добавьте разрешённый Torznab‑источник через кнопку «Источник».") }}</p><SearchResults :results="searchResults" :busy="searchBusy" :ready="qbit.ready" :pending="searchDownloadPending" :message="searchDownloadMessage" :visible="activeSection === 'search'" :searched="searchWasRun" @download="downloadSearchResult" /></section></section><section v-show="activeSection === 'log'" class="content tool-page"><p class="eyebrow">{{ t("СОБЫТИЯ СЕРВЕРА") }}</p><h1>{{ t("Журнал") }}</h1><section class="log-card"><div class="log-head"><h2>{{ t("Журнал") }}</h2><p>{{ t("События сервера: запросы PS4, передача пакетов, qBittorrent и ошибки.") }}</p><button class="tiny" :disabled="!logEntries.length" @click="clearLog">{{ t("Очистить") }}</button></div><div ref="logBox" class="log-list"><p v-if="!logEntries.length" class="log-empty">{{ t("Пока событий нет.") }}</p><div v-for="entry in logEntries" :key="entry.id" class="log-line" :class="entry.level"><time>{{ t(logTime(entry.time)) }}</time><span>{{ t(entry.text) }}</span><b v-if="entry.count > 1">×{{ t(entry.count) }}</b></div></div></section></section>
    <section v-if="activeSection === 'donate' && hasDonations" class="content tool-page"><DonatePanel :btc="donationBtc" :usdt-trc20="donationUsdtTrc20" /></section><section v-if="activeSection === 'ftp'" class="content tool-page"><ConsoleFiles :ps-ip="psIp" /></section>
    <section v-if="activeSection === 'console'" class="content tool-page"><ConsoleApps :ip="psIp" @status="consoleConnected = $event" @changed="refreshConsoleLibrary" @saves="openSaves" /></section>
    <section v-if="activeSection === 'saves'" class="content tool-page"><ConsoleSaves :ip="psIp" :focus-title-id="saveFocusTitleId" /></section>
    <section v-if="activeSection === 'system'" class="content tool-page"><SystemInfo :ps-ip="psIp" /></section>
  </main>
  
</template>

<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Manrope:wght@400;500;600;700;800&display=swap');
.topbar > .github-stats { justify-self: start; }
.topbar > .brand { justify-self: center; }
.topbar > .topbar-controls { justify-self: end; display: flex; align-items: center; gap: 14px; }
:root { font-family: Manrope, Arial, sans-serif; color: #e9e8ef; background: #101012; } * { box-sizing: border-box; } body { margin: 0; min-width: 900px; background: radial-gradient(900px 600px at 90% 0, #29204155, transparent 65%), #101012; } button, input { font: inherit; } button { cursor: pointer; } button:disabled { opacity: .42; cursor: not-allowed; }.shell { min-height: 100vh; }.topbar { height: 72px; border-bottom: 1px solid #28272d; padding: 0 24px; display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 20px; align-items: center; background: #151518dd; backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 5; }.brand { font-size: 18px; font-weight: 800; letter-spacing: -.7px; display: flex; align-items: center; gap: 2px; }.brand-logo { display: block; width: auto; height: 52px; object-fit: contain; }.connection { position: relative; display: flex; gap: 8px; align-items: center; color: #9f9fa7; font: 11px 'DM Mono', monospace; }.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #7ec78a; box-shadow: 0 0 0 3px #7ec78a1c; }.status-dot.offline { background: #dc7d72; box-shadow: none; }.ip-button { border: 0; background: #25242a; color: #dad7e8; padding: 7px 9px; border-radius: 5px; font: inherit; }.ip-editor { position: absolute; right: 0; top: 34px; padding: 9px; display: flex; gap: 6px; background: #222127; border: 1px solid #3e3b49; border-radius: 7px; box-shadow: 0 12px 30px #0007; }.ip-editor input { width: 125px; color: white; background: #121216; border: 1px solid #514a6c; border-radius: 4px; padding: 6px; }.ip-editor button, .primary { border: 0; color: white; background: #7967d3; border-radius: 6px; padding: 10px 13px; font-size: 11px; font-weight: 800; }.ip-editor button { padding: 6px; }.primary:hover { background: #8976e4; }.content { max-width: 1240px; padding: 48px 32px 38px; margin: auto; }.intro { display: flex; justify-content: space-between; align-items: end; gap: 25px; margin-bottom: 28px; }.eyebrow { margin: 0 0 9px; color: #978ae1; font-weight: 800; letter-spacing: 1.4px; font-size: 10px; }.intro h1 { margin: 0; font-size: 30px; letter-spacing: -1.2px; }.intro p:not(.eyebrow) { color: #8b8a92; font-size: 12px; margin: 8px 0 0; }.pickers, .actions { display: flex; gap: 9px; }.secondary, .tiny { color: #d8d5e4; background: #28272d; border: 1px solid #3b3941; border-radius: 6px; padding: 10px 12px; font-size: 11px; font-weight: 800; }.secondary:hover:not(:disabled), .tiny:hover:not(:disabled) { background: #35333b; }.hidden { display: none; }.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }.stats article { min-height: 95px; padding: 17px 18px; border: 1px solid #2d2c33; background: linear-gradient(130deg, #1d1c21, #19191c); border-radius: 9px; }.stats span { display: block; color: #85828d; font-size: 9px; font-weight: 800; letter-spacing: 1px; }.stats strong { display: block; margin-top: 8px; font: 700 19px 'DM Mono', monospace; color: #e6e1ff; }.stats small { display: block; margin-top: 4px; color: #7f7e85; font-size: 10px; }.library { overflow: hidden; border: 1px solid #2d2c33; border-radius: 10px; background: #19191c; }.library-head { padding: 21px 22px; display: flex; justify-content: space-between; gap: 20px; align-items: center; border-bottom: 1px solid #2b2a30; }.library h2 { margin: 0; font-size: 15px; }.library-head p { margin: 6px 0 0; max-width: 540px; color: #85838b; font-size: 10px; }.empty { margin: 0; padding: 44px; text-align: center; color: #83818a; font-size: 12px; }.game-group { border-bottom: 1px solid #29282e; }.game-group:last-child { border: 0; }.game-head { display: grid; grid-template-columns: 28px 43px minmax(230px, 1fr) auto; align-items: center; gap: 11px; padding: 11px 20px; background: #1e1d22; }.expand { width: 26px; height: 26px; padding: 0; color: #aaa3cf; border: 0; background: transparent; font-size: 22px; }.expand span { display: inline-block; transition: transform .18s ease; }.expand .open { transform: rotate(90deg); }.game-cover, .cover { overflow: hidden; display: grid; place-items: center; background: linear-gradient(140deg, #7968c8, #42375d); border-radius: 5px; color: #eeeafe; }.game-cover { width: 43px; height: 51px; }.game-cover img, .cover img { width: 100%; height: 100%; object-fit: cover; }.game-cover span { font: 700 19px Georgia, serif; }.game-name { min-width: 0; padding: 0; text-align: left; border: 0; color: inherit; background: transparent; }.game-name strong, .package-name strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }.game-name span, .package-name span { display: block; margin-top: 3px; color: #85828a; font: 10px 'DM Mono', monospace; }.select-all { color: #aaa7b1; font-size: 10px; display: flex; gap: 5px; align-items: center; }.group-actions { display: flex; align-items: center; justify-content: flex-end; gap: 7px; white-space: nowrap; }.tiny { padding: 6px 8px; font-size: 9px; }.package-list { background: #19191c; }.package-row { min-height: 72px; padding: 9px 20px 9px 31px; display: grid; grid-template-columns: 18px 43px minmax(190px, 1fr) 70px 78px minmax(130px, 1.1fr) 78px 86px 22px; gap: 11px; align-items: center; border-top: 1px solid #25242a; }.package-row:hover { background: #202025; }.cover { width: 43px; height: 51px; font-size: 8px; text-align: center; padding: 3px; }.package-name { min-width: 0; }.type { display: inline-block; padding: 4px 6px; border-radius: 4px; text-align: center; font-size: 9px; font-weight: 800; }.type.game { color: #c3b8ff; background: #7968c826; }.type.patch { color: #e3bd77; background: #c6974d25; }.type.backport { color: #70c8d5; background: #3ba5b522; }.type.dlc { color: #9dcd99; background: #78ac7122; }.size { color: #b8b4c0; font: 10px 'DM Mono', monospace; }.state { color: #a09da6; font-size: 9px; line-height: 1.35; }.state.sending, .state.receiving { color: #c4b9ff; }.state.delivered, .state.installed { color: #8dc98c; }.state.failed { color: #e78a80; }.progress { height: 3px; overflow: hidden; margin-top: 7px; background: #393542; border-radius: 3px; }.progress i { display: block; height: 100%; background: linear-gradient(90deg, #7e6ed4, #b8aafb); transition: width .3s ease; }.install-one { padding: 7px 7px; }.mark { color: #a9d6a6; }.remove { padding: 3px; border: 0; background: transparent; color: #77747f; font-size: 20px; }.remove:hover { color: #e48b83; }.path-card { margin-top: 20px; padding: 18px 20px; border: 1px solid #2d2c33; border-radius: 9px; background: #1a1a1d; display: flex; justify-content: space-between; align-items: center; }.path-card strong { font-size: 12px; }.path-card p, .notice { margin: 5px 0 0; color: #817f87; font-size: 10px; }.notice { padding: 0 3px; line-height: 1.5; } @media (max-width: 1050px) { .content { padding: 36px 24px; }.package-row { grid-template-columns: 18px 43px minmax(190px, 1fr) 66px 65px minmax(120px, 1fr) 74px 20px; gap: 8px; }.stats { gap: 8px; }.actions .secondary { display: none; } }
.torrent-card { margin-top: 20px; overflow: hidden; border: 1px solid #2d2c33; border-radius: 10px; background: #19191c; }.torrent-head { padding: 18px 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }.torrent-head h2 { margin: 0; font-size: 14px; }.torrent-head p { margin: 5px 0 0; color: #85838b; font-size: 10px; }.torrent-settings, .torrent-add { display: flex; gap: 8px; padding: 12px 20px; border-top: 1px solid #2b2a30; }.torrent-settings { flex-wrap: wrap; }.torrent-settings input, .torrent-add input { min-width: 160px; flex: 1 1 180px; border: 1px solid #3b3941; border-radius: 6px; color: #e9e8ef; background: #121216; padding: 9px 10px; font-size: 11px; }.torrent-add input { min-width: 0; }.torrent-row { min-height: 66px; padding: 9px 20px; display: grid; grid-template-columns: minmax(200px, 1fr) 44px 78px 22px; gap: 12px; align-items: center; border-top: 1px solid #25242a; }.torrent-name { min-width: 0; }.torrent-name strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }.torrent-name span { display: block; margin-top: 4px; color: #85828a; font: 10px 'DM Mono', monospace; }.torrent-percent { color: #c4b9ff; font: 10px 'DM Mono', monospace; }.torrent-card .empty { padding: 22px; }
.torrent-row { grid-template-columns: minmax(200px, 1fr) 44px 108px 70px 78px 22px; }.torrent-files { grid-column: 1 / -1; display: grid; gap: 5px; padding: 8px 0 2px; border-top: 1px solid #302e36; }.torrent-files label { display: grid; grid-template-columns: 18px minmax(180px, 1fr) 115px; gap: 8px; align-items: center; color: #bab6c4; font-size: 10px; }.torrent-files span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.torrent-files small { color: #89858f; font: 9px 'DM Mono', monospace; text-align: right; }
.torrent-auto { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; color: #c6c2cf; font-size: 10px; white-space: nowrap; }
.search-card { max-width: 1240px; margin: 0 auto 38px; overflow: hidden; border: 1px solid #2d2c33; border-radius: 10px; background: #19191c; }.search-head { padding: 18px 20px; display: flex; justify-content: space-between; align-items: center; }.search-head .eyebrow { margin-bottom: 4px; }.search-head h2 { margin: 0; font-size: 14px; }.search-settings, .search-form { display: flex; gap: 8px; padding: 12px 20px; border-top: 1px solid #2b2a30; }.search-settings { flex-wrap: wrap; }.search-settings input, .search-form input { min-width: 160px; flex: 1; color: #e9e8ef; background: #121216; border: 1px solid #3b3941; border-radius: 6px; padding: 9px 10px; font-size: 11px; }.search-note { padding: 0 20px 16px; color: #85838b; font-size: 10px; }.search-result { display: flex; justify-content: space-between; gap: 14px; align-items: center; padding: 11px 20px; border-top: 1px solid #25242a; }.search-result strong { display: block; font-size: 11px; }.search-result span { color: #85828a; font: 10px 'DM Mono', monospace; }
.state.skipped { color: #e3bd77; }
.log-card { margin-top: 20px; overflow: hidden; border: 1px solid #2d2c33; border-radius: 10px; background: #19191c; }.log-head { padding: 14px 20px; display: flex; align-items: center; gap: 14px; }.log-head p { flex: 1; margin: 0; color: #85838b; font-size: 10px; }.log-toggle { display: flex; align-items: center; gap: 8px; padding: 0; border: 0; background: transparent; color: inherit; }.log-toggle span { display: inline-block; color: #aaa3cf; font-size: 20px; transition: transform .18s ease; }.log-toggle span.open { transform: rotate(90deg); }.log-toggle h2 { margin: 0; font-size: 14px; }.log-badge { padding: 2px 6px; border-radius: 9px; background: #b9534a; color: white; font: 700 9px 'DM Mono', monospace; }.log-list { max-height: 260px; overflow-y: auto; padding: 8px 20px 12px; border-top: 1px solid #2b2a30; font: 10px/1.55 'DM Mono', monospace; }.log-line { display: grid; grid-template-columns: 62px 1fr auto; gap: 10px; padding: 2px 0; color: #bab6c4; }.log-line time { color: #6f6c78; }.log-line span { word-break: break-word; }.log-line b { color: #e3bd77; font-weight: 500; }.log-line.warn span { color: #e3bd77; }.log-line.error span { color: #e78a80; }.log-empty { margin: 6px 0; color: #77747f; }
.danger { border: 0; color: white; background: #b9534a; border-radius: 6px; padding: 10px 13px; font-size: 11px; font-weight: 800; }.danger:hover:not(:disabled) { background: #cc6158; }.mark.reset { color: #e3bd77; }
.sidebar { position: fixed; top: 72px; bottom: 0; left: 0; z-index: 4; width: 196px; padding: 28px 14px; display: flex; flex-direction: column; gap: 6px; background: #17171b; border-right: 1px solid #2d2c33; }
.sidebar-caption { padding: 0 12px 13px; color: #77727f; font: 700 10px 'DM Mono', monospace; letter-spacing: 1px; }
.sidebar button { width: 100%; display: flex; align-items: center; gap: 11px; padding: 11px 12px; border: 0; border-radius: 7px; background: transparent; color: #a9a6b2; text-align: left; font-size: 12px; font-weight: 700; }
.sidebar button span:first-child { width: 19px; text-align: center; color: #a99be8; font-size: 18px; line-height: 1; }
.sidebar button:hover { background: #292630; color: #eee9ff; }.sidebar button.active { background: #403752; color: #f3edff; }
.sidebar-note { margin-top: auto; padding: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-top: 1px solid #2d2c33; color: #77727f; font: 10px 'DM Mono', monospace; }
.shell > .content { max-width: 1436px; padding-left: 228px; }.search-card { max-width: 1208px; margin-left: max(228px, calc((100vw - 1436px) / 2 + 228px)); margin-right: 32px; }
.sidebar button { position: relative; }.nav-badge { margin-left: auto; min-width: 18px; padding: 2px 6px; border-radius: 9px; background: #4b4263; color: #e6e1ff; font: 700 9px 'DM Mono', monospace; text-align: center; }.nav-badge.warn { background: #b9534a; color: white; }.nav-badge.live { background: transparent; color: #7ec78a; font-size: 10px; animation: pulse 1.4s ease-in-out infinite; }@keyframes pulse { 50% { opacity: .35; } }
.page-status { margin: 0 0 4px; color: #85838b !important; font-size: 11px !important; min-height: 16px; }.tool-page .torrent-card, .tool-page .log-card { margin-top: 18px; }.tool-page .search-card { max-width: none; margin: 18px 0 0; }.tool-page .log-list { height: calc(100vh - 300px); max-height: none; min-height: 240px; }
/* In their own sections the page title already names the card. */
.tool-page .torrent-head h2, .tool-page .log-head h2, .tool-page .search-head h2, .tool-page .search-head .eyebrow { display: none; }
.log-head h2 { margin: 0; font-size: 14px; }
.sidebar .donate-link { margin-top: auto; }.sidebar .donate-link span:first-child { color: #e48bb0; }.donate-link + .sidebar-note { margin-top: 0; }
.torrent-settings { display: grid !important; grid-template-columns: 1fr 1fr; gap: 12px 14px !important; }.torrent-settings label { display: flex; flex-direction: column; gap: 5px; min-width: 0; }.torrent-settings label span { color: #9d99a8; font-size: 10px; font-weight: 700; }.torrent-settings input { width: 100%; min-width: 0 !important; flex: none !important; }.torrent-settings .wide { grid-column: 1 / -1; }
@media (max-width: 760px) { .torrent-settings { grid-template-columns: 1fr; } }
.tool-page h1 { margin: 0 0 10px; font-size: 30px; }.tool-page > p:not(.eyebrow) { max-width: 740px; color: #a9a6b2; font-size: 13px; line-height: 1.7; }
.tool-card { max-width: 800px; margin-top: 25px; padding: 24px; border: 1px solid #2d2c33; border-radius: 10px; background: #1b1a1f; }.tool-card h2 { margin: 0 0 14px; font-size: 16px; }.tool-card ol { padding-left: 21px; color: #c9c5d3; font-size: 12px; line-height: 2; }.tool-card p { color: #85838b; font-size: 11px; }
@media (max-width: 1100px) { .sidebar { width: 64px; padding: 28px 7px; align-items: center; }.sidebar-caption, .sidebar-note, .nav-label { display: none; }.sidebar button { justify-content: center; padding: 12px 0; }.nav-badge { position: absolute; top: 4px; right: 4px; min-width: 0; padding: 1px 4px; font-size: 8px; }.shell > .content { padding-left: 88px; }.search-card { margin-left: 88px; } }
.library { overflow: visible; }
.game-name .group-current, .game-name .group-pending, .game-name .group-skipped { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.game-name .group-current { color: #b9aafa; font-weight: 700; }
.game-name .group-pending { color: #a5a2ae; }
.game-name .group-skipped { color: #e3bd77; }
.package-row { position: relative; display: flex; flex-wrap: wrap; gap: 10px; min-width: 0; }
.package-row:hover, .package-row:focus-within { z-index: 2; }
.package-row > input[type="checkbox"] { flex: 0 0 18px; }
.package-row > .cover { flex: 0 0 43px; }
.package-row > .package-name { flex: 1 1 190px; min-width: 130px; }
.package-row > .package-type-wrap { position: relative; display: flex; flex: 0 0 70px; }
.package-type-wrap > .type { width: 100%; border: 0; cursor: help; }
.package-type-wrap > .type:focus-visible { outline: 2px solid #b7a9ff; outline-offset: 2px; }
.package-metadata-popover { display: none; position: fixed; top: 80px; left: 8px; z-index: 20; width: min(460px, calc(100vw - 32px)); padding: 14px 16px; border: 1px solid #63577f; border-radius: 8px; background: #26232e; box-shadow: 0 12px 32px #000a; color: #e9e5f3; text-align: left; }
.package-type-wrap:hover .package-metadata-popover, .package-type-wrap:focus-within .package-metadata-popover { display: block; }
.package-metadata-popover > strong { display: block; margin-bottom: 10px; font-size: 12px; }
.package-metadata-popover dl { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 7px 10px; margin: 0; font-size: 11px; line-height: 1.4; }
.package-metadata-popover dt { color: #aaa3bc; }
.package-metadata-popover dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-family: 'DM Mono', monospace; }
.package-row > .size { flex: 0 0 64px; }
.package-row > .state { flex: 1 1 120px; min-width: 120px; }
.package-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; max-width: 100%; margin-left: auto; }
.package-actions > button { flex: none; white-space: nowrap; }
.package-actions .remove { min-width: 24px; }
.files-page{max-width:1100px;margin:0 auto;padding:32px 20px 70px;color:#f1eff8}
.files-page .eyebrow{color:#a692f2;font-size:11px;font-weight:800;letter-spacing:1.4px}
.files-page h1{margin:8px 0;font-size:32px}
.files-page .description,.files-page .hint{color:#aaa5b7;font-size:13px;line-height:1.6}
.files-page .toolbar,.files-page .crumbs,.files-page .listing,.files-page .message{margin-top:18px;border:1px solid #34313c;border-radius:10px;background:#1c1a21}
.files-page .toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px}
.files-page .roots,.files-page .actions{display:flex;flex-wrap:wrap;gap:8px}
.files-page button,.files-page a{color:#e7e0fa;cursor:pointer}
.files-page button:disabled{opacity:.5;cursor:default}
.files-page .roots button,.files-page .actions button,.files-page .transfer button,.files-page .more{padding:9px 12px;border:1px solid #484154;border-radius:6px;background:#2a2631;font-size:12px}
.files-page .roots .active{background:#493961;border-color:#8367ac}
.files-page .hidden{display:none}
.files-page .crumbs{display:flex;flex-wrap:wrap;gap:4px;padding:10px 14px}
.files-page .crumbs button{border:0;background:transparent;color:#bfaefa;padding:4px}
.files-page .crumbs button:not(:last-child)::after{content:' /';color:#706b7a}
.files-page .message{padding:14px 18px;font-size:13px}
.files-page .error{border-color:#906651;color:#f0bc90}
.files-page .transfer{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.files-page .transfer progress{flex:1;min-width:150px;accent-color:#9d83da}
.files-page .listing{overflow:hidden}
.files-page .heading,.files-page .row{display:grid;grid-template-columns:minmax(210px,1fr) 110px 180px 80px;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid #302d36;font-size:12px}
.files-page .heading{color:#948ca2;font-size:11px}
.files-page .row span:not(.name){color:#a6a0af}
.files-page .name{min-width:0;overflow-wrap:anywhere;text-align:left}
.files-page .row button.name{border:0;background:none;padding:0}
.files-page .row a{color:#baa7f7}
.files-page .empty{padding:30px 16px;color:#aaa5b7;font-size:13px}
.files-page .more{margin:14px 16px}
.files-page .hint{margin-top:14px}
@media(max-width:720px){.files-page .toolbar{align-items:flex-start;flex-direction:column}.files-page .heading{display:none}.files-page .row{grid-template-columns:minmax(0,1fr) auto}.files-page .row span:nth-child(3){display:none}}
</style>

<script setup lang="ts">
const { t, formatLocale } = useAppLocale()

import type { ConsoleFileJob, ConsoleTrashItem } from '../../shared/types/console-files'
const props = defineProps<{ psIp: string }>()
const packageInstaller = ref<{ open: (path: string) => Promise<void> }>(), packageBusy = ref(false), localInstall = ref(false)
interface Entry { name: string; type: 'file' | 'directory' | 'link'; size: number; mtime: number }
interface Listing { entries: Entry[]; nextOffset: number; hasMore: boolean }
interface TextFile { path: string; text: string; revision: string; digest: string; writable: boolean }
interface Transfer { file: File; ip: string; directory: string; id: string; key: string; replace: boolean; revision?: string }
type Dialog = { kind: 'mkdir' | 'rename' | 'trash' | 'restore' | 'overwrite' | 'editor' | 'delete' | 'purge'; ip: string; paths: string[]; name: string; trashId?: string; trashIds?: string[]; file?: File; revision?: string; original?: TextFile; text?: string }
const path = ref('/user'), entries = ref<Entry[]>([]), offset = ref(0), hasMore = ref(false)
const busy = ref(false), actionBusy = ref(false), error = ref(''), api = ref(1), permanentDelete = ref(false)
const fileInput = ref<HTMLInputElement>(), modal = ref<HTMLDialogElement>(), dialog = ref<Dialog>()
const selectedNames = ref<string[]>([]), clipboard = ref<{ ip: string; action: 'copy' | 'move'; paths: string[] }>()
const transfer = ref<Transfer>(), uploadOffset = ref(0), uploading = ref(false), paused = ref(false)
const jobs = ref<ConsoleFileJob[]>([]), trash = ref<ConsoleTrashItem[]>([]), showTrash = ref(false), showHistory = ref(false)
interface Notification { id: string; title: string; detail?: string; attention: boolean }
const notifications = ref<Notification[]>([])
const notificationTimers = new Map<string, ReturnType<typeof setTimeout>>()
const submittedJobs = new Set<string>()
let jobsLoaded = false
const activeJobs = computed(() => jobs.value.filter(j => ['planning', 'running'].includes(j.state)))
const historyJobs = computed(() => jobs.value.filter(j => !['planning', 'running'].includes(j.state)))
const needsAttention = computed(() => historyJobs.value.filter(j => ['paused', 'failed'].includes(j.state)).length)
function dismissNotification(id: string) {
  clearTimeout(notificationTimers.get(id)); notificationTimers.delete(id)
  notifications.value = notifications.value.filter(n => n.id !== id)
}
function clearNotifications() {
  for (const timer of notificationTimers.values()) clearTimeout(timer)
  notificationTimers.clear(); notifications.value = []
}
function notify(title: string, detail?: string, attention = false) {
  const id = transferId()
  notifications.value.push({ id, title, detail, attention })
  while (notifications.value.length > 3) dismissNotification(notifications.value[0]!.id)
  notificationTimers.set(id, setTimeout(() => dismissNotification(id), attention ? 10000 : 5000))
}
let controller: AbortController | undefined, pollTimer: ReturnType<typeof setInterval> | undefined, polling = false
const writable = computed(() => /^(?:\/data|\/mnt\/usb[0-7])(?:\/|$)/.test(path.value) && !path.value.split('/').some(p => ['PackageFlowService', 'PackegeFlowService'].includes(p)))
const running = computed(() => jobs.value.some(j => ['planning', 'running'].includes(j.state)))
const locked = computed(() => uploading.value || actionBusy.value || running.value || packageBusy.value)
const selectedEntries = computed(() => entries.value.filter(e => selectedNames.value.includes(e.name)))
const editable = (e: Entry) => e.type === 'file' && e.size <= 128 * 1024 && /\.(?:txt|json|ini|cfg|conf|xml|ya?ml|log|csv|md)$/i.test(e.name)
const entryPath = (name: string) => `${path.value === '/' ? '' : path.value}/${name}`
const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean)
  return [{ name: '/', path: '/' }, ...parts.map((name, index) => ({ name, path: '/' + parts.slice(0, index + 1).join('/') }))]
})
const message = (cause: unknown) => { const issue = cause as { data?: { message?: string }; message?: string }; return issue.data?.message || issue.message || 'Нет ответа от PS4' }
const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} Б` : bytes < 1024 ** 2 ? `${(bytes / 1024).toLocaleString(formatLocale.value, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })} КБ` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toLocaleString(formatLocale.value, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })} МБ` : `${(bytes / 1024 ** 3).toLocaleString(formatLocale.value, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })} ГБ`
const actionLabel: Record<string, string> = { mkdir: 'Создание папки', rename: 'Переименование', copy: 'Копирование', move: 'Перемещение', trash: 'Перенос в корзину', restore: 'Возврат из корзины', replace: 'Замена файла', delete: 'Удаление без корзины', purge: 'Удаление из корзины' }
const stateLabel: Record<string, string> = { planning: 'Подготовка', running: 'Выполняется', paused: 'Приостановлено', completed: 'Завершено', failed: 'Не завершено' }
async function load(more = false) {
  if (busy.value) return
  busy.value = true; error.value = ''
  const ip = props.psIp, directory = path.value
  try {
    const page = await $fetch<Listing>('/api/ps4/files/list', { method: 'POST', body: { ip, path: directory, offset: more ? offset.value : 0 } })
    if (ip === props.psIp && directory === path.value) {
      entries.value = more ? [...entries.value, ...page.entries] : page.entries
      offset.value = page.nextOffset; hasMore.value = page.hasMore
      if (!more) selectedNames.value = []
    }
  } catch (cause) { if (ip === props.psIp && directory === path.value) error.value = message(cause) }
  finally { busy.value = false; if (ip !== props.psIp || directory !== path.value) void load() }
}
async function poll() {
  if (polling) return
  polling = true; const ip = props.psIp
  try {
    const result = await $fetch<{ jobs: ConsoleFileJob[]; trash: ConsoleTrashItem[] }>('/api/ps4/files/operations', { method: 'POST', body: { ip } })
    if (ip !== props.psIp) return
    const changes = result.jobs.filter(j => !['planning', 'running'].includes(j.state) &&
      (jobsLoaded || submittedJobs.has(j.id)) && (submittedJobs.has(j.id) || jobs.value.find(old => old.id === j.id)?.state !== j.state))
    for (const job of changes) {
      notify(`${actionLabel[job.action]} · ${stateLabel[job.state]}`, job.error || (job.action === 'mkdir' ? `Папка ${job.paths[0]}` : job.paths.map(p => p.split('/').pop()).join(', ')), job.state !== 'completed')
      submittedJobs.delete(job.id)
    }
    jobs.value = result.jobs; trash.value = result.trash; jobsLoaded = true
    if (changes.some(j => j.state === 'completed')) void load()
  } catch (cause) { if (ip === props.psIp && running.value) error.value = message(cause) }
  finally { polling = false }
}
async function checkApi() {
  const ip = props.psIp; api.value = 1; localInstall.value = false; permanentDelete.value = false
  try { const cap = await $fetch<{ fileApi: number; localInstall?: boolean; permanentDelete?: boolean }>('/api/ps4/files/capabilities', { method: 'POST', body: { ip } }); if (ip === props.psIp) { api.value = cap.fileApi; localInstall.value = cap.localInstall === true; permanentDelete.value = cap.permanentDelete === true } }
  catch (cause) { if (ip === props.psIp) error.value = message(cause) }
}
function navigate(next: string) {
  if (uploading.value) return
  path.value = next; entries.value = []; selectedNames.value = []; offset.value = 0; hasMore.value = false
  void load()
}
function downloadUrl(name: string) { return `/api/ps4/files/download?ip=${encodeURIComponent(props.psIp)}&path=${encodeURIComponent(entryPath(name))}` }
function transferId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < 16; ++i) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
async function openDialog(d: Dialog) { dialog.value = d; await nextTick(); modal.value?.showModal() }
function closeDialog() { if (actionBusy.value) return; modal.value?.close(); dialog.value = undefined }
function ask(kind: 'mkdir' | 'rename' | 'trash' | 'delete') {
  const paths = kind === 'mkdir' ? [path.value] : selectedEntries.value.map(e => entryPath(e.name))
  void openDialog({ kind, ip: props.psIp, paths, name: kind === 'rename' ? selectedEntries.value[0]?.name || '' : '' })
}
function askPurge(items: ConsoleTrashItem[]) {
  if (!items.length || items.some(t => t.purging)) return
  void openDialog({ kind: 'purge', ip: props.psIp, paths: items.map(t => t.original), trashIds: items.map(t => t.id), name: '' })
}
function putClipboard(action: 'copy' | 'move') {
  clipboard.value = { ip: props.psIp, action, paths: selectedEntries.value.map(e => entryPath(e.name)) }
  selectedNames.value = []
}
async function operation(body: Record<string, unknown>, ip = props.psIp) {
  if (actionBusy.value) return
  actionBusy.value = true; error.value = ''
  try {
    const job = await $fetch<ConsoleFileJob>('/api/ps4/files/operation', { method: 'POST', body: { ip, ...body } })
    if (ip === props.psIp) submittedJobs.add(job.id)
    if (ip === props.psIp) { modal.value?.close(); dialog.value = undefined; selectedNames.value = []; await poll() }
  } catch (cause) { if (ip === props.psIp) error.value = message(cause) }
  finally { actionBusy.value = false }
}
async function paste() {
  const c = clipboard.value
  if (!c || c.ip !== props.psIp || !writable.value) return
  await operation({ action: c.action, paths: c.paths, destination: path.value }, c.ip)
  if (!error.value) clipboard.value = undefined
}
async function openEditor(item: Entry) {
  const ip = props.psIp, file = entryPath(item.name); actionBusy.value = true; error.value = ''
  try {
    const original = await $fetch<TextFile>('/api/ps4/files/text', { method: 'POST', body: { ip, action: 'read', path: file } })
    if (ip === props.psIp) await openDialog({ kind: 'editor', ip, paths: [file], name: item.name, original, text: original.text })
  } catch (cause) { if (ip === props.psIp) error.value = message(cause) }
  finally { actionBusy.value = false }
}
async function confirmDialog() {
  const d = dialog.value; if (!d || actionBusy.value || d.ip !== props.psIp) return
  if (d.kind === 'overwrite') { const file = d.file!; modal.value?.close(); dialog.value = undefined; beginUpload(file, true, d.revision); return }
  if (d.kind === 'editor') {
    actionBusy.value = true; error.value = ''
    try {
      const result = await $fetch<ConsoleFileJob | { unchanged: true }>('/api/ps4/files/text', { method: 'POST', body: { ip: d.ip, action: 'save', path: d.paths[0], text: d.text, revision: d.original!.revision, digest: d.original!.digest } })
      if (d.ip === props.psIp && 'id' in result) submittedJobs.add(result.id)
      if (d.ip === props.psIp) { modal.value?.close(); dialog.value = undefined; await poll() }
    } catch (cause) { if (d.ip === props.psIp) error.value = message(cause) }
    finally { actionBusy.value = false }
    return
  }
  await operation({ action: d.kind, paths: d.paths, name: d.name, trashId: d.trashId, trashIds: d.trashIds, ...(['delete', 'purge'].includes(d.kind) ? { confirmPermanent: true } : {}) }, d.ip)
}
async function selectFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return
  const ip = props.psIp, destination = entryPath(file.name); error.value = ''; actionBusy.value = true
  try {
    let existing: { revision: string; type: string } | undefined
    try { existing = await $fetch('/api/ps4/files/stat', { method: 'POST', body: { ip, path: destination } }) }
    catch (cause: any) { if (cause.statusCode !== 404 && cause.status !== 404) throw cause }
    if (ip !== props.psIp) return
    if (existing) {
      if (api.value < 2) throw new Error('Для замены файла обновите службу до PKG 1.52')
      if (existing.type !== 'file') throw new Error('Имя занято папкой')
      await openDialog({ kind: 'overwrite', ip, paths: [destination], name: file.name, file, revision: existing.revision })
    } else beginUpload(file, false)
  } catch (cause) { if (ip === props.psIp) error.value = message(cause) }
  finally { actionBusy.value = false }
}
function beginUpload(file: File, replace: boolean, revision?: string) {
  const key = `packageflow:upload:${props.psIp}:${entryPath(file.name)}:${file.size}:${file.lastModified}:${replace ? revision : 'new'}`
  const id = localStorage.getItem(key) || transferId(); localStorage.setItem(key, id)
  transfer.value = { file, ip: props.psIp, directory: path.value, id, key, replace, revision }; uploadOffset.value = 0; void upload()
}
function pause() { paused.value = true; controller?.abort() }
async function upload() {
  const t = transfer.value; if (!t || uploading.value || t.ip !== props.psIp) return
  uploading.value = true; paused.value = false; error.value = ''
  const destination = `${t.directory}/${t.file.name}`
  const controlBody = { ip: t.ip, path: destination, id: t.id, replace: t.replace, revision: t.revision }
  try {
    const session = await $fetch<{ offset: number; chunkSize?: number }>('/api/ps4/files/upload/start', { method: 'POST', body: { ...controlBody, size: t.file.size } })
    if (!Number.isSafeInteger(session.offset) || session.offset < 0 || session.offset > t.file.size) throw new Error('PS4 вернула неверную позицию файла')
    uploadOffset.value = session.offset
    const chunkSize = Number.isSafeInteger(session.chunkSize) && session.chunkSize! >= 256 * 1024 && session.chunkSize! <= 4 * 1024 * 1024 ? session.chunkSize! : 256 * 1024
    while (uploadOffset.value < t.file.size && !paused.value && t.ip === props.psIp) {
      const start = uploadOffset.value, part = t.file.slice(start, Math.min(start + chunkSize, t.file.size))
      controller = new AbortController()
      const response = await fetch(`/api/ps4/files/upload/chunk?ip=${encodeURIComponent(t.ip)}&id=${t.id}&offset=${start}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: part, signal: controller.signal })
      if (!response.ok) throw new Error(`PS4 не приняла фрагмент (${response.status})`)
      const progress = await response.json() as { offset: number }
      if (progress.offset !== start + part.size) throw new Error('PS4 вернула неверную позицию файла')
      uploadOffset.value = progress.offset
    }
    if (!paused.value && t.ip === props.psIp) {
      const result = await $fetch<{ id?: string }>('/api/ps4/files/upload/finish', { method: 'POST', body: controlBody })
      if (t.replace && result.id) submittedJobs.add(result.id)
      localStorage.removeItem(t.key); transfer.value = undefined
      if (fileInput.value) fileInput.value.value = ''
      if (!t.replace) notify('Файл загружен', t.file.name)
      await poll(); await load()
    }
  } catch (cause) { if (!paused.value && t.ip === props.psIp) error.value = `${message(cause)}. Выберите тот же файл для продолжения.` }
  finally { controller = undefined; uploading.value = false }
}
onMounted(() => { void load(); void checkApi(); void poll(); pollTimer = setInterval(() => void poll(), 2000) })
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer); clearNotifications(); pause() })
watch(() => props.psIp, () => {
  pause(); transfer.value = undefined; clipboard.value = undefined; modal.value?.close(); dialog.value = undefined
  clearNotifications(); submittedJobs.clear(); jobsLoaded = false; showHistory.value = false; showTrash.value = false
  entries.value = []; selectedNames.value = []; jobs.value = []; trash.value = []; offset.value = 0; hasMore.value = false
  void checkApi(); void poll(); if (!busy.value) void load()
})
</script>

<template>
  <section class="files-page">
    <p class="eyebrow">PLAYSTATION 4 · {{ psIp }}</p>
    <h1>{{ t("Файлы консоли") }}</h1>
    <p class="description">{{ t("Папки и файлы PS4 через PackageFlowService. Передачу можно продолжить после обрыва связи.") }}</p>
    <div v-if="api < 2" class="message">{{ t("Просмотр и загрузка доступны. Для новых операций обновите PackageFlowService до PKG 1.52.") }} <button type="button" @click="checkApi">{{ t("Проверить версию") }}</button></div>
    <div class="toolbar">
      <div class="roots"><button v-for="root in ['/', '/user', '/data', '/mnt/usb0']" :key="root" type="button" :disabled="uploading" :class="{ active: path === root }" @click="navigate(root)">{{ t(root) }}</button></div>
      <div class="actions">
        <input ref="fileInput" class="hidden" type="file" @change="selectFile">
        <button type="button" :disabled="!writable || locked" @click="fileInput?.click()">{{ t("Загрузить файл") }}</button>
        <button type="button" :disabled="!writable || locked || api < 2" @click="ask('mkdir')">{{ t("Новая папка") }}</button>
        <button type="button" :disabled="busy" @click="load()">{{ t("Обновить") }}</button>
        <button type="button" :aria-expanded="showHistory" :class="{ attention: needsAttention }" :title="t(needsAttention ? `Требуют внимания: ${needsAttention}` : undefined)" @click="showHistory = !showHistory">{{ t("История операций") }}<span v-if="needsAttention" class="attention-count">{{ t(needsAttention) }}</span></button>
        <button type="button" :aria-expanded="showTrash" @click="showTrash = !showTrash">{{ t("Корзина") }} <span v-if="trash.length">({{ t(trash.length) }})</span></button>
      </div>
    </div>
    <nav class="crumbs" :aria-label="t(&quot;Путь&quot;)"><button v-for="item in crumbs" :key="item.path" type="button" :disabled="uploading" @click="navigate(item.path)">{{ item.name }}</button></nav>
    <div class="selection-bar actions">
      <label><input type="checkbox" :checked="!!entries.length && selectedNames.length === entries.filter(e => e.type !== 'link').length" :disabled="locked || api < 2" @change="selectedNames = ($event.target as HTMLInputElement).checked ? entries.filter(e => e.type !== 'link').map(e => e.name) : []"> {{ t("Выбрать видимые") }}</label>
      <span>{{ t("Выбрано:") }} {{ t(selectedNames.length) }}</span>
      <button type="button" :disabled="!selectedNames.length || locked || api < 2" @click="putClipboard('copy')">{{ t("Копировать") }}</button>
      <button type="button" :disabled="!selectedNames.length || !writable || locked || api < 2" @click="putClipboard('move')">{{ t("Переместить") }}</button>
      <button type="button" :disabled="selectedNames.length !== 1 || !writable || locked || api < 2" @click="ask('rename')">{{ t("Переименовать") }}</button>
      <button type="button" class="danger" :disabled="!selectedNames.length || !writable || locked || api < 2" @click="ask('trash')">{{ t("В корзину") }}</button>
      <button type="button" class="danger" :disabled="!selectedNames.length || !writable || locked || !permanentDelete" :title="t(permanentDelete ? 'Удалить выбранное без возможности возврата' : 'Нужен PackageFlowService 1.55')" @click="ask('delete')">{{ t("Удалить") }}</button>
    </div>
    <div v-if="clipboard" class="message clipboard">
      <span>{{ t(clipboard.action === 'copy' ? 'Копировать' : 'Переместить') }} {{ t(clipboard.paths.length) }} {{ t("эл. Откройте папку назначения и нажмите «Вставить».") }}</span>
      <button type="button" :disabled="!writable || locked" @click="paste">{{ t("Вставить сюда") }}</button><button type="button" @click="clipboard = undefined">{{ t("Отменить выбор") }}</button>
    </div>
    <div v-if="error" class="message error" role="alert">{{ t(error) }}</div>
    <div v-if="transfer" class="message transfer">
      <strong>{{ transfer.file.name }}</strong><span>{{ t(sizeLabel(uploadOffset)) }} {{ t("из") }} {{ t(sizeLabel(transfer.file.size)) }}</span>
      <progress :value="transfer.file.size ? uploadOffset / transfer.file.size * 100 : 0" max="100" />
      <button v-if="uploading" type="button" @click="pause">{{ t("Пауза") }}</button><button v-else type="button" :disabled="locked" @click="upload">{{ t("Продолжить") }}</button>
    </div>
    <div v-for="job in activeJobs" :key="job.id" class="message file-job" :class="{ error: job.state === 'failed' }" role="status">
      <strong>{{ t(actionLabel[job.action]) }} · {{ t(stateLabel[job.state]) }}</strong>
      <span>{{ t(job.done) }} {{ t("из") }} {{ t(job.total) }} {{ t("операций") }}<template v-if="job.totalBytes"> · {{ t(sizeLabel(job.bytes)) }} / {{ t(sizeLabel(job.totalBytes)) }}</template></span>
      <span v-if="job.current" class="job-path">{{ t(job.current) }}</span><span v-if="job.error">{{ t(job.error) }}</span>
      <progress v-if="['planning', 'running', 'paused'].includes(job.state)" :value="job.totalBytes ? job.bytes : job.done" :max="job.totalBytes || job.total || 1" />
      <button v-if="job.state === 'running' && ['copy', 'move'].includes(job.action)" type="button" :disabled="actionBusy" @click="operation({ action: 'pause', id: job.id })">{{ t("Пауза") }}</button>
      <button v-if="['paused', 'failed'].includes(job.state)" type="button" :disabled="locked" @click="operation({ action: 'resume', id: job.id })">{{ t("Продолжить проверку") }}</button>
    </div>
    <ConsoleFileInstaller ref="packageInstaller" :ps-ip="psIp" :show-history="showHistory" @busy="packageBusy = $event" @notice="notify" />
    <section v-if="showHistory" class="history-panel message">
      <div class="panel-title"><h2>{{ t("История операций") }}</h2><button type="button" @click="showHistory = false" :aria-label="t(&quot;Закрыть историю операций&quot;)">×</button></div>
      <p v-if="!historyJobs.length">{{ t("Завершённых операций пока нет") }}</p>
      <div class="history-list">
        <div v-for="job in historyJobs" :key="job.id" class="history-row" :class="{ error: job.state === 'failed' }">
          <div><strong>{{ t(actionLabel[job.action]) }} · {{ t(stateLabel[job.state]) }}</strong><span>{{ t(new Date(job.createdAt).toLocaleString(formatLocale)) }} · {{ t(job.done) }} {{ t("из") }} {{ t(job.total) }} {{ t("операций") }}</span><span v-if="job.error">{{ t(job.error) }}</span><span class="job-path">{{ job.paths.join(', ') || job.destination }}</span></div>
          <button v-if="['paused', 'failed'].includes(job.state)" type="button" :disabled="locked" @click="operation({ action: 'resume', id: job.id })">{{ t("Продолжить проверку") }}</button>
        </div>
      </div>
    </section>
    <div class="file-notifications" :aria-label="t(&quot;Уведомления файловых операций&quot;)">
      <div v-for="item in notifications" :key="item.id" class="file-notification" :class="{ attention: item.attention }" :role="item.attention ? 'alert' : 'status'">
        <div><strong>{{ t(item.title) }}</strong><span v-if="item.detail">{{ t(item.detail) }}</span><button v-if="item.attention" type="button" @click="showHistory = true; dismissNotification(item.id)">{{ t("Открыть историю") }}</button></div>
        <button type="button" class="notification-close" @click="dismissNotification(item.id)" :aria-label="t(`Скрыть уведомление: ${item.title}`)">×</button>
      </div>
    </div>
    <section v-if="showTrash" class="trash-panel message">
      <div class="panel-title"><h2>{{ t("Корзина и предыдущие версии") }}</h2><button type="button" class="danger" :disabled="locked || !permanentDelete || !trash.length || trash.some(t => t.purging)" @click="askPurge(trash)">{{ t("Очистить корзину") }}</button></div><p>{{ t("Копии остаются на том же диске PS4 и занимают место. Для возврата подключите исходный USB, если он использовался.") }}</p>
      <p v-if="!trash.length">{{ t("Корзина пуста") }}</p>
      <div v-for="item in trash" :key="item.id" class="trash-row">
        <div><strong>{{ item.original }}</strong><span>{{ t(item.reason === 'replaced' ? 'Перед заменой файла' : item.reason === 'moved' ? 'После перемещения на другой диск' : 'Удалено в корзину') }} · {{ t(new Date(item.createdAt).toLocaleString(formatLocale)) }}</span></div>
        <span v-if="item.purging" class="warning">{{ t("Удаление начато — продолжите задание в истории") }}</span>
        <div class="trash-actions"><button type="button" :disabled="locked || api < 2 || !!item.purging" @click="openDialog({ kind: 'restore', ip: psIp, paths: [item.original], name: '', trashId: item.id })">{{ t("Вернуть") }}</button><button type="button" class="danger" :disabled="locked || !permanentDelete || !!item.purging" @click="askPurge([item])">{{ t("Удалить") }}</button></div>
      </div>
    </section>
    <div class="listing">
      <div class="heading"><span></span><span>{{ t("Название") }}</span><span>{{ t("Размер") }}</span><span>{{ t("Изменён") }}</span><span>{{ t("Действия") }}</span></div>
      <div v-if="busy && !entries.length" class="empty">{{ t("Читаем папку…") }}</div>
      <div v-else-if="!entries.length" class="empty">{{ t(error ? 'Список недоступен' : 'Папка пуста') }}</div>
      <div v-for="item in entries" :key="item.name" class="row">
        <input v-model="selectedNames" type="checkbox" :value="item.name" :disabled="locked || api < 2 || item.type === 'link'" :aria-label="t(`Выбрать ${item.name}`)">
        <button v-if="item.type === 'directory'" class="name" type="button" :disabled="uploading" @click="navigate(entryPath(item.name))">📁 {{ item.name }}</button>
        <span v-else class="name">{{ t(item.type === 'link' ? '🔗' : '📄') }} {{ item.name }}</span>
        <span>{{ t(item.type === 'file' ? sizeLabel(item.size) : '—') }}</span>
        <span>{{ t(item.mtime ? new Date(item.mtime * 1000).toLocaleString(formatLocale) : '—') }}</span>
        <div class="row-actions"><button v-if="item.type === 'file' && /\.pkg$/i.test(item.name)" type="button" :disabled="locked || !localInstall" :title="t(localInstall ? 'Установить PKG с диска PS4' : 'Нужен PackageFlowService 1.54')" @click="packageInstaller?.open(entryPath(item.name))">{{ t("Установить") }}</button><a v-if="item.type === 'file'" :href="downloadUrl(item.name)">{{ t("Скачать") }}</a><button v-if="editable(item) && api >= 2" type="button" :disabled="locked" @click="openEditor(item)">{{ t("Открыть") }}</button></div>
      </div>
      <button v-if="hasMore" class="more" type="button" :disabled="busy" @click="load(true)">{{ t("Показать ещё") }}</button>
    </div>
    <p class="hint">{{ t("Изменения доступны в /data и на USB. Системные области — только для чтения. Игры удаляйте через «На консоли», сохранениями управляйте в «Сохранениях». Корзина хранится на PS4; её список — в данных WEB.") }}</p>
    <dialog ref="modal" class="file-dialog" @cancel.prevent="closeDialog">
      <form v-if="dialog" @submit.prevent="confirmDialog">
        <h2>{{ t(['delete', 'purge'].includes(dialog.kind) ? 'Удалить безвозвратно?' : dialog.kind === 'editor' ? dialog.name : dialog.kind === 'overwrite' ? 'Заменить файл?' : dialog.kind === 'restore' ? 'Вернуть из корзины?' : dialog.kind === 'trash' ? 'Перенести в корзину?' : dialog.kind === 'mkdir' ? 'Новая папка' : 'Переименовать') }}</h2>
        <p>PS4 {{ t(dialog.ip) }}</p>
        <ul v-if="['trash', 'restore', 'overwrite', 'delete', 'purge'].includes(dialog.kind)" class="confirmation-paths"><li v-for="(p, index) in dialog.paths" :key="index">{{ t(p) }}</li></ul>
        <p v-if="['delete', 'purge'].includes(dialog.kind)" class="permanent-warning">{{ t(dialog.kind === 'purge' ? 'Выбранные копии из корзины' : 'Выбранные файлы и папки со всем содержимым') }} {{ t("будут удалены с PS4 безвозвратно. Вернуть их через корзину будет нельзя. Элементов:") }} {{ t(dialog.paths.length) }}.</p>
        <p v-if="dialog.kind === 'trash'">{{ t("Выбранные элементы будут перемещены в корзину. Их можно вернуть на прежнее место.") }}</p>
        <p v-if="dialog.kind === 'overwrite'">{{ t("Предыдущая версия останется в «Корзине и предыдущих версиях».") }}</p>
        <p v-if="dialog.kind === 'restore'">{{ t("Исходное имя должно быть свободно. Существующий файл не будет заменён.") }}</p>
        <label v-if="['mkdir', 'rename'].includes(dialog.kind)">{{ t("Название") }}<input v-model="dialog.name" autofocus required maxlength="200" :disabled="actionBusy"></label>
        <template v-if="dialog.kind === 'editor'">
          <p>{{ t(dialog.paths[0]) }}</p><textarea v-model="dialog.text" spellcheck="false" :readonly="!dialog.original?.writable || actionBusy" :aria-label="t(&quot;Содержимое текстового файла&quot;)" />
          <p>{{ t(dialog.original?.writable ? 'Перед сохранением проверим изменения и сохраним предыдущую версию.' : 'Этот путь доступен только для чтения.') }}</p>
        </template>
        <div v-if="error" class="error dialog-error" role="alert">{{ t(error) }}</div>
        <div class="dialog-actions"><button type="button" :disabled="actionBusy" @click="closeDialog">{{ t(dialog.kind === 'editor' ? 'Закрыть' : 'Отмена') }}</button><button v-if="dialog.kind !== 'editor' || dialog.original?.writable" type="submit" :class="{ 'permanent-button': ['delete', 'purge'].includes(dialog.kind) }" :disabled="actionBusy || (dialog.kind === 'editor' && dialog.text === dialog.original?.text)">{{ t(actionBusy ? 'Проверяем…' : ['delete', 'purge'].includes(dialog.kind) ? 'Удалить безвозвратно' : dialog.kind === 'editor' ? 'Сохранить' : dialog.kind === 'trash' ? 'В корзину' : dialog.kind === 'overwrite' ? 'Заменить' : dialog.kind === 'restore' ? 'Вернуть' : 'Применить') }}</button></div>
      </form>
    </dialog>
  </section>
</template>

<style scoped>
.trash-actions{display:flex!important;flex-direction:row!important;gap:8px;flex-shrink:0}.message .danger{color:#efb3ac}.file-dialog .permanent-warning{color:#efb3ac}.dialog-actions .permanent-button[type=submit]{background:#973e42}
.selection-bar{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin:16px 0;font-size:12px}.selection-bar label{display:flex;align-items:center;gap:7px}.selection-bar input,.row input{accent-color:#a692f2}
.selection-bar button,.message button,.row-actions button,.file-dialog button{padding:8px 12px;border:1px solid #484154;border-radius:6px;background:#2a2631;color:#e7e0fa;font-size:12px;cursor:pointer}.selection-bar .danger{color:#efb3ac}.clipboard{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.files-page .heading,.files-page .row{grid-template-columns:22px minmax(180px,1fr) 100px 160px 210px}.row-actions{display:flex;align-items:center;gap:12px}.row-actions button{padding:5px 8px}.file-job{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px}.job-path{width:100%;overflow-wrap:anywhere;color:#aaa5b7}.file-job progress{width:100%;accent-color:#a692f2}.trash-panel h2{font-size:18px;margin-top:0}.trash-panel p{color:#aaa5b7;line-height:1.5}.trash-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid #34313c}.trash-row div{display:flex;flex-direction:column;gap:6px;overflow-wrap:anywhere;min-width:0}.trash-row span{color:#aaa5b7;font-size:12px}
.file-dialog{width:min(780px,calc(100vw - 48px));max-height:85vh;overflow:auto;padding:24px;border:1px solid #635176;border-radius:14px;background:#211d2b;color:#eee8f8}.file-dialog::backdrop{background:#0009}.file-dialog h2{font-size:20px;margin:0 0 12px}.file-dialog p{font-size:13px;line-height:1.5;color:#b6aec3;overflow-wrap:anywhere}.file-dialog label{display:flex;flex-direction:column;gap:8px}.file-dialog input,.file-dialog textarea{border:1px solid #51465e;border-radius:7px;background:#15131a;color:#eee8f8;padding:10px;font-size:14px}.file-dialog textarea{display:block;box-sizing:border-box;width:100%;min-height:320px;resize:vertical;font:13px/1.6 monospace;tab-size:2}.dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.dialog-actions button[type=submit]{background:#69539d}.confirmation-paths{padding-left:20px;max-height:240px;overflow:auto;font-size:13px;overflow-wrap:anywhere}.dialog-error{margin-top:12px;color:#efb3ac}
 .file-notifications{position:fixed;right:24px;bottom:24px;z-index:90;display:flex;flex-direction:column;gap:10px;width:min(420px,calc(100vw - 32px));pointer-events:none}
.file-notification{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px;background:#282232;border:1px solid #766391;border-radius:12px;box-shadow:0 8px 30px #0006;pointer-events:auto;font-size:13px}.file-notification.attention{border-color:#b48c57}.file-notification>div{display:flex;flex-direction:column;gap:7px;min-width:0}.file-notification span{color:#bdb4c9;overflow-wrap:anywhere;max-height:8em;overflow:auto}.file-notification button{border:0;background:transparent;color:#d9c8ff;cursor:pointer;font-size:12px;padding:0;text-align:left}.file-notification .notification-close{font-size:22px;line-height:1;padding:0 2px;color:#ccc4d8}.panel-title{display:flex;align-items:center;justify-content:space-between;gap:16px}.history-panel h2{font-size:18px;margin:0}.history-list{max-height:360px;overflow:auto;margin-top:12px}.history-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 0;border-top:1px solid #39323f;font-size:12px}.history-row>div{display:flex;flex-direction:column;gap:5px;min-width:0}.history-row span{color:#aaa5b7;overflow-wrap:anywhere}.history-row.error strong{color:#efb3ac}.attention-count{display:inline-flex;margin-left:7px;padding:1px 6px;border-radius:10px;background:#72562e;color:#ffe5b1}.toolbar .actions .attention{border-color:#967a50}
@media(max-width:800px){.file-notifications{right:16px;bottom:16px}.history-row{align-items:flex-start}}
@media(max-width:800px){.files-page .heading{display:none}.files-page .row{grid-template-columns:22px minmax(0,1fr) auto}.files-page .row>span:nth-child(4){display:none}.row-actions{grid-column:2 / -1}.files-page .row>span:nth-child(3){display:block}.trash-row{align-items:flex-start}.file-dialog{padding:18px}}
</style>

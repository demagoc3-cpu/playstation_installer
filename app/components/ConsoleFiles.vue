<script setup lang="ts">
const props = defineProps<{ psIp: string }>()
interface Entry { name: string; type: 'file' | 'directory' | 'link'; size: number; mtime: number }
interface Listing { entries: Entry[]; nextOffset: number; hasMore: boolean }
const path = ref('/user'), entries = ref<Entry[]>([]), offset = ref(0), hasMore = ref(false)
const busy = ref(false), error = ref(''), fileInput = ref<HTMLInputElement>(), selected = ref<File>()
const uploadOffset = ref(0), uploading = ref(false), paused = ref(false)
let controller: AbortController | undefined
const writable = computed(() => path.value.startsWith('/data/') || path.value === '/data' || /^\/mnt\/usb[0-7](?:\/|$)/.test(path.value))
const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean)
  return [{ name: '/', path: '/' }, ...parts.map((name, index) => ({ name, path: '/' + parts.slice(0, index + 1).join('/') }))]
})
const message = (cause: unknown) => {
  const issue = cause as { data?: { message?: string }; message?: string }
  return issue.data?.message || issue.message || 'Нет ответа от PS4'
}
const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} Б` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} КБ` : `${(bytes / 1024 ** 2).toFixed(1)} МБ`
async function load(more = false) {
  if (busy.value) return
  busy.value = true; error.value = ''
  const ip = props.psIp, directory = path.value
  try {
    const page = await $fetch<Listing>('/api/ps4/files/list', { method: 'POST', body: { ip, path: directory, offset: more ? offset.value : 0 } })
    if (ip === props.psIp && directory === path.value) {
      entries.value = more ? [...entries.value, ...page.entries] : page.entries
      offset.value = page.nextOffset; hasMore.value = page.hasMore
    }
  } catch (cause) { if (ip === props.psIp && directory === path.value) error.value = message(cause) }
  finally {
    busy.value = false
    if (ip !== props.psIp || directory !== path.value) void load()
  }
}
function navigate(next: string) {
  if (uploading.value) return
  path.value = next; entries.value = []; offset.value = 0; hasMore.value = false
  void load()
}
function downloadUrl(name: string) {
  return `/api/ps4/files/download?ip=${encodeURIComponent(props.psIp)}&path=${encodeURIComponent((path.value === '/' ? '' : path.value) + '/' + name)}`
}
function transferId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < 16; ++i) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function selectFile(event: Event) { selected.value = (event.target as HTMLInputElement).files?.[0]; if (selected.value) void upload() }
function pause() { paused.value = true; controller?.abort() }
async function upload() {
  const file = selected.value
  if (!file || uploading.value || !writable.value) return
  uploading.value = true; paused.value = false; error.value = ''
  const destination = `${path.value}/${file.name}`
  const key = `packageflow:upload:${props.psIp}:${destination}:${file.size}:${file.lastModified}`
  const id = localStorage.getItem(key) || transferId()
  localStorage.setItem(key, id)
  try {
    const session = await $fetch<{ offset: number }>('/api/ps4/files/upload/start', { method: 'POST', body: { ip: props.psIp, path: destination, id, size: file.size } })
    if (!Number.isSafeInteger(session.offset) || session.offset < 0 || session.offset > file.size) throw new Error('PS4 вернула неверную позицию файла')
    uploadOffset.value = session.offset
    while (uploadOffset.value < file.size && !paused.value) {
      const start = uploadOffset.value, part = file.slice(start, Math.min(start + 256 * 1024, file.size))
      controller = new AbortController()
      const response = await fetch(`/api/ps4/files/upload/chunk?ip=${encodeURIComponent(props.psIp)}&id=${id}&offset=${start}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: part, signal: controller.signal,
      })
      if (!response.ok) throw new Error(`PS4 не приняла фрагмент (${response.status})`)
      const progress = await response.json() as { offset: number }
      if (progress.offset !== start + part.size) throw new Error('PS4 вернула неверную позицию файла')
      uploadOffset.value = progress.offset
    }
    if (!paused.value) {
      await $fetch('/api/ps4/files/upload/finish', { method: 'POST', body: { ip: props.psIp, id } })
      localStorage.removeItem(key); selected.value = undefined
      if (fileInput.value) fileInput.value.value = ''
      await load()
    }
  } catch (cause) { if (!paused.value) error.value = `${message(cause)}. Выберите тот же файл для продолжения.` }
  finally { controller = undefined; uploading.value = false }
}
onMounted(() => void load())
watch(() => props.psIp, () => { entries.value = []; offset.value = 0; hasMore.value = false; if (!busy.value) void load() })
</script>

<template>
  <section class="files-page">
    <p class="eyebrow">PLAYSTATION 4</p>
    <h1>Файлы консоли</h1>
    <p class="description">Просмотр и передача файлов через PackageFlowService. Загрузку можно продолжить после обрыва связи.</p>
    <div class="toolbar">
      <div class="roots"><button v-for="root in ['/', '/user', '/data', '/mnt/usb0']" :key="root" type="button" :class="{ active: path === root }" @click="navigate(root)">{{ root }}</button></div>
      <div class="actions">
        <input ref="fileInput" class="hidden" type="file" @change="selectFile">
        <button type="button" :disabled="!writable || uploading" :title="!writable ? 'Загрузка доступна в /data и /mnt/usb' : ''" @click="fileInput?.click()">Загрузить файл</button>
        <button type="button" :disabled="busy" @click="load()">Обновить</button>
      </div>
    </div>
    <nav class="crumbs" aria-label="Путь"><button v-for="item in crumbs" :key="item.path" type="button" @click="navigate(item.path)">{{ item.name }}</button></nav>
    <div v-if="error" class="message error" role="alert">{{ error }}</div>
    <div v-if="selected" class="message transfer">
      <strong>{{ selected.name }}</strong><span>{{ sizeLabel(uploadOffset) }} из {{ sizeLabel(selected.size) }}</span>
      <progress :value="uploadOffset" :max="selected.size || 1" />
      <button v-if="uploading" type="button" @click="pause">Пауза</button>
      <button v-else type="button" @click="upload">Продолжить</button>
    </div>
    <div class="listing">
      <div class="heading"><span>Название</span><span>Размер</span><span>Изменён</span><span>Действие</span></div>
      <div v-if="busy && !entries.length" class="empty">Читаем папку…</div>
      <div v-else-if="!entries.length" class="empty">{{ error ? 'Список недоступен' : 'Папка пуста' }}</div>
      <div v-for="item in entries" :key="item.name" class="row">
        <button v-if="item.type === 'directory'" class="name" type="button" @click="navigate(`${path === '/' ? '' : path}/${item.name}`)">📁 {{ item.name }}</button>
        <span v-else class="name">{{ item.type === 'link' ? '🔗' : '📄' }} {{ item.name }}</span>
        <span>{{ item.type === 'file' ? sizeLabel(item.size) : '—' }}</span>
        <span>{{ item.mtime ? new Date(item.mtime * 1000).toLocaleString('ru-RU') : '—' }}</span>
        <a v-if="item.type === 'file'" :href="downloadUrl(item.name)">Скачать</a><span v-else>—</span>
      </div>
      <button v-if="hasMore" class="more" type="button" :disabled="busy" @click="load(true)">Показать ещё</button>
    </div>
    <p class="hint">Запись доступна в /data и на USB. Системные файлы доступны только для чтения. Игры удаляйте через раздел «На консоли».</p>
  </section>
</template>

<script setup lang="ts">
const props = defineProps<{ ip: string; users: { userId: string; games: { titleId: string; title: string }[] }[] }>()

interface SaveSetGame { userId: string; titleId: string; title: string; discovered: boolean; error?: string }
interface SaveSetSlot { userId: string; titleId: string; title: string; slot: string; status: 'pending' | 'complete' | 'error'; error?: string }
interface SaveSet { id: string; name: string; sourceIp: string; createdAt: string; status: 'queued' | 'running' | 'completed' | 'partial' | 'interrupted'; inventoryComplete: boolean; games: SaveSetGame[]; slots: SaveSetSlot[]; lastError?: string }
interface Match { key: string; sourceUserId: string; titleId: string; title: string; slots: string[]; status: string; message: string }
interface RestoreTask { key: string; titleId: string; slot: string; status: string; rollbackId?: string; restoreState?: string; error?: string }
interface RestoreRun { id: string; status: string; createdAt: string; tasks: RestoreTask[] }

const sets = ref<SaveSet[]>([])
const selected = ref<SaveSet | null>(null)
const runs = ref<RestoreRun[]>([])
const targetUserId = ref('')
const matches = ref<Match[]>([])
const checked = ref<string[]>([])
const name = ref('')
const uploadProgress = ref(0)
const busy = ref('')
const error = ref('')
const notice = ref('')
let timer: ReturnType<typeof setInterval> | undefined

const groups = computed(() => {
  const result = new Map<string, SaveSet[]>()
  for (const set of sets.value) {
    const key = `${set.sourceIp}\u0000${set.name}`
    if (!result.has(key)) result.set(key, [])
    result.get(key)!.push(set)
  }
  return [...result.values()]
})
const readyCount = computed(() => matches.value.filter(match => match.status === 'ready').length)
const latestRun = computed(() => runs.value[0])

function failure(cause: unknown) {
  const issue = cause as { data?: { message?: string }; message?: string }
  return issue.data?.message || issue.message || 'Не удалось выполнить действие'
}
function date(value: string) { return new Date(value).toLocaleString('ru-RU') }
function plural(count: number, one: string, few: string, many: string) {
  const mod100 = count % 100, mod10 = count % 10
  return mod100 >= 11 && mod100 <= 14 ? many : mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many
}
function progress(set: SaveSet) {
  const done = set.slots.filter(slot => slot.status === 'complete').length
  return `${done} из ${set.slots.length} слотов · ${set.games.filter(game => game.discovered).length} из ${set.games.length} игр`
}
function stateText(set: SaveSet) {
  if (set.status === 'completed') return 'Готово'
  if (set.status === 'running' || set.status === 'queued') return 'Копируется…'
  if (set.status === 'partial') return 'Есть пропущенные сейвы'
  return 'Копирование прервано'
}
function runText(run: RestoreRun) {
  if (run.status === 'running' || run.status === 'queued') return 'Восстанавливаем…'
  if (run.status === 'completed') return 'Запись завершена, проверьте сейвы в игре'
  return 'Часть слотов требует внимания'
}
async function refreshSets() {
  const result = await $fetch<{ sets: SaveSet[] }>('/api/ps4/saves/sets/list', { method: 'POST', body: {} })
  sets.value = result.sets
  if (selected.value) selected.value = result.sets.find(set => set.id === selected.value?.id) || selected.value
}
async function openSet(id: string) {
  busy.value = 'open'; error.value = ''; notice.value = ''; matches.value = []; checked.value = []
  try {
    const result = await $fetch<{ set: SaveSet; runs: RestoreRun[] }>('/api/ps4/saves/sets/details', { method: 'POST', body: { id } })
    selected.value = result.set; runs.value = result.runs
    if (!props.users.some(user => user.userId === targetUserId.value)) targetUserId.value = props.users[0]?.userId || ''
  } catch (cause) { error.value = failure(cause) }
  finally { busy.value = '' }
}
async function create() {
  if (!name.value.trim() || busy.value) return
  busy.value = 'create'; error.value = ''; notice.value = ''
  try {
    const set = await $fetch<SaveSet>('/api/ps4/saves/sets/create', { method: 'POST', body: { ip: props.ip, name: name.value.trim() } })
    name.value = ''; await refreshSets(); await openSet(set.id)
    notice.value = 'Создание набора началось. Сохранения размещаются на компьютере в папке с указанным именем.'
  } catch (cause) { error.value = failure(cause) }
  finally { busy.value = '' }
}
async function importZip(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || busy.value) return
  busy.value = 'import'; uploadProgress.value = 0; error.value = ''; notice.value = ''
  try {
    if (file.size > 1024 * 1024 * 1024) throw new Error('Архив больше 1 ГБ')
    const result = await new Promise<SaveSet>((resolveDone, reject) => {
      const request = new XMLHttpRequest()
      request.open('POST', '/api/ps4/saves/sets/import')
      request.setRequestHeader('Content-Type', 'application/zip')
      request.upload.onprogress = progress => { if (progress.lengthComputable) uploadProgress.value = Math.round(progress.loaded * 100 / progress.total) }
      request.onerror = () => reject(new Error('Передача архива прервалась'))
      request.onload = () => {
        let body: SaveSet & { message?: string }
        try { body = JSON.parse(request.responseText) } catch { reject(new Error('WEB вернул неверный ответ')); return }
        if (request.status < 200 || request.status >= 300) reject(new Error(body.message || 'Не удалось загрузить архив'))
        else resolveDone(body)
      }
      request.send(file)
    })
    await refreshSets(); await openSet(result.id)
    notice.value = 'Архив проверен и добавлен как новая версия набора. Теперь можно проверить подходящие игры для восстановления.'
  } catch (cause) { error.value = failure(cause) }
  finally { busy.value = ''; input.value = '' }
}
async function resume() {
  if (!selected.value || busy.value) return
  busy.value = 'resume'; error.value = ''
  try {
    await $fetch('/api/ps4/saves/sets/resume', { method: 'POST', body: { id: selected.value.id } })
    await refreshSets()
  } catch (cause) { error.value = failure(cause) }
  finally { busy.value = '' }
}
async function download() {
  if (!selected.value || busy.value) return
  const set = selected.value
  busy.value = 'download'; error.value = ''
  try {
    const blob = await $fetch<Blob>('/api/ps4/saves/sets/archive', { method: 'POST', body: { id: set.id }, responseType: 'blob' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = `${set.name}-${set.id}.zip`
    document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (cause) { error.value = failure(cause) }
  finally { busy.value = '' }
}
async function preview() {
  if (!selected.value || !targetUserId.value || busy.value) return
  busy.value = 'preview'; error.value = ''; notice.value = ''; checked.value = []
  try {
    const result = await $fetch<{ matches: Match[] }>('/api/ps4/saves/sets/preview', { method: 'POST', body: { id: selected.value.id, ip: props.ip, targetUserId: targetUserId.value } })
    matches.value = result.matches
    notice.value = result.matches.length ? 'Выберите игры с пометкой «Можно восстановить».' : 'В этом наборе пока нет готовых сейвов.'
  } catch (cause) { error.value = failure(cause) }
  finally { busy.value = '' }
}
function toggle(key: string) {
  checked.value = checked.value.includes(key) ? checked.value.filter(item => item !== key) : [...checked.value, key]
}
function toggleAllReady() {
  checked.value = checked.value.length === readyCount.value ? [] : matches.value.filter(match => match.status === 'ready').map(match => match.key)
}
async function restore() {
  if (!selected.value || !checked.value.length || busy.value) return
  if (!window.confirm(`Восстановить сохранения ${checked.value.length} игр? Перед этим закройте эти игры на PS4. Для каждого слота будет создана копия для отката.`)) return
  busy.value = 'restore'; error.value = ''; notice.value = ''
  try {
    await $fetch('/api/ps4/saves/sets/restore', { method: 'POST', body: { id: selected.value.id, ip: props.ip, targetUserId: targetUserId.value, selected: checked.value } })
    matches.value = []; checked.value = []
    await openSet(selected.value.id)
    notice.value = 'Восстановление началось. После записи проверьте сейвы внутри игр и подтвердите результат.'
  } catch (cause) { error.value = failure(cause) }
  finally { busy.value = '' }
}
async function settle(task: RestoreTask, action: 'finalize' | 'rollback') {
  if (!selected.value || !task.rollbackId || busy.value) return
  const question = action === 'finalize'
    ? `Сейв ${task.titleId} / ${task.slot} открылся в игре? Подтверждение удалит временный откат на PS4.`
    : `Вернуть прежний сейв ${task.titleId} / ${task.slot}? Сначала закройте игру.`
  if (!window.confirm(question)) return
  busy.value = task.rollbackId; error.value = ''; notice.value = ''
  try {
    await $fetch(`/api/ps4/saves/${action}`, { method: 'POST', body: { ip: props.ip, id: task.rollbackId } })
    await openSet(selected.value.id)
    notice.value = action === 'finalize' ? 'Результат подтверждён.' : 'Предыдущий сейв возвращён.'
  } catch (cause) { error.value = failure(cause) }
  finally { busy.value = '' }
}
async function resumeRestore() {
  if (!selected.value || !latestRun.value || busy.value) return
  busy.value = 'resumeRestore'; error.value = ''
  try {
    await $fetch('/api/ps4/saves/sets/restore-resume', { method: 'POST', body: { id: latestRun.value.id } })
    await openSet(selected.value.id)
  } catch (cause) { error.value = failure(cause) }
  finally { busy.value = '' }
}
async function poll() {
  if (busy.value) return
  try {
    await refreshSets()
    if (selected.value && (['queued', 'running'].includes(selected.value.status) || ['queued', 'running'].includes(latestRun.value?.status || ''))) {
      const result = await $fetch<{ set: SaveSet; runs: RestoreRun[] }>('/api/ps4/saves/sets/details', { method: 'POST', body: { id: selected.value.id } })
      selected.value = result.set; runs.value = result.runs
    }
  } catch { /* A temporary connection error must not replace the last visible state. */ }
}
onMounted(() => { void refreshSets().catch(cause => { error.value = failure(cause) }); timer = setInterval(() => void poll(), 4000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
watch(() => props.ip, () => { matches.value = []; checked.value = []; targetUserId.value = ''; void poll() })
watch(targetUserId, () => { matches.value = []; checked.value = [] })
</script>

<template>
  <section class="collections">
    <div class="heading"><div><h2>Наборы сохранений</h2><p>Создайте папку со всеми сейвами PS4. Новая копия с тем же названием станет отдельной версией набора.</p></div></div>
    <div class="create"><label>Название папки<input v-model="name" maxlength="60" placeholder="Например, PS HOME" @keyup.enter="create"></label><button :disabled="!name.trim() || !!busy" @click="create">{{ busy === 'create' ? 'Начинаем…' : 'Сохранить все сейвы' }}</button><label class="upload">{{ busy === 'import' ? `Загрузка ${uploadProgress}% · проверяем ZIP…` : 'Загрузить ZIP набора' }}<input type="file" accept=".zip,application/zip" :disabled="!!busy" @change="importZip"></label></div>
    <p v-if="error" class="message error" role="alert">{{ error }}</p>
    <p v-if="notice" class="message notice" role="status">{{ notice }}</p>
    <div v-if="groups.length" class="groups">
      <div v-for="group in groups" :key="`${group[0]?.sourceIp}-${group[0]?.name}`" class="group">
        <div><strong>{{ group[0]?.name }}</strong><small>PS4 {{ group[0]?.sourceIp }} · {{ group.length }} {{ plural(group.length, 'версия', 'версии', 'версий') }}</small></div>
        <button v-for="set in group" :key="set.id" :class="{ active: selected?.id === set.id }" @click="openSet(set.id)">{{ date(set.createdAt) }} · {{ stateText(set) }}</button>
      </div>
    </div>
    <p v-else class="muted">Именных наборов пока нет.</p>
    <div v-if="selected" class="details">
      <div class="details-head"><div><h3>{{ selected.name }}</h3><p>Копия от {{ date(selected.createdAt) }} · {{ stateText(selected) }} · {{ progress(selected) }}</p></div><div class="actions"><button :disabled="!!busy || !selected.slots.some(slot => slot.status === 'complete') || ['queued', 'running'].includes(selected.status)" @click="download">{{ busy === 'download' ? 'Собираем ZIP…' : 'Скачать ZIP' }}</button><button v-if="['partial', 'interrupted'].includes(selected.status)" :disabled="!!busy" @click="resume">Повторить пропущенное</button></div></div>
      <p v-if="selected.lastError" class="message error">{{ selected.lastError }}</p>
      <div v-if="selected.games.some(game => game.error) || selected.slots.some(slot => slot.error)" class="issues"><strong>Не удалось скопировать</strong><p v-for="game in selected.games.filter(item => item.error)" :key="`${game.userId}-${game.titleId}`">{{ game.title }}: {{ game.error }}</p><p v-for="slot in selected.slots.filter(item => item.error)" :key="`${slot.userId}-${slot.titleId}-${slot.slot}`">{{ slot.title }} / {{ slot.slot }}: {{ slot.error }}</p></div>
      <div class="restore-section"><h3>Восстановить выбранные игры</h3><p>Игра должна быть установлена. Сначала создайте в ней сейв на целевом профиле и закройте игру. Сервис проверит каждый слот перед записью.</p><div class="restore-controls"><label>Профиль на PS4<select v-model="targetUserId"><option disabled value="">Выберите профиль</option><option v-for="(user, index) in users" :key="user.userId" :value="user.userId">Профиль {{ index + 1 }} · {{ user.userId }}</option></select></label><button :disabled="!!busy || !targetUserId || !selected.slots.some(slot => slot.status === 'complete')" @click="preview">{{ busy === 'preview' ? 'Проверяем…' : 'Показать подходящие игры' }}</button></div>
        <div v-if="matches.length" class="matches"><div class="match-summary"><span>Можно восстановить: {{ readyCount }} из {{ matches.length }} игр</span><button v-if="readyCount" :disabled="!!busy" @click="toggleAllReady">{{ checked.length === readyCount ? 'Снять выбор' : 'Выбрать все подходящие' }}</button></div><label v-for="match in matches" :key="match.key" class="match" :class="{ unavailable: match.status !== 'ready' }"><input type="checkbox" :checked="checked.includes(match.key)" :disabled="match.status !== 'ready' || !!busy" @change="toggle(match.key)"><span><strong>{{ match.title === match.titleId ? match.titleId : match.title }}</strong><small>{{ match.titleId }} · профиль {{ match.sourceUserId }} · {{ match.slots.length }} {{ plural(match.slots.length, 'слот', 'слота', 'слотов') }}</small><em>{{ match.status === 'ready' ? 'Можно восстановить' : match.message }}</em></span></label><button :disabled="!checked.length || !!busy" @click="restore">{{ busy === 'restore' ? 'Начинаем…' : `Восстановить выбранные (${checked.length})` }}</button></div>
      </div>
      <div v-if="latestRun" class="restore-section"><div class="run-head"><h3>Последнее восстановление</h3><span>{{ runText(latestRun) }}</span></div><p>{{ latestRun.tasks.filter(task => task.status === 'restored' || task.status === 'needs-review').length }} из {{ latestRun.tasks.length }} слотов записано.</p><button v-if="['partial', 'interrupted'].includes(latestRun.status) && latestRun.tasks.some(task => task.status === 'error' || task.status === 'pending')" :disabled="!!busy" @click="resumeRestore">Повторить оставшиеся</button><div v-for="task in latestRun.tasks" :key="`${task.key}-${task.slot}`" class="task"><span><strong>{{ task.titleId }} / {{ task.slot }}</strong><small v-if="task.error">{{ task.error }}</small><small v-else-if="task.restoreState === 'accepted'">Подтверждено</small><small v-else-if="task.restoreState === 'rolledBack'">Вернули прежний сейв</small><small v-else-if="task.rollbackId">Проверьте сейв в игре; откат сохранён</small><small v-else>{{ task.status === 'error' ? 'Ошибка' : 'Ожидает записи' }}</small></span><div v-if="task.rollbackId && task.restoreState === 'pending'" class="actions"><button :disabled="!!busy" @click="settle(task, 'finalize')">Игра читает сейв</button><button :disabled="!!busy" @click="settle(task, 'rollback')">Вернуть прежний</button></div></div></div>
    </div>
  </section>
</template>

<style scoped>
.collections { margin: 24px 0 30px; padding: 22px; border: 1px solid #38323f; border-radius: 10px; background: #1b1a1f; }
h2, h3 { margin: 0; color: #ece7f4; } h2 { font-size: 19px; } h3 { font-size: 15px; }
p { margin: 7px 0 0; color: #aaa5b2; font-size: 12px; line-height: 1.6; }
button, input, select { padding: 9px 12px; border: 1px solid #494254; border-radius: 7px; background: #292630; color: #eee8f5; font-size: 12px; }
button { cursor: pointer; } button:hover:not(:disabled), button.active { border-color: #a389e8; } button:disabled { opacity: .5; cursor: default; }
label { display: flex; flex-direction: column; gap: 6px; color: #b7b0c2; font-size: 11px; }
.create, .restore-controls, .details-head, .actions, .run-head { display: flex; align-items: end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.create { justify-content: flex-start; margin: 17px 0; }.create input { min-width: 240px; }.groups { display: grid; gap: 9px; }
.upload { display: inline-block; padding: 9px 12px; border: 1px solid #494254; border-radius: 7px; background: #292630; color: #eee8f5; font-size: 12px; cursor: pointer; }.upload input { display: none; }
.group { display: flex; align-items: center; gap: 9px; padding: 11px; flex-wrap: wrap; border: 1px solid #322d38; border-radius: 8px; }
.group > div { display: flex; flex-direction: column; min-width: 180px; gap: 4px; }.group strong { font-size: 13px; }.group small { color: #aaa5b2; font-size: 11px; }
.details { margin-top: 18px; border-top: 1px solid #393440; padding-top: 18px; }.details-head { align-items: center; }.issues { padding: 12px 0; }.issues strong { color: #e3b498; font-size: 12px; }
.restore-section { margin-top: 20px; border-top: 1px solid #393440; padding-top: 17px; }.restore-controls { justify-content: flex-start; margin: 14px 0; }.restore-controls select { min-width: 200px; }
.matches { margin: 12px 0; }.match-summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; color: #bdb3ce; font-size: 12px; margin-bottom: 6px; }.match-summary button { padding: 6px 9px; }.match { flex-direction: row; align-items: flex-start; padding: 11px 0; border-bottom: 1px solid #332f38; }
.match input { margin: 2px 5px 0 0; }.match span { display: flex; flex-direction: column; gap: 3px; }.match strong, .task strong { color: #ece7f4; font-size: 12px; }.match small, .task small { color: #aaa5b2; }.match em { color: #a5d1a9; font-size: 11px; font-style: normal; }.match.unavailable em { color: #d4b29b; }
.matches > button { margin-top: 12px; }.run-head { align-items: center; }.run-head span { color: #ac9ed3; font-size: 11px; }.task { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid #332f38; padding: 12px 0; }.task > span { display: flex; flex-direction: column; gap: 4px; }
.message { padding: 12px; border-radius: 7px; }.error { color: #e9b2a9; background: #2d2022; border: 1px solid #7d5151; }.notice { color: #d4c7ef; background: #282333; border: 1px solid #625484; }
@media (max-width: 650px) { .collections { padding: 15px; }.create, .details-head, .task { align-items: stretch; flex-direction: column; }.create input { min-width: 0; }.group > div { width: 100%; } }
</style>

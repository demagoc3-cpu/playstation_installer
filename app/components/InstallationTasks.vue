<script setup lang="ts">
import { installationTaskGroupKey, TASK_CATEGORIES, type TaskCategory, type InstallationTask, type InstallationTasksPage } from '#shared/types/tasks'
const { t } = useAppLocale()
interface Torrent { hash: string; name: string; state: string; progress: number }
const props = defineProps<{ visible: boolean; torrents: Torrent[]; queueStatus: string; cancelling: boolean; maintenance?: { id: string; title: string; state: string; message: string } | null }>()
const emit = defineEmits<{ changed: []; torrent: [hash: string, action: 'pause' | 'resume' | 'delete']; stop: []; resolve: [] }>()
const categories = ref<TaskCategory[]>([...TASK_CATEGORIES])
const labels = { active: 'Активные', queued: 'В очереди', completed: 'Завершённые', failed: 'С ошибками' }
const data = ref<InstallationTasksPage>({ active: [], items: [], counts: { active: 0, queued: 0, completed: 0, failed: 0 }, page: 1, pages: 1, total: 0, unit: 'games' })
const view = ref<'tree' | 'table'>('tree')
const treeExpanded = reactive<Record<string, boolean>>({})
const clearedMaintenance = ref('')
async function clearFinished() {
  if (pending.value) return
  pending.value = 'clear'; message.value = ''
  try { await $fetch('/api/ps4/installation/clear', { method: 'POST', body: { torrents: props.torrents.filter(item => ['completed', 'failed'].includes(torrentCategory(item))) } }); if (props.maintenance && ['completed', 'failed'].includes(props.maintenance.state)) { clearedMaintenance.value = props.maintenance.id; try { localStorage.setItem('packageflow-cleared-maintenance', clearedMaintenance.value) } catch {} }; page.value = 1; await refresh(); message.value = 'Завершённые задания и ошибки убраны из списка' }
  catch (error: any) { message.value = error?.data?.message || 'Не удалось очистить задания' }
  finally { pending.value = '' }
}
const visibleTorrents = computed(() => props.torrents.filter(item => !['completed', 'failed'].includes(torrentCategory(item)) || data.value.hiddenTorrents?.[item.hash] !== `${item.state}:${item.progress}`))
const page = ref(1), message = ref(''), pending = ref('')
let timer: ReturnType<typeof setInterval> | undefined, controller: AbortController | undefined, generation = 0
async function refresh() {
  if (!props.visible) return
  controller?.abort(); controller = new AbortController(); const request = ++generation
  try {
    const result = await $fetch<InstallationTasksPage>('/api/ps4/installation/tasks', { query: { page: page.value, categories: categories.value.join(','), view: view.value }, signal: controller.signal })
    if (request !== generation) return
    data.value = result; page.value = result.page
  } catch (error: any) { if (request === generation && !controller?.signal.aborted) message.value = error?.data?.message || 'Не удалось обновить задания' }
}
function selectView(value: 'tree' | 'table') { if (view.value === value) return; view.value = value; page.value = 1; try { localStorage.setItem('packageflow-tasks-view', value) } catch { /* Session choice still applies. */ } void refresh() }
function setAll(checked: boolean) { categories.value = checked ? [...TASK_CATEGORIES] : [] }
watch(categories, () => { page.value = 1; void refresh() }, { deep: true })
watch(() => props.visible, visible => { if (visible) void refresh(); else { controller?.abort(); generation++ } })
onMounted(() => { try { clearedMaintenance.value = localStorage.getItem('packageflow-cleared-maintenance') || ''; if (localStorage.getItem('packageflow-tasks-view') === 'table') view.value = 'table' } catch { /* The default tree remains available. */ } void refresh(); timer = setInterval(() => { if (document.visibilityState === 'visible' && !pending.value) void refresh() }, 2000) })
onUnmounted(() => { if (timer) clearInterval(timer); controller?.abort(); generation++ })
async function cancel(task: InstallationTask) {
  if (pending.value) return
  if (task.category === 'active' && !window.confirm(t('Отменить только этот пакет? Остальные задания останутся в очереди.'))) return
  pending.value = task.id; message.value = ''
  try { await $fetch('/api/ps4/installation/item-cancel', { method: 'POST', body: { queueId: task.queueId, packageId: task.packageId, ip: task.psIp } }); emit('changed'); await refresh() }
  catch (error: any) { message.value = error?.data?.message || 'Не удалось отменить задание' }
  finally { pending.value = '' }
}
async function cancelBranch(items: InstallationTask[]) {
  const targets = items.filter(task => task.canCancel), task = targets[0]
  if (!task || pending.value || !window.confirm(t('Отменить всю ветку игры вместе с патчами и DLC?'))) return
  pending.value = `branch:${task.id}`; message.value = ''
  try { await $fetch('/api/ps4/installation/branch-cancel', { method: 'POST', body: { queueId: task.queueId, gameId: task.titleId || task.packageId, ip: task.psIp } }); emit('changed'); await refresh() }
  catch (error: any) { message.value = error?.data?.message || 'Не удалось отменить ветку' }
  finally { pending.value = '' }
}
function torrentCategory(item: Torrent): TaskCategory {
  if (/error|missingFiles|unknown/i.test(item.state)) return 'failed'
  if (item.progress >= 1) return 'completed'
  return /paused|stopped|queued/i.test(item.state) ? 'queued' : 'active'
}
const taskGroups = computed(() => {
  const groups = new Map<string, { key: string; title: string; titleId: string; icon?: string; items: InstallationTask[] }>()
  for (const task of data.value.items) {
    const key = installationTaskGroupKey(task)
    let group = groups.get(key)
    if (!group) { group = { key, title: task.groupTitle, titleId: task.titleId, icon: task.groupIconId, items: [] }; groups.set(key, group) }
    group.items.push(task)
  }
  return [...groups.values()]
})
function treeOpen(group: { key: string; items: InstallationTask[] }) { return treeExpanded[group.key] ?? group.items.some(task => ['active', 'queued', 'failed'].includes(task.category)) }
const showMaintenance = computed(() => props.maintenance && clearedMaintenance.value !== props.maintenance.id && (!['completed', 'failed'].includes(props.maintenance.state) || categories.value.includes(props.maintenance.state === 'failed' ? 'failed' : 'completed')))
const activeTorrents = computed(() => visibleTorrents.value.filter(item => torrentCategory(item) === 'active'))
const otherTorrents = computed(() => visibleTorrents.value.filter(item => torrentCategory(item) !== 'active' && categories.value.includes(torrentCategory(item))))
const torrentCounts = computed(() => Object.fromEntries(TASK_CATEGORIES.map(category => [category, visibleTorrents.value.filter(item => torrentCategory(item) === category).length])) as Record<TaskCategory, number>)
function torrentAction(item: Torrent, action: 'pause' | 'resume' | 'delete') {
  if (action === 'delete' && !window.confirm(t('Убрать torrent-задание? Скачанные файлы останутся на диске.'))) return
  emit('torrent', item.hash, action)
}
function go(value: number) { page.value = value; void refresh().then(() => { const list = document.querySelector('.task-list'); if (list) list.scrollTop = 0 }) }
</script>
<template>
  <section class="tasks-workspace">
    <div class="task-title"><div><h1>{{ t('Задания') }}</h1><p>{{ t('Установки на PS4 и загрузки qBittorrent. Активные задания всегда сверху.') }}</p></div><div class="task-controls"><button v-if="queueStatus === 'running'" :disabled="cancelling" @click="emit('stop')">{{ t('Отменить всю очередь') }}</button><button v-if="queueStatus === 'cancelling'" :disabled="cancelling" @click="emit('resolve')">{{ t('Снять ожидание') }}</button><button :disabled="!!pending" @click="clearFinished">{{ t('Очистить') }}</button><button @click="refresh">{{ t('Обновить') }}</button></div></div>
    <p v-if="message" class="task-message pf-notice" role="status">{{ t(message) }}</p>
    <div v-if="showMaintenance" class="maintenance-line" role="status"><strong>{{ t('Переустановка:') }} {{ maintenance?.title }}</strong><span>{{ t(maintenance?.message || '') }}</span></div>
    <section v-if="data.active.length || activeTorrents.length" class="active-jobs" :aria-label="t('Активные задания')">
      <InstallationTaskRow v-for="task in data.active" :key="task.id" :task="task" :busy="!!pending" @cancel="cancel" />
      <article v-for="item in activeTorrents" :key="item.hash" class="torrent-job active"><div><strong>{{ item.name }}</strong><span>qBittorrent · {{ Math.round(item.progress * 100) }}%</span></div><progress :value="item.progress" max="1" /><button @click="torrentAction(item, 'pause')">{{ t('Остановить') }}</button><button @click="torrentAction(item, 'delete')">{{ t('Убрать задачу') }}</button></article>
    </section>
    <div class="task-filters"><div class="task-views" :aria-label="t('Вид заданий')"><button :aria-pressed="view === 'tree'" @click="selectView('tree')">{{ t('Дерево') }}</button><button :aria-pressed="view === 'table'" @click="selectView('table')">{{ t('Таблица') }}</button></div><label><input type="checkbox" :checked="categories.length === TASK_CATEGORIES.length" :indeterminate="categories.length > 0 && categories.length < TASK_CATEGORIES.length" @change="setAll(($event.target as HTMLInputElement).checked)"> {{ t('Все') }}</label><label v-for="category in TASK_CATEGORIES" :key="category"><input v-model="categories" :value="category" type="checkbox"> {{ t(labels[category]) }} <small>{{ data.counts[category] + torrentCounts[category] }}</small></label></div>
    <div class="task-list" tabindex="0" :aria-label="t('Список заданий')">
      <template v-if="view === 'tree'">
        <GameTreeBranch v-for="group in taskGroups" :key="group.key" :title="group.title" :title-id="group.titleId" :cover="group.icon ? `/api/packages/${group.icon}?asset=icon` : undefined" :count="group.items.length" :open="treeOpen(group)" @toggle="treeExpanded[group.key]=!treeOpen(group)"><template #actions><button v-if="group.items.some(task => task.canCancel)" :disabled="!!pending" @click="cancelBranch(group.items)">{{ t('Отменить ветку') }}</button></template><InstallationTaskRow v-for="task in group.items" :key="task.id" :task="task" :busy="!!pending" @cancel="cancel" /></GameTreeBranch>
      </template>
      <InstallationTaskTable v-else-if="data.items.length" :tasks="data.items" :busy="!!pending" @cancel="cancel" />
      <article v-for="item in otherTorrents" :key="item.hash" class="torrent-job"><div><strong>{{ item.name }}</strong><span>qBittorrent · {{ t(labels[torrentCategory(item)]) }} · {{ Math.round(item.progress * 100) }}%</span></div><button v-if="/paused|stopped/i.test(item.state)" @click="torrentAction(item, 'resume')">{{ t('Продолжить') }}</button><button @click="torrentAction(item, 'delete')">{{ t('Убрать задачу') }}</button></article>
      <p v-if="!data.items.length && !otherTorrents.length" class="task-empty">{{ t('В выбранных категориях заданий нет.') }}</p>
    </div>
    <footer><span>{{ t('Снимите галочку, чтобы убрать пакет из очереди') }} · {{ t('Сохраняются 10 предыдущих очередей установки.') }}</span><div v-if="data.pages > 1"><button :disabled="page <= 1" @click="go(page - 1)">‹</button><span>{{ page }} / {{ data.pages }} · {{ data.total }} {{ t(data.unit === 'games' ? 'игр' : 'заданий') }}</span><button :disabled="page >= data.pages" @click="go(page + 1)">›</button></div></footer>
  </section>
</template>
<style scoped>
.maintenance-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 9px 14px; border: 1px solid #615076; border-radius: 9px; background: #1e1d22; font-size: 11px; }.maintenance-line span { color: #c4b9ff; }
.task-views { display: flex; gap: 3px; padding-right: 8px; border-right: 1px solid #4c3e5b; }.task-views button { padding: 5px 9px; }.task-views button[aria-pressed="true"] { background: #7754ad; border-color: #af8de2; color: white; }
.task-game { border: 1px solid #3a3046; border-radius: 12px; overflow: hidden; }.task-game-heading { width: 100%; display: flex; align-items: center; gap: 12px; text-align: left; border: 0; border-radius: 0; padding: 10px 14px; background: #27202f; }.tree-arrow { width: 16px; font-size: 20px; color: #bda1e6; }.tree-cover { width: 32px; height: 40px; flex: 0 0 32px; display: grid; place-items: center; background: linear-gradient(130deg,#8a68c5,#433255); border-radius: 5px; overflow: hidden; font-size: 18px; }.tree-cover img { width: 100%; height: 100%; object-fit: cover; }.tree-title { flex: 1; min-width: 0; }.tree-title strong { display: block; font-size: 13px; overflow-wrap: anywhere; }.tree-title span { display: block; margin-top: 5px; font-size: 10px; color: #a192b5; }.task-game-heading small { color: #c2a5ee; }.task-game-packages { display: grid; gap: 6px; padding: 8px; background: #17131e; }.task-game-packages :deep(.job-row) { padding: 10px 12px; }.task-game-packages :deep(.job-name p) { margin-top: 3px; }.task-child { margin-left: 32px; position: relative; }.task-child::before { content: ''; position: absolute; left: -23px; top: -8px; width: 15px; height: 40px; border-left: 1px solid #655078; border-bottom: 1px solid #655078; border-radius: 0 0 0 5px; }
.tasks-workspace { display: flex; flex-direction: column; min-height: 0; height: 100%; gap: 12px; }.task-title { display: flex; align-items: center; justify-content: space-between; gap: 15px; }.task-title h1 { margin: 0; font-size: 24px; }.task-title p { margin: 5px 0 0; color: #9a90a7; font-size: 12px; }
.task-message { margin: 0; padding: 8px 12px!important; }
.task-controls { display: flex; gap: 8px; }
.active-jobs :deep(.job-row) { padding: 9px 12px; }.active-jobs :deep(.job-name) { line-height: 1.3; }.active-jobs :deep(.job-name span) { margin: 2px 0; }.active-jobs :deep(.job-name p) { margin-top: 3px; }.active-jobs { display: grid; gap: 8px; max-height: 34vh; overflow: auto; flex-shrink: 0; }.task-filters { display: flex; flex-wrap: wrap; gap: 10px; padding: 12px 14px; border: 1px solid #393045; border-radius: 12px; background: #1e1d22; }.task-filters label { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }.task-filters small { color: #ad99d4; }input { accent-color: #9977d8; }
.task-list { display: grid; grid-auto-rows: max-content; align-content: start; gap: 0; flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-color: #8266c4 #17131f; padding-right: 6px; }.torrent-job { display: flex; gap: 12px; align-items: center; padding: 14px 16px; border: 1px solid #393045; background: #19191c; border-radius: 12px; }.torrent-job.active { border-color: #7860ae; }.torrent-job div { flex: 1; min-width: 0; }.torrent-job strong { font-size: 13px; overflow-wrap: anywhere; }.torrent-job span { display: block; font: 10px 'DM Mono', monospace; color: #85828a; margin-top: 5px; }progress { width: 120px; accent-color: #b28bef; }
button { border: 1px solid #574569; border-radius: 8px; padding: 8px 12px; background: #34283f; color: #e9ddff; cursor: pointer; font-size: 11px; }button:disabled { opacity: .4; cursor: default; }.task-empty { font-size: 11px; color: #85838b; padding: 15px; }footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #887b98; font-size: 10px; }footer div { display: flex; align-items: center; gap: 12px; }
</style>

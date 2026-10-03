<script setup lang="ts">
const { t, formatLocale } = useAppLocale()

import type { ConsoleApp, ConsoleCatalog, ConsoleComponent, ConsoleDetails, RemovalKind, RemoveOperation } from '../../shared/types/console-apps'
const props = defineProps<{ ip: string }>()
const emit = defineEmits<{ status: [ready: boolean]; changed: []; saves: [titleId: string] }>()
const catalog = ref<ConsoleCatalog>()
const details = ref<Record<string, ConsoleDetails>>({})
const query = ref('')
const selected = ref('')
const loading = ref(false)
const detailLoading = ref(false)
const message = ref('')
const paired = ref(false)
const pairing = ref(false)
const code = ref('')
const operation = ref<RemoveOperation | null>(null)
const dismissedOperation = ref('')
const submitting = ref(false)
const confirmation = ref<{ detail: ConsoleDetails; kind: RemovalKind; componentId: string; title: string; components: ConsoleComponent[] }>()
const typedId = ref('')
const iconFailures = ref<Record<string, number>>({})
const runtime = ref<Record<string, { running: boolean; appId: number }>>({})
const runtimeError = ref<Record<string, string>>({})
const control = ref<any>(null)
const controlling = ref(false)
let runtimeTimer: ReturnType<typeof setInterval> | undefined
let generation = 0
let timer: ReturnType<typeof setTimeout> | undefined
const active = computed(() => submitting.value || controlling.value || ['pending', 'uncertain'].includes(control.value?.state || '') || operation.value?.pending || ['queued', 'running', 'verifying'].includes(operation.value?.state || ''))
const visible = computed(() => (catalog.value?.apps || []).filter(a => `${a.title} ${a.titleId}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())))
const statusLabels: Record<string, string> = { queued: 'Принято PS4', running: 'Удаляем компоненты', verifying: 'Проверяем, что компоненты удалены', removed: 'Удаление подтверждено PS4', failed: 'Удаление не выполнено', partial: 'Удалена только часть компонентов', uncertain: 'Результат пока не подтверждён' }
function dismissalKey() { return `packageflow:removal-dismissed:${props.ip}` }
function dismissOperation() { if (!operation.value || !['removed', 'failed', 'partial'].includes(operation.value.state)) return; dismissedOperation.value = operation.value.requestId; try { localStorage.setItem(dismissalKey(), operation.value.requestId) } catch { /* The current tab still hides this result. */ } }
function errorText(error: any) { return error?.data?.message || error?.message || 'Не удалось связаться с PS4' }
function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function kindName(kind: string) { return kind === 'base' ? 'Игра' : kind === 'patch' ? 'Патч / бэкпорт' : 'DLC' }
function displayTitle(titleId: string, title: string) { return titleId === 'PFLS00001' ? 'PackageFlowService' : title }
function size(bytes: number) { return `${(bytes / 1024 ** 3).toLocaleString(formatLocale.value, { maximumFractionDigits: 2 })} ГиБ` }
function storage(value: string) { return value === 'internal' ? 'Внутренний диск' : value === 'external' ? 'Внешний диск' : 'Внутренний и внешний диски' }
function icon(a: ConsoleApp) { const n = iconFailures.value[a.titleId] || 0; return n === 0 ? a.iconUrl : n === 1 ? a.fallbackIconUrl : undefined }
async function readRuntime(titleId: string) {
  const id = generation
  try { const value = await $fetch<{ running: boolean; appId: number }>('/api/ps4/apps/runtime', { query: { ip: props.ip, titleId } }); if (id === generation) { runtime.value = { ...runtime.value, [titleId]: value }; const next = { ...runtimeError.value }; delete next[titleId]; runtimeError.value = next } }
  catch (e) { if (id === generation) { const next = { ...runtime.value }; delete next[titleId]; runtime.value = next; runtimeError.value = { ...runtimeError.value, [titleId]: errorText(e) } } }
}
async function pollControl() {
  const id = generation
  try { const value = await $fetch<any>('/api/ps4/apps/control', { query: { ip: props.ip } }); if (id !== generation) return; control.value = value; if (selected.value) await readRuntime(selected.value) }
  catch (e) { if (id === generation) message.value = errorText(e) }
}
async function act(a: ConsoleApp, action: 'launch' | 'stop') {
  if (active.value || a.protected) return
  if (action === 'stop' && !window.confirm(t(`Остановить «${a.title}»? Несохранённый прогресс игры будет потерян.`))) return
  const id = generation; controlling.value = true; message.value = ''
  try {
    await readRuntime(a.titleId); const r = runtime.value[a.titleId]
    if (id !== generation) return
    if (!r || runtimeError.value[a.titleId]) throw new Error(runtimeError.value[a.titleId] || 'Не удалось проверить приложение')
    if (action === 'stop' && !r.running) throw new Error('Приложение уже остановлено')
    const value = await $fetch('/api/ps4/apps/control', { method: 'POST', body: { ip: props.ip, requestId: requestId(), titleId: a.titleId, action, expected: action === 'stop' ? (r.appId >>> 0).toString(16).toUpperCase().padStart(8, '0') : '' } })
    if (id === generation) { control.value = value; await pollControl() }
  } catch (e) { if (id === generation) message.value = errorText(e) }
  finally { if (id === generation) controlling.value = false }
}
async function refresh() {
  const id = generation; const ip = props.ip; loading.value = true; message.value = ''
  try {
    const value = await $fetch<ConsoleCatalog>('/api/ps4/apps', { query: { ip } })
    if (id !== generation) return
    catalog.value = { ...value, apps: value.apps.map(app => ({ ...app, title: displayTitle(app.titleId, app.title) })) }; details.value = {}; selected.value = ''; paired.value = true; emit('status', true)
  } catch (error) { if (id === generation) { message.value = errorText(error); emit('status', false) } }
  finally { if (id === generation) loading.value = false }
}
async function openApp(a: ConsoleApp) {
  if (selected.value === a.titleId) { selected.value = ''; return }
  selected.value = a.titleId; const id = generation; const ip = props.ip; detailLoading.value = true; message.value = ''
  try {
    const value = await $fetch<ConsoleDetails>('/api/ps4/apps/details', { query: { ip, titleId: a.titleId } })
    if (id === generation) { value.app.title = displayTitle(a.titleId, value.app.title); details.value = { ...details.value, [a.titleId]: value }; if (value.app.title !== a.titleId) a.title = value.app.title; a.version = value.app.version; await readRuntime(a.titleId) }
  } catch (error) { if (id === generation) message.value = errorText(error) }
  finally { if (id === generation) detailLoading.value = false }
}
function askRemove(d: ConsoleDetails, kind: RemovalKind, component?: ConsoleComponent) {
  if (active.value || !d.complete || d.app.protected) return
  const parts = kind === 'game' ? d.components : kind === 'dlcs' ? d.components.filter(c => c.kind === 'dlc') : component ? [component] : []
  if (!parts.length || parts.some(c => !c.canRemove)) return
  typedId.value = ''
  confirmation.value = { detail: d, kind, componentId: component?.id || 'all', title: kind === 'game' ? `Удалить игру «${d.app.title}» со всеми дополнениями?` : kind === 'dlcs' ? 'Удалить все DLC этой игры?' : `Удалить ${kindName(component!.kind)}: ${component!.title}?`, components: parts }
}
async function poll() {
  const id = generation; const ip = props.ip
  try {
    const value = await $fetch<RemoveOperation | null>('/api/ps4/apps/operation', { query: { ip } })
    if (id !== generation) return
    const justRemoved = value?.state === 'removed' && operation.value?.state !== 'removed'
    operation.value = value
    if (justRemoved) { emit('changed'); await refresh() }
  } catch (error) { if (id === generation && operation.value) operation.value = { ...operation.value, message: errorText(error) } }
  if (id === generation && (active.value || operation.value?.state === 'uncertain')) { clearTimeout(timer); timer = setTimeout(() => void poll(), 2500) }
}
async function remove() {
  const target = confirmation.value; if (!target || typedId.value !== target.detail.app.titleId || active.value) return
  const id = generation; const ip = props.ip; submitting.value = true; message.value = ''
  try {
    const value = await $fetch<RemoveOperation>('/api/ps4/apps/remove', { method: 'POST', body: { ip, requestId: requestId(), titleId: target.detail.app.titleId, kind: target.kind, componentId: target.componentId, revision: target.detail.revision, confirmTitleId: typedId.value } })
    if (id !== generation) return
    operation.value = value; confirmation.value = undefined
    if (value.state === 'removed') { emit('changed'); await refresh() }
  } catch (error) { if (id === generation) { confirmation.value = undefined; message.value = `${errorText(error)}. Проверяем сохранённое задание перед следующей командой`; operation.value = { requestId: '', titleId: target.detail.app.titleId, kind: target.kind, componentId: target.componentId, state: 'uncertain', pending: true, completed: 0, total: 0, error: 0, errorHex: '0x00000000', pollError: 0 } } }
  finally { if (id === generation) { submitting.value = false; void poll() } }
}
function inputCode(value: string) { const s = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); code.value = s.length > 3 ? `${s.slice(0, 3)}-${s.slice(3)}` : s }
async function pair() {
  const id = generation; pairing.value = true
  try {
    await $fetch('/api/ps4/service-key', { method: 'POST', body: { ip: props.ip, code: code.value } })
    if (id === generation) { code.value = ''; paired.value = true; await refresh() }
  } catch (error) { if (id === generation) message.value = errorText(error) }
  finally { if (id === generation) pairing.value = false }
}
async function initialize() {
  generation++; clearTimeout(timer); catalog.value = undefined; details.value = {}; operation.value = null; confirmation.value = undefined; loading.value = false; detailLoading.value = false; submitting.value = false; pairing.value = false; selected.value = ''; message.value = ''; code.value = ''; paired.value = false; emit('status', false)
  try { dismissedOperation.value = localStorage.getItem(dismissalKey()) || '' } catch { dismissedOperation.value = '' }
  const id = generation
  try { const result = await $fetch<{ configured: boolean }>('/api/ps4/service-installer', { query: { ip: props.ip } }); if (id === generation) paired.value = result.configured } catch { /* List request supplies the useful error. */ }
  if (id !== generation) return
  runtime.value = {}; runtimeError.value = {}; control.value = null; iconFailures.value = {}; controlling.value = false
  await pollControl(); await poll(); await refresh()
}
watch(() => props.ip, () => void initialize())
onMounted(() => { void initialize(); runtimeTimer = setInterval(() => { if (document.visibilityState === 'visible') { if (control.value && ['pending', 'uncertain'].includes(control.value.state)) void pollControl(); else if (selected.value && !active.value) void readRuntime(selected.value) } }, 4000) })
onBeforeUnmount(() => { generation++; clearTimeout(timer); clearInterval(runtimeTimer); emit('status', false) })
</script>

<template>
  <div class="console-apps">
    <header><div><p class="eyebrow">PLAYSTATION 4</p><h1>{{ t("На консоли") }}</h1><p>{{ t("Установленные игры, патчи / бэкпорты и DLC на") }} {{ ip }}.</p></div><button :disabled="loading" @click="refresh">{{ t(loading ? 'Читаем PS4…' : 'Обновить список') }}</button></header>
    <div v-if="message" class="notice notice-row" role="alert"><span>{{ t(message) }}</span><button class="dismiss" type="button" :aria-label="t(&quot;Скрыть уведомление&quot;)" @click="message = ''">×</button></div>
    <div v-if="control?.action === 'restart' && ['pending', 'uncertain'].includes(control.state)" class="notice restart-notice" role="status">{{ t("Перезапуск сервиса ещё не подтверждён. Откройте PackageFlowService на PS4, затем проверьте результат. Пока установка обновления не завершена, изменяющие команды недоступны.") }}<button type="button" @click="pollControl">{{ t("Проверить результат") }}</button></div>
    <form v-if="!paired" class="pair-card" @submit.prevent="pair"><h2>{{ t("Подключить PackageFlowService") }}</h2><p>{{ t("Откройте запускатель на PS4 и введите код с экрана. Уже сохранённое подключение используется автоматически.") }}</p><label>{{ t("Код PS4") }} <input :value="code" placeholder="F7Y-YUH" maxlength="7" autocomplete="off" @input="inputCode(($event.target as HTMLInputElement).value)"></label><button :disabled="pairing || !/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(code)">{{ t(pairing ? 'Подключаем…' : 'Подключить') }}</button></form>
    <section v-if="operation && (!operation.requestId || operation.requestId !== dismissedOperation)" class="operation" aria-live="polite"><div class="operation-heading"><h2>{{ t(statusLabels[operation.state]) }}</h2><button v-if="['removed', 'failed', 'partial'].includes(operation.state)" class="dismiss" type="button" :aria-label="t(&quot;Скрыть уведомление об удалении&quot;)" @click="dismissOperation">×</button></div><p>{{ operation.titleId }} · {{ t(operation.kind === 'game' ? 'Вся игра' : operation.kind === 'patch' ? 'Патч / бэкпорт' : operation.kind === 'dlcs' ? 'Все DLC' : `DLC ${operation.componentId}`) }}</p><progress v-if="operation.total" :value="operation.completed" :max="operation.total"/><p>{{ t(operation.completed) }} {{ t("из") }} {{ t(operation.total || '—') }} {{ t("компонентов ·") }} {{ t(operation.state === 'verifying' ? 'Команды выполнены, проверяем результат' : operation.state === 'removed' ? 'Компоненты больше не обнаружены на PS4' : 'Подтверждённые системные команды') }}</p><p v-if="operation.error">{{ t("Ошибка PS4:") }} {{ t(operation.errorHex) }}</p><p v-if="operation.pollError">{{ t("Ошибка проверки:") }} {{ t(operation.pollError) }}</p><p v-if="operation.message">{{ t(operation.message) }}</p><button v-if="!active" @click="poll">{{ t("Проверить результат") }}</button></section>
    <div v-if="catalog" class="search"><input v-model="query" type="search" :aria-label="t(&quot;Поиск установленных игр&quot;)" :placeholder="t(&quot;Название или CUSA&quot;)"><span>{{ t(catalog.apps.length) }} {{ t("приложений") }}</span></div>
    <p v-if="catalog && !catalog.complete" class="notice">{{ t("Список прочитан не полностью. В том числе проверьте, подключён ли внешний диск.") }}</p>
    <p v-if="catalog && !visible.length" class="empty">{{ t(query ? 'Ничего не найдено.' : 'Установленных приложений не найдено.') }}</p>
    <article v-for="a in visible" :key="a.titleId" class="game-card">
      <button class="game-title" :disabled="loading" :aria-expanded="selected === a.titleId" @click="openApp(a)"><span class="game-icon"><img v-if="icon(a)" :src="icon(a)" alt="" loading="lazy" @error="iconFailures[a.titleId] = (iconFailures[a.titleId] || 0) + 1"><template v-else>{{ t(a.title.slice(0, 1)) }}</template></span><span><strong>{{ a.title }}</strong><small>{{ a.titleId }} · {{ t(a.version || 'Версия неизвестна') }}<template v-if="a.protected"> {{ t("· Только просмотр") }}</template></small></span><span class="expand">{{ t(selected === a.titleId ? '−' : '+') }}</span></button>
      <div v-if="selected === a.titleId" class="game-detail"><p v-if="detailLoading">{{ t("Читаем состав игры…") }}</p><template v-else-if="details[a.titleId]">
        <div v-if="!a.protected" class="app-controls"><span>{{ t(runtime[a.titleId] ? runtime[a.titleId]!.running ? 'Запущено' : 'Остановлено' : runtimeError[a.titleId] ? 'Состояние недоступно' : 'Проверяем состояние…') }}</span><button :disabled="active || !runtime[a.titleId] || runtime[a.titleId]!.running" @click="act(a, 'launch')">{{ t("Запустить") }}</button><button :disabled="active || !runtime[a.titleId]?.running" @click="act(a, 'stop')">{{ t("Остановить") }}</button></div><p v-if="runtimeError[a.titleId]" class="notice">{{ t("Кнопки станут доступны после ответа PS4:") }} {{ t(runtimeError[a.titleId]) }}</p><p v-if="control?.titleId === a.titleId">{{ t(control.state === 'running' ? 'Запуск подтверждён PS4' : control.state === 'stopped' ? 'Остановка подтверждена PS4' : control.state === 'failed' ? `Команда не выполнена: ${control.message || control.errorHex}` : 'Ожидаем подтверждения PS4; повтор не отправляется') }}<button v-if="control.state === 'uncertain'" @click="pollControl">{{ t("Проверить") }}</button></p><p v-if="!details[a.titleId]!.complete" class="notice">{{ t("Состав прочитан не полностью. Удаление отключено до полной проверки.") }}</p>
        <div v-for="c in details[a.titleId]!.components" :key="`${c.kind}/${c.id}`" class="component"><div><span class="tag">{{ t(kindName(c.kind)) }}</span><strong>{{ c.title }}</strong><small>{{ t(c.version ? `Версия ${c.version} · ` : '') }}{{ t(size(c.sizeBytes)) }} · {{ t(storage(c.storage)) }}</small><small v-if="c.kind === 'dlc'">{{ t(c.id) }}</small><small v-if="!c.canRemove && !a.protected">{{ t("Метаданные компонента недоступны для удаления.") }}</small></div><button v-if="c.kind !== 'base'" class="remove-button" :disabled="active || !c.canRemove || !details[a.titleId]!.complete" @click="askRemove(details[a.titleId]!, c.kind === 'patch' ? 'patch' : 'dlc', c)">{{ t("Удалить") }}</button></div>
        <p v-if="!details[a.titleId]!.components.length">{{ t("Файлы компонентов недоступны. Подключите диск с игрой и обновите список.") }}</p>
        <footer v-if="!a.protected"><p>{{ t("Сохранения остаются на PS4. Бэкпорт отображается в составе установленного патча.") }}</p><div><button @click="emit('saves', a.titleId)">{{ t("Сохранения игры") }}</button><button v-if="details[a.titleId]!.components.some(c => c.kind === 'dlc')" :disabled="active || !details[a.titleId]!.complete || details[a.titleId]!.components.some(c => c.kind === 'dlc' && !c.canRemove)" @click="askRemove(details[a.titleId]!, 'dlcs')">{{ t("Удалить все DLC") }}</button><button class="remove-button" :disabled="active || !details[a.titleId]!.complete || !details[a.titleId]!.components.some(c => c.kind === 'base') || details[a.titleId]!.components.some(c => !c.canRemove)" @click="askRemove(details[a.titleId]!, 'game')">{{ t("Удалить игру целиком") }}</button></div></footer>
      </template></div>
    </article>
    <div v-if="confirmation" class="modal-backdrop" @click.self="!submitting && (confirmation = undefined)"><section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-heading"><h2 id="remove-heading">{{ t(confirmation.title) }}</h2><p>{{ confirmation.detail.app.title }} · {{ confirmation.detail.app.titleId }}</p><ul><li v-for="c in confirmation.components" :key="`${c.kind}/${c.id}`">{{ t(kindName(c.kind)) }} — {{ c.title }}<template v-if="c.kind === 'dlc'"> ({{ t(c.id) }})</template></li></ul><p>{{ t("Будут удалены перечисленные компоненты на PS4. Сохранения остаются.") }}</p><form @submit.prevent="remove"><label>{{ t("Для подтверждения введите") }} {{ confirmation.detail.app.titleId }}<input v-model="typedId" autofocus autocomplete="off" spellcheck="false" :disabled="submitting"></label><div class="dialog-actions"><button type="button" :disabled="submitting" @click="confirmation = undefined">{{ t("Отмена") }}</button><button class="remove-button" :disabled="submitting || active || typedId !== confirmation.detail.app.titleId">{{ t(submitting ? 'Отправляем…' : 'Удалить на PS4') }}</button></div></form></section></div>
  </div>
</template>

<style scoped>
.game-icon { flex: none; overflow: hidden; } .game-icon img { width: 100%; height: 100%; object-fit: cover; } .app-controls { display: flex; align-items: center; gap: 12px; padding: 18px 0; color: #b5a9ca; font-size: 12px; } .app-controls span { margin-right: auto; } .console-apps { max-width: 1000px; } header { display: flex; justify-content: space-between; align-items: center; gap: 20px; } h1 { margin: 0; font-size: 30px; } h2 { font-size: 16px; margin: 0 0 10px; } p { color: #a9a6b2; font-size: 13px; line-height: 1.65; } .eyebrow { color: #978ae1; font-size: 10px; letter-spacing: 1.3px; } button { background: #29272f; border: 1px solid #45404f; border-radius: 7px; color: #e8e2f4; padding: 10px 14px; font-size: 12px; } input { background: #151419; border: 1px solid #45404f; border-radius: 7px; color: #eee9f7; padding: 11px 13px; } .notice { border: 1px solid #766137; background: #292318; padding: 14px 18px; border-radius: 8px; color: #dabb88; } .pair-card, .operation { border: 1px solid #393342; border-radius: 10px; padding: 22px; margin: 22px 0; background: #1c1a20; } .pair-card label { margin-right: 12px; } .search { display: flex; gap: 18px; align-items: center; margin: 28px 0 18px; } .search input { width: 340px; } .search span, small { color: #a6a0af; font-size: 12px; } .game-card { background: #1b1a1f; border: 1px solid #343039; border-radius: 10px; margin-bottom: 14px; overflow: hidden; } .game-title { display: flex; align-items: center; gap: 16px; width: 100%; border: 0; border-radius: 0; padding: 20px; text-align: left; background: transparent; } .game-title strong { font-size: 16px; } small { display: block; margin-top: 7px; overflow-wrap: anywhere; } .game-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 9px; color: #bfb1ee; background: #383144; font-size: 22px; } .expand { margin-left: auto; font-size: 22px; color: #ad9be3; } .game-detail { padding: 0 22px 20px; border-top: 1px solid #302c36; } .component { display: flex; align-items: center; justify-content: space-between; padding: 18px 0; border-bottom: 1px solid #302c36; gap: 16px; } .component strong { display: block; font-size: 14px; margin-top: 8px; } .tag { color: #b9a6ef; font-size: 11px; } .remove-button { background: #3d252b; border-color: #74404b; color: #f2b5be; } footer { margin-top: 18px; } footer div { display: flex; gap: 10px; justify-content: flex-end; } .operation progress { width: 100%; accent-color: #9781df; } .modal-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 24px; background: #000b; } .confirm-dialog { background: #201d26; border: 1px solid #61516f; border-radius: 12px; padding: 28px; max-width: 620px; width: 100%; max-height: 85vh; overflow: auto; } .confirm-dialog ul { color: #c8bed5; line-height: 1.8; font-size: 13px; } .confirm-dialog label { display: flex; flex-direction: column; gap: 12px; font-size: 13px; color: #d6ccdf; } .dialog-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 22px; }
.operation-heading, .notice-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }.operation-heading h2 { margin: 0; }.dismiss { flex: none; padding: 0 6px; border: 0; background: transparent; color: inherit; font-size: 22px; line-height: 1; cursor: pointer; }.dismiss:hover { color: #fff; }
.restart-notice { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.restart-notice button { flex: none; }
</style>

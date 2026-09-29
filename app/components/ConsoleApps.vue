<script setup lang="ts">
import type { ConsoleApp, ConsoleCatalog, ConsoleComponent, ConsoleDetails, RemovalKind, RemoveOperation } from '../../shared/types/console-apps'
const props = defineProps<{ ip: string }>()
const emit = defineEmits<{ status: [ready: boolean]; changed: [] }>()
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
const submitting = ref(false)
const confirmation = ref<{ detail: ConsoleDetails; kind: RemovalKind; componentId: string; title: string; components: ConsoleComponent[] }>()
const typedId = ref('')
let generation = 0
let timer: ReturnType<typeof setTimeout> | undefined
const active = computed(() => submitting.value || operation.value?.pending || ['queued', 'running', 'verifying'].includes(operation.value?.state || ''))
const visible = computed(() => (catalog.value?.apps || []).filter(a => `${a.title} ${a.titleId}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())))
const statusLabels: Record<string, string> = { queued: 'Принято PS4', running: 'Удаляем компоненты', verifying: 'Проверяем, что компоненты удалены', removed: 'Удаление подтверждено PS4', failed: 'Удаление не выполнено', partial: 'Удалена только часть компонентов', uncertain: 'Результат пока не подтверждён' }
function errorText(error: any) { return error?.data?.message || error?.message || 'Не удалось связаться с PS4' }
function kindName(kind: string) { return kind === 'base' ? 'Игра' : kind === 'patch' ? 'Патч / бэкпорт' : 'DLC' }
function size(bytes: number) { return `${(bytes / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ГиБ` }
function storage(value: string) { return value === 'internal' ? 'Внутренний диск' : value === 'external' ? 'Внешний диск' : 'Внутренний и внешний диски' }
async function refresh() {
  const id = generation; const ip = props.ip; loading.value = true; message.value = ''
  try {
    const value = await $fetch<ConsoleCatalog>('/api/ps4/apps', { query: { ip } })
    if (id !== generation) return
    catalog.value = value; details.value = {}; selected.value = ''; paired.value = true; emit('status', true)
  } catch (error) { if (id === generation) { message.value = errorText(error); emit('status', false) } }
  finally { if (id === generation) loading.value = false }
}
async function openApp(a: ConsoleApp) {
  if (selected.value === a.titleId) { selected.value = ''; return }
  selected.value = a.titleId; const id = generation; const ip = props.ip; detailLoading.value = true; message.value = ''
  try {
    const value = await $fetch<ConsoleDetails>('/api/ps4/apps/details', { query: { ip, titleId: a.titleId } })
    if (id === generation) details.value = { ...details.value, [a.titleId]: value }
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
    const value = await $fetch<RemoveOperation>('/api/ps4/apps/remove', { method: 'POST', body: { ip, requestId: crypto.randomUUID(), titleId: target.detail.app.titleId, kind: target.kind, componentId: target.componentId, revision: target.detail.revision, confirmTitleId: typedId.value } })
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
  const id = generation
  try { const result = await $fetch<{ configured: boolean }>('/api/ps4/service-installer', { query: { ip: props.ip } }); if (id === generation) paired.value = result.configured } catch { /* List request supplies the useful error. */ }
  if (id !== generation) return
  await poll(); if (!active.value) await refresh()
}
watch(() => props.ip, () => void initialize())
onMounted(() => void initialize())
onBeforeUnmount(() => { generation++; clearTimeout(timer); emit('status', false) })
</script>

<template>
  <div class="console-apps">
    <header><div><p class="eyebrow">PLAYSTATION 4</p><h1>На консоли</h1><p>Установленные игры, патчи / бэкпорты и DLC на {{ ip }}.</p></div><button :disabled="loading || active" @click="refresh">{{ loading ? 'Читаем PS4…' : 'Обновить список' }}</button></header>
    <p v-if="message" class="notice" role="alert">{{ message }}</p>
    <form v-if="!paired" class="pair-card" @submit.prevent="pair"><h2>Подключить PackegeFlowService</h2><p>Откройте запускатель на PS4 и введите код с экрана. Уже сохранённое подключение используется автоматически.</p><label>Код PS4 <input :value="code" placeholder="F7Y-YUH" maxlength="7" autocomplete="off" @input="inputCode(($event.target as HTMLInputElement).value)"></label><button :disabled="pairing || !/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(code)">{{ pairing ? 'Подключаем…' : 'Подключить' }}</button></form>
    <section v-if="operation" class="operation" aria-live="polite"><h2>{{ statusLabels[operation.state] }}</h2><p>{{ operation.titleId }} · {{ operation.kind === 'game' ? 'Вся игра' : operation.kind === 'patch' ? 'Патч / бэкпорт' : operation.kind === 'dlcs' ? 'Все DLC' : `DLC ${operation.componentId}` }}</p><progress v-if="operation.total" :value="operation.completed" :max="operation.total"/><p>{{ operation.completed }} из {{ operation.total || '—' }} компонентов · {{ operation.state === 'verifying' ? 'Команды выполнены, проверяем результат' : operation.state === 'removed' ? 'Компоненты больше не обнаружены на PS4' : 'Подтверждённые системные команды' }}</p><p v-if="operation.error">Ошибка PS4: {{ operation.errorHex }}</p><p v-if="operation.pollError">Ошибка проверки: {{ operation.pollError }}</p><p v-if="operation.message">{{ operation.message }}</p><button v-if="!active" @click="poll">Проверить результат</button></section>
    <div v-if="catalog" class="search"><input v-model="query" type="search" aria-label="Поиск установленных игр" placeholder="Название или CUSA"><span>{{ catalog.apps.length }} приложений</span></div>
    <p v-if="catalog && !catalog.complete" class="notice">Список прочитан не полностью. В том числе проверьте, подключён ли внешний диск.</p>
    <p v-if="catalog && !visible.length" class="empty">{{ query ? 'Ничего не найдено.' : 'Установленных приложений не найдено.' }}</p>
    <article v-for="a in visible" :key="a.titleId" class="game-card">
      <button class="game-title" :disabled="active || loading" :aria-expanded="selected === a.titleId" @click="openApp(a)"><span class="game-icon">{{ a.title.slice(0, 1) }}</span><span><strong>{{ a.title }}</strong><small>{{ a.titleId }} · {{ a.version || 'Версия неизвестна' }}<template v-if="a.protected"> · Только просмотр</template></small></span><span class="expand">{{ selected === a.titleId ? '−' : '+' }}</span></button>
      <div v-if="selected === a.titleId" class="game-detail"><p v-if="detailLoading">Читаем состав игры…</p><template v-else-if="details[a.titleId]">
        <p v-if="!details[a.titleId]!.complete" class="notice">Состав прочитан не полностью. Удаление отключено до полной проверки.</p>
        <div v-for="c in details[a.titleId]!.components" :key="`${c.kind}/${c.id}`" class="component"><div><span class="tag">{{ kindName(c.kind) }}</span><strong>{{ c.title }}</strong><small>{{ c.version ? `Версия ${c.version} · ` : '' }}{{ size(c.sizeBytes) }} · {{ storage(c.storage) }}</small><small v-if="c.kind === 'dlc'">{{ c.id }}</small><small v-if="!c.canRemove && !a.protected">Метаданные компонента недоступны для удаления.</small></div><button v-if="c.kind !== 'base'" class="remove-button" :disabled="active || !c.canRemove || !details[a.titleId]!.complete" @click="askRemove(details[a.titleId]!, c.kind === 'patch' ? 'patch' : 'dlc', c)">Удалить</button></div>
        <p v-if="!details[a.titleId]!.components.length">Файлы компонентов недоступны. Подключите диск с игрой и обновите список.</p>
        <footer v-if="!a.protected"><p>Сохранения остаются на PS4. Бэкпорт отображается в составе установленного патча.</p><div><button v-if="details[a.titleId]!.components.some(c => c.kind === 'dlc')" :disabled="active || !details[a.titleId]!.complete || details[a.titleId]!.components.some(c => c.kind === 'dlc' && !c.canRemove)" @click="askRemove(details[a.titleId]!, 'dlcs')">Удалить все DLC</button><button class="remove-button" :disabled="active || !details[a.titleId]!.complete || !details[a.titleId]!.components.some(c => c.kind === 'base') || details[a.titleId]!.components.some(c => !c.canRemove)" @click="askRemove(details[a.titleId]!, 'game')">Удалить игру целиком</button></div></footer>
      </template></div>
    </article>
    <div v-if="confirmation" class="modal-backdrop" @click.self="!submitting && (confirmation = undefined)"><section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="remove-heading"><h2 id="remove-heading">{{ confirmation.title }}</h2><p>{{ confirmation.detail.app.title }} · {{ confirmation.detail.app.titleId }}</p><ul><li v-for="c in confirmation.components" :key="`${c.kind}/${c.id}`">{{ kindName(c.kind) }} — {{ c.title }}<template v-if="c.kind === 'dlc'"> ({{ c.id }})</template></li></ul><p>Будут удалены перечисленные компоненты на PS4. Сохранения остаются.</p><form @submit.prevent="remove"><label>Для подтверждения введите {{ confirmation.detail.app.titleId }}<input v-model="typedId" autofocus autocomplete="off" spellcheck="false" :disabled="submitting"></label><div class="dialog-actions"><button type="button" :disabled="submitting" @click="confirmation = undefined">Отмена</button><button class="remove-button" :disabled="submitting || active || typedId !== confirmation.detail.app.titleId">{{ submitting ? 'Отправляем…' : 'Удалить на PS4' }}</button></div></form></section></div>
  </div>
</template>

<style scoped>
.console-apps { max-width: 1000px; } header { display: flex; justify-content: space-between; align-items: center; gap: 20px; } h1 { margin: 0; font-size: 30px; } h2 { font-size: 16px; margin: 0 0 10px; } p { color: #a9a6b2; font-size: 13px; line-height: 1.65; } .eyebrow { color: #978ae1; font-size: 10px; letter-spacing: 1.3px; } button { background: #29272f; border: 1px solid #45404f; border-radius: 7px; color: #e8e2f4; padding: 10px 14px; font-size: 12px; } input { background: #151419; border: 1px solid #45404f; border-radius: 7px; color: #eee9f7; padding: 11px 13px; } .notice { border: 1px solid #766137; background: #292318; padding: 14px 18px; border-radius: 8px; color: #dabb88; } .pair-card, .operation { border: 1px solid #393342; border-radius: 10px; padding: 22px; margin: 22px 0; background: #1c1a20; } .pair-card label { margin-right: 12px; } .search { display: flex; gap: 18px; align-items: center; margin: 28px 0 18px; } .search input { width: 340px; } .search span, small { color: #a6a0af; font-size: 12px; } .game-card { background: #1b1a1f; border: 1px solid #343039; border-radius: 10px; margin-bottom: 14px; overflow: hidden; } .game-title { display: flex; align-items: center; gap: 16px; width: 100%; border: 0; border-radius: 0; padding: 20px; text-align: left; background: transparent; } .game-title strong { font-size: 16px; } small { display: block; margin-top: 7px; overflow-wrap: anywhere; } .game-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 9px; color: #bfb1ee; background: #383144; font-size: 22px; } .expand { margin-left: auto; font-size: 22px; color: #ad9be3; } .game-detail { padding: 0 22px 20px; border-top: 1px solid #302c36; } .component { display: flex; align-items: center; justify-content: space-between; padding: 18px 0; border-bottom: 1px solid #302c36; gap: 16px; } .component strong { display: block; font-size: 14px; margin-top: 8px; } .tag { color: #b9a6ef; font-size: 11px; } .remove-button { background: #3d252b; border-color: #74404b; color: #f2b5be; } footer { margin-top: 18px; } footer div { display: flex; gap: 10px; justify-content: flex-end; } .operation progress { width: 100%; accent-color: #9781df; } .modal-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 24px; background: #000b; } .confirm-dialog { background: #201d26; border: 1px solid #61516f; border-radius: 12px; padding: 28px; max-width: 620px; width: 100%; max-height: 85vh; overflow: auto; } .confirm-dialog ul { color: #c8bed5; line-height: 1.8; font-size: 13px; } .confirm-dialog label { display: flex; flex-direction: column; gap: 12px; font-size: 13px; color: #d6ccdf; } .dialog-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 22px; }
</style>

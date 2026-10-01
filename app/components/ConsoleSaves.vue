<script setup lang="ts">
const props = defineProps<{ ip: string; focusTitleId?: string }>()
interface SaveGame { titleId: string; title: string; installed: boolean | null }
interface SaveUser { userId: string; games: SaveGame[] }
interface SaveSlot { name: string; containerBytes: number; modifiedAt: number }
interface SaveBackup { id: string; slot: string; createdAt: string; files: number; bytes: number }
interface SaveRestore { rollbackId: string; slot: string; sourceBackupId: string; safetyBackupId: string; createdAt: string; state: string }
const users = ref<SaveUser[]>([])
const selectedUser = ref('')
const selectedTitle = ref('')
const slots = ref<SaveSlot[]>([])
const backups = ref<SaveBackup[]>([])
const restores = ref<SaveRestore[]>([])
const query = ref('')
const loading = ref(false)
const loadingSlots = ref(false)
const creatingSlot = ref('')
const downloadingId = ref('')
const error = ref('')
const notice = ref('')
const restoreActionId = ref('')
const expandedBackupSlots = ref<string[]>([])
let generation = 0
let slotGeneration = 0
let initialFocus = true
const currentUser = computed(() => users.value.find(user => user.userId === selectedUser.value))
const visibleGames = computed(() => (currentUser.value?.games || []).filter(game =>
  `${game.title} ${game.titleId}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())))
function errorText(cause: unknown) {
  const issue = cause as { data?: { message?: string }; message?: string }
  return issue.data?.message || issue.message || 'Не удалось прочитать сохранения PS4'
}
function bytes(size: number) {
  if (size < 1024) return `${size} Б`
  const unit = size < 1024 ** 2 ? 'КБ' : size < 1024 ** 3 ? 'МБ' : 'ГБ'
  const divisor = unit === 'КБ' ? 1024 : unit === 'МБ' ? 1024 ** 2 : 1024 ** 3
  return `${(size / divisor).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${unit}`
}
async function refresh() {
  const id = ++generation
  loading.value = true; error.value = ''
  try {
    const result = await $fetch<{ users: SaveUser[] }>('/api/ps4/saves', { method: 'POST', body: { ip: props.ip } })
    if (id !== generation) return
    users.value = result.users
    const focused = initialFocus && props.focusTitleId && result.users.find(user => user.games.some(game => game.titleId === props.focusTitleId))
    initialFocus = false
    selectedUser.value = focused?.userId || (result.users.some(user => user.userId === selectedUser.value) ? selectedUser.value : result.users[0]?.userId || '')
    if (focused) { selectedTitle.value = props.focusTitleId!; await openGame(props.focusTitleId!) }
    else if (!currentUser.value?.games.some(game => game.titleId === selectedTitle.value)) { selectedTitle.value = ''; slots.value = []; backups.value = []; restores.value = [] }
  } catch (cause) { if (id === generation) error.value = errorText(cause) }
  finally { if (id === generation) loading.value = false }
}
async function openGame(titleId: string) {
  const id = generation
  const slotId = ++slotGeneration
  selectedTitle.value = titleId; slots.value = []; backups.value = []; restores.value = []; loadingSlots.value = true; error.value = ''
  try {
    const [result, previous] = await Promise.all([
      $fetch<{ slots: SaveSlot[] }>('/api/ps4/saves/slots', { method: 'POST', body: { ip: props.ip, userId: selectedUser.value, titleId } }),
      $fetch<{ backups: SaveBackup[]; restores: SaveRestore[] }>('/api/ps4/saves/backups', { method: 'POST', body: { ip: props.ip, userId: selectedUser.value, titleId } }),
    ])
    if (id === generation && slotId === slotGeneration && selectedTitle.value === titleId) { slots.value = result.slots; backups.value = previous.backups; restores.value = previous.restores }
  } catch (cause) { if (id === generation && slotId === slotGeneration) error.value = errorText(cause) }
  finally { if (id === generation && slotId === slotGeneration) loadingSlots.value = false }
}
function toggleGame(titleId: string) {
  if (selectedTitle.value === titleId) { slotGeneration++; selectedTitle.value = ''; slots.value = []; backups.value = []; restores.value = []; return }
  void openGame(titleId)
}
function chooseUser(userId: string) { slotGeneration++; selectedUser.value = userId; selectedTitle.value = ''; slots.value = []; backups.value = []; restores.value = [] }
function slotBackups(slot: string) { return backups.value.filter(item => item.slot === slot) }
function visibleBackups(slot: string) { const items = slotBackups(slot); return expandedBackupSlots.value.includes(slot) ? items : items.slice(0, 1) }
function toggleBackups(slot: string) {
  expandedBackupSlots.value = expandedBackupSlots.value.includes(slot)
    ? expandedBackupSlots.value.filter(item => item !== slot) : [...expandedBackupSlots.value, slot]
}
async function restoreBackup(backup: SaveBackup) {
  if (restoreActionId.value || !window.confirm(`Восстановить копию ${new Date(backup.createdAt).toLocaleString('ru-RU')} для ${backup.slot}? Сначала закройте игру. Текущее сохранение будет скопировано для отката.`)) return
  restoreActionId.value = backup.id; error.value = ''; notice.value = ''
  const titleId = selectedTitle.value
  try {
    await $fetch('/api/ps4/saves/restore', { method: 'POST', body: { ip: props.ip, id: backup.id } })
    notice.value = 'Файлы восстановлены. Запустите игру и проверьте прогресс. Затем подтвердите результат или верните прежний сейв.'
    await openGame(titleId)
  } catch (cause) { error.value = errorText(cause) }
  finally { restoreActionId.value = '' }
}
async function settleRestore(record: SaveRestore, action: 'finalize' | 'rollback') {
  if (restoreActionId.value) return
  const prompt = action === 'finalize'
    ? 'Игра открыла восстановленный сейв? Подтверждение удалит временный откат на PS4; скачанные копии останутся.'
    : 'Вернуть сейв, который был на PS4 до восстановления? Закройте игру. Прогресс, созданный после восстановления, будет заменён.'
  if (!window.confirm(prompt)) return
  restoreActionId.value = record.rollbackId; error.value = ''; notice.value = ''
  const titleId = selectedTitle.value
  try {
    await $fetch(`/api/ps4/saves/${action}`, { method: 'POST', body: { ip: props.ip, id: record.rollbackId } })
    notice.value = action === 'finalize' ? 'Восстановление подтверждено.' : 'Предыдущий сейв возвращён. Проверьте его в игре.'
    await openGame(titleId)
  } catch (cause) { error.value = errorText(cause) }
  finally { restoreActionId.value = '' }
}
async function downloadBackup(backup: SaveBackup) {
  downloadingId.value = backup.id; error.value = ''
  try {
    const archive = await $fetch<Blob>('/api/ps4/saves/archive', { method: 'POST', body: { id: backup.id }, responseType: 'blob' })
    const url = URL.createObjectURL(archive)
    const link = document.createElement('a')
    link.href = url; link.download = `${selectedTitle.value}-${backup.slot}-${backup.id}.zip`
    document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (cause) { error.value = errorText(cause) }
  finally { downloadingId.value = '' }
}
async function createBackup(slot: SaveSlot) {
  if (creatingSlot.value) return
  const userId = selectedUser.value, titleId = selectedTitle.value
  creatingSlot.value = slot.name; error.value = ''
  try {
    const result = await $fetch<SaveBackup>('/api/ps4/saves/export', { method: 'POST', body: { ip: props.ip, userId, titleId, slot: slot.name } })
    if (userId === selectedUser.value && titleId === selectedTitle.value) {
      backups.value.unshift({ ...result, createdAt: new Date().toISOString() })
      notice.value = `Копия слота ${slot.name} создана. Её можно скачать или восстановить из списка ниже.`
    }
  } catch (cause) { error.value = errorText(cause) }
  finally { creatingSlot.value = '' }
}
async function createAllBackups() {
  if (creatingSlot.value || !slots.value.length) return
  const titleId = selectedTitle.value, userId = selectedUser.value
  creatingSlot.value = 'all'; error.value = ''; notice.value = ''
  let completed = 0
  try {
    for (const slot of slots.value) {
      const result = await $fetch<SaveBackup>('/api/ps4/saves/export', { method: 'POST', body: { ip: props.ip, userId, titleId, slot: slot.name } })
      backups.value.unshift({ ...result, createdAt: new Date().toISOString() })
      completed++
    }
    notice.value = `Созданы копии всех ${completed} слотов игры. Их можно скачать по отдельности.`
  } catch (cause) { error.value = `${errorText(cause)}. Успешно сохранено слотов: ${completed} из ${slots.value.length}.` }
  finally { creatingSlot.value = '' }
}
onMounted(() => void refresh())
watch(() => props.ip, () => void refresh())
watch(() => props.focusTitleId, titleId => {
  if (!titleId || !users.value.length) return
  const user = users.value.find(item => item.games.some(game => game.titleId === titleId))
  if (user) { selectedUser.value = user.userId; void openGame(titleId) }
})
</script>

<template>
  <section class="saves-page">
    <header><div><p class="eyebrow">PLAYSTATION 4</p><h1>Сохранения</h1><p>Сейвы остаются в этом списке, даже если игра удалена с приставки.</p></div><button :disabled="loading" @click="refresh">{{ loading ? 'Читаем…' : 'Обновить список' }}</button></header>
    <SaveCollections :ip="props.ip" :users="users" />
    <h2 class="separate-title">Отдельные копии игр и слотов</h2>
    <p>Слот — одно сохранение внутри игры. Копия игры сохраняет все её слоты. Именной набор выше охватывает все игры и профили PS4.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <div v-if="users.length" class="filters"><label>Профиль PS4 <select v-model="selectedUser" @change="chooseUser(selectedUser)"><option v-for="(user, index) in users" :key="user.userId" :value="user.userId">Профиль {{ index + 1 }} · {{ user.games.length }} игр</option></select></label><input v-model="query" placeholder="Название или CUSA" aria-label="Найти сохранения игры"></div>
    <p v-if="!loading && !users.length && !error" class="empty">Сохранения не найдены.</p>
    <p v-else-if="!loading && !visibleGames.length && !error" class="empty">Для этого профиля игр с сохранениями не найдено.</p>
    <div v-for="game in visibleGames" :key="game.titleId" class="game">
      <button class="game-button" :aria-expanded="selectedTitle === game.titleId" @click="toggleGame(game.titleId)">
        <span><strong>{{ game.title === game.titleId ? `Игра ${game.titleId}` : game.title }}</strong><small>{{ game.title === game.titleId ? '' : `${game.titleId} · ` }}{{ game.installed === true ? 'Игра установлена' : game.installed === false ? 'Игра сейчас не установлена' : 'Состояние игры неизвестно' }}</small></span><span class="expand">{{ selectedTitle === game.titleId ? '−' : '+' }}</span>
      </button>
      <div v-if="selectedTitle === game.titleId" class="slots">
        <p v-if="loadingSlots">Читаем слоты…</p><p v-else-if="!slots.length">Слоты не найдены. Обновите список, если игра только что создала сейв.</p>
        <div v-if="slots.length" class="all-slots"><span>Для полной копии прогресса сохраните все слоты игры.</span><button :disabled="!!creatingSlot || !!restoreActionId" @click="createAllBackups">{{ creatingSlot === 'all' ? 'Копируем все слоты…' : 'Создать копию игры' }}</button></div>
        <div v-for="slot in slots" :key="slot.name" class="slot">
          <div class="slot-details">
            <strong>{{ slot.name }}</strong><small>Размер контейнера: {{ bytes(slot.containerBytes) }}</small>
            <div v-for="restore in restores.filter(item => item.slot === slot.name)" :key="restore.rollbackId" class="restore-check">
              <strong>Проверьте восстановление в игре</strong>
              <span>Пока результат не подтверждён, исходный сейв доступен для отката.</span>
              <div><button :disabled="!!restoreActionId" @click="settleRestore(restore, 'finalize')">Игра читает сейв</button><button :disabled="!!restoreActionId" @click="settleRestore(restore, 'rollback')">Вернуть прежний</button></div>
            </div>
            <div class="backup-list">
              <div v-for="backup in visibleBackups(slot.name)" :key="backup.id" class="backup-row">
                <span>Копия {{ new Date(backup.createdAt).toLocaleString('ru-RU') }} · {{ bytes(backup.bytes) }}</span>
                <button :disabled="!!downloadingId" @click="downloadBackup(backup)">{{ downloadingId === backup.id ? 'Подготовка…' : 'Скачать' }}</button>
                <button :disabled="!!restoreActionId || restores.some(item => item.slot === slot.name)" @click="restoreBackup(backup)">{{ restoreActionId === backup.id ? 'Восстанавливаем…' : 'Восстановить' }}</button>
              </div>
              <button v-if="slotBackups(slot.name).length > 1" class="more-backups" :aria-expanded="expandedBackupSlots.includes(slot.name)" @click="toggleBackups(slot.name)">{{ expandedBackupSlots.includes(slot.name) ? 'Скрыть старые копии' : `Показать ещё ${slotBackups(slot.name).length - 1} копий` }}</button>
            </div>
          </div>
          <button :disabled="!!creatingSlot" @click="createBackup(slot)">{{ creatingSlot === slot.name ? 'Копируем…' : 'Создать копию слота' }}</button>
        </div>
      </div>
    </div>
    <p class="note">Копии содержат только сохранения игр. Перед восстановлением закройте игру; после записи запустите её и подтвердите результат.</p>
  </section>
</template>

<style scoped>
.saves-page { max-width: 1000px; }
header { display: flex; justify-content: space-between; align-items: center; gap: 20px; }
h1 { margin: 0; font-size: 30px; }
.separate-title { margin: 24px 0 4px; font-size: 19px; }
p { color: #a9a6b2; font-size: 13px; line-height: 1.65; }
.eyebrow { color: #978ae1; font-size: 10px; letter-spacing: 1.3px; }
button, select, input { background: #29272f; border: 1px solid #45404f; border-radius: 7px; color: #e8e2f4; padding: 10px 14px; font-size: 12px; }
button:disabled { opacity: .5; }
.filters { display: flex; align-items: end; gap: 16px; margin: 26px 0 18px; }
.filters label { display: flex; flex-direction: column; gap: 7px; color: #a9a6b2; font-size: 11px; }
.filters input { min-width: 260px; }
.game { margin-bottom: 12px; border: 1px solid #343039; border-radius: 10px; overflow: hidden; background: #1b1a1f; }
.game-button { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 18px 20px; border: 0; border-radius: 0; background: transparent; text-align: left; }
.game-button strong, .slot strong { display: block; font-size: 14px; }
.game-button small, .slot small { display: block; margin-top: 5px; color: #aaa5b2; font-size: 11px; }
.expand { color: #ad9be3; font-size: 22px; }
.slots { padding: 8px 20px 16px; border-top: 1px solid #302c36; }
.all-slots { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; color: #bcb5c8; font-size: 12px; }
.slot { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid #302c36; }
.slot:last-child { border-bottom: 0; }
.slot > span { color: #a99be8; font-size: 11px; white-space: nowrap; }
.slot-details { min-width: 0; }
.backup-list { margin-top: 10px; }
.backup-row { display: flex; align-items: center; gap: 10px; margin-top: 5px; color: #aaa5b2; font-size: 11px; }
.backup-row span { min-width: 0; }
.more-backups { padding: 6px 0; border: 0; background: transparent; color: #ad9be3; }
.restore-check { margin-top: 12px; padding: 12px; border: 1px solid #625484; border-radius: 8px; background: #282331; color: #c7bed7; font-size: 12px; }
.restore-check strong, .restore-check span { display: block; margin-bottom: 8px; }
.restore-check > div { display: flex; gap: 8px; flex-wrap: wrap; }
.notice { padding: 14px 18px; border: 1px solid #625484; border-radius: 8px; color: #d7ccef; background: #282331; }
.note, .empty { margin-top: 20px; color: #9993a4; }
.error { padding: 14px 18px; border: 1px solid #895853; border-radius: 8px; color: #e8aaa2; background: #2b1e20; }
@media (max-width: 760px) { header, .filters, .slot, .backup-row, .all-slots { align-items: stretch; flex-direction: column; }.filters input { min-width: 0; } }
</style>

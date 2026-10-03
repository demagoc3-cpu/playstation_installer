<script setup lang="ts">
const { t, formatLocale } = useAppLocale()

import type { ConsolePackagePreview, ConsolePackageInstallation } from '../../shared/types/console-file-install'
const props = defineProps<{ psIp: string; showHistory: boolean }>()
const emit = defineEmits<{ busy: [value: boolean]; notice: [title: string, detail?: string, attention?: boolean] }>()
const modal = ref<HTMLDialogElement>(), preview = ref<ConsolePackagePreview>(), preparing = ref(false), starting = ref(false), error = ref('')
const jobs = ref<ConsolePackageInstallation[]>([])
const terminal = (j: ConsolePackageInstallation) => j.rejected || (!j.pending && !!j.job && ['installed', 'failed', 'cancelled'].includes(j.job.state))
const active = computed(() => jobs.value.filter(j => !terminal(j)))
const history = computed(() => jobs.value.filter(terminal))
const labels: Record<string, string> = { registering: 'Подготовка установки', downloading: 'Копирование PKG на консоли', installing: 'Системная установка', installed: 'Установка подтверждена PS4', failed: 'Ошибка установки', cancelling: 'Отменяем установку', cancelled: 'Установка отменена', uncertain: 'Проверяем системное задание' }
const state = (j: ConsolePackageInstallation) => j.rejected ? 'Команда не принята PS4' : j.job ? labels[j.job.state] : 'Проверяем принятую команду'
function detail(j: ConsolePackageInstallation) {
  if (j.error) return j.error
  if (!j.job?.error) return ''
  if (j.job.errorHex?.toLowerCase() === '0x80990015') return 'PS4 уже зарегистрировала задание для этого пакета. Проверьте «Уведомления → Загрузки» на консоли (0x80990015)'
  return `PS4: ${j.job.errorHex}`
}
const message = (cause: any) => cause?.data?.message || cause?.message || 'Нет ответа от PS4'
const bytes = (size: number) => `${(size / 1024 ** (size >= 1024 ** 3 ? 3 : 2)).toLocaleString(formatLocale.value, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false })} ${size >= 1024 ** 3 ? 'ГБ' : 'МБ'}`
function percent(j: ConsolePackageInstallation) {
  const job = j.job
  if (!job) return 0
  return Math.min(100, Math.max(0, job.localCopyPercent || (job.downloadTotalBytes ? Math.floor(job.downloadedBytes / job.downloadTotalBytes * 100) : 0)))
}
let timer: ReturnType<typeof setInterval> | undefined, polling = false, loaded = false
const submitted = new Set<string>()
watch(() => !!active.value.length || preparing.value || starting.value, value => emit('busy', value), { immediate: true })
async function poll() {
  if (polling) return
  polling = true; const ip = props.psIp
  try {
    const result = await $fetch<{ jobs: ConsolePackageInstallation[] }>('/api/ps4/files/install', { method: 'POST', body: { ip, action: 'list' } })
    if (ip !== props.psIp) return
    for (const record of result.jobs.filter(terminal)) {
      if ((loaded || submitted.has(record.id)) && (submitted.has(record.id) || jobs.value.find(j => j.id === record.id)?.job?.state !== record.job?.state)) {
        emit('notice', state(record), `${record.title}${detail(record) ? ` · ${detail(record)}` : ''}`, !!record.rejected || record.job?.state === 'failed')
        submitted.delete(record.id)
      }
    }
    jobs.value = result.jobs; loaded = true
  } catch (cause) { if (ip === props.psIp && active.value.length) error.value = message(cause) }
  finally { polling = false }
}
async function open(path: string) {
  if (preparing.value || starting.value || active.value.length) return
  const ip = props.psIp; preparing.value = true; error.value = ''; preview.value = undefined
  try {
    const result = await $fetch<ConsolePackagePreview>('/api/ps4/files/install', { method: 'POST', body: { ip, action: 'preview', path } })
    if (ip === props.psIp) { preview.value = result; await nextTick(); modal.value?.showModal() }
  } catch (cause) { if (ip === props.psIp) emit('notice', 'PKG не готов к установке', message(cause), true) }
  finally { preparing.value = false }
}
function close() { if (starting.value) return; modal.value?.close(); preview.value = undefined; error.value = '' }
async function install() {
  const p = preview.value, ip = props.psIp; if (!p?.canInstall || starting.value) return
  starting.value = true; error.value = ''
  try {
    const record = await $fetch<ConsolePackageInstallation>('/api/ps4/files/install', { method: 'POST', body: { ip, action: 'start', path: p.path, revision: p.revision } })
    if (ip === props.psIp) {
      submitted.add(record.id); jobs.value = [record, ...jobs.value.filter(j => j.id !== record.id)]
      modal.value?.close(); preview.value = undefined; await poll()
    }
  } catch (cause) { if (ip === props.psIp) error.value = message(cause) }
  finally { starting.value = false }
}
async function cancel(id: string) {
  const ip = props.psIp
  try { await $fetch('/api/ps4/files/install', { method: 'POST', body: { ip, action: 'cancel', id } }); if (ip === props.psIp) await poll() }
  catch (cause) { if (ip === props.psIp) emit('notice', 'Не удалось отменить установку', message(cause), true) }
}
defineExpose({ open })
onMounted(() => { void poll(); timer = setInterval(() => void poll(), 2000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
watch(() => props.psIp, () => { modal.value?.close(); preview.value = undefined; jobs.value = []; loaded = false; submitted.clear(); error.value = ''; void poll() })
</script>

<template>
  <div v-if="preparing" class="pkg-progress" role="status">{{ t("Проверяем PKG, прошивку и свободное место PS4…") }}</div>
  <div v-for="record in active" :key="record.id" class="pkg-progress" role="status">
    <div><strong>{{ record.title }}</strong><span>{{ t(state(record)) }}<template v-if="percent(record)"> · {{ t(percent(record)) }}%</template></span></div>
    <progress :value="percent(record)" max="100" />
    <span class="path">{{ record.path }}</span><span v-if="detail(record)" class="warning">{{ t(detail(record)) }}</span>
    <button type="button" :disabled="record.pending || record.job?.state === 'cancelling'" @click="cancel(record.id)">{{ t("Отменить установку") }}</button>
  </div>
  <section v-if="showHistory && history.length" class="pkg-history">
    <h2>{{ t("Установки из файлов") }}</h2>
    <div v-for="record in history" :key="record.id" class="history-row">
      <strong>{{ record.title }} · {{ t(state(record)) }}</strong>
      <span>{{ t(new Date(record.createdAt).toLocaleString(formatLocale)) }} · {{ record.path }}</span>
      <span v-if="detail(record)" class="warning">{{ t(detail(record)) }}</span>
    </div>
  </section>
  <dialog ref="modal" @cancel.prevent="close">
    <form v-if="preview" @submit.prevent="install">
      <h2>{{ t("Установить PKG на PS4?") }}</h2><p>PS4 {{ psIp }}</p>
      <strong>{{ preview.title }}</strong>
      <dl><dt>{{ t("Пакет") }}</dt><dd>{{ t(preview.type) }} · {{ t(preview.appVersion || 'Без версии') }} · {{ t(bytes(preview.size)) }}</dd><dt>{{ t("Игра") }}</dt><dd>{{ preview.titleId }}</dd><dt>{{ t("Файл на PS4") }}</dt><dd>{{ preview.path }}</dd></dl>
      <p :class="{ warning: !preview.compatible }">{{ t(preview.firmwareMessage) }}</p><p :class="{ warning: !preview.canInstall }">{{ t(preview.spaceMessage) }}</p>
      <p>{{ t("Установка идёт с диска консоли. Исходный PKG останется в папке; PS4 потребуется место для установленного пакета.") }}</p>
      <p v-if="error" class="warning" role="alert">{{ t(error) }}</p>
      <div class="buttons"><button type="button" :disabled="starting" @click="close">{{ t("Отмена") }}</button><button type="submit" :disabled="starting || !preview.canInstall">{{ t(starting ? 'Запускаем…' : 'Установить на PS4') }}</button></div>
    </form>
  </dialog>
</template>

<style scoped>
.pkg-progress,.pkg-history{border:1px solid #35313e;background:#1d1a24;border-radius:12px;padding:18px;margin:18px 0;font-size:13px}.pkg-progress{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.pkg-progress>div{display:flex;justify-content:space-between;gap:16px;width:100%;flex-wrap:wrap}.pkg-progress progress{width:100%;accent-color:#a692f2}.path{overflow-wrap:anywhere;width:100%;color:#aaa5b7}.warning{color:#efba87!important}.pkg-history h2{font-size:18px;margin:0 0 12px}.history-row{display:flex;flex-direction:column;gap:7px;padding:12px 0;border-top:1px solid #35313e;overflow-wrap:anywhere}.history-row span{color:#aaa5b7;font-size:12px}
button{padding:8px 12px;border:1px solid #484154;border-radius:6px;background:#2a2631;color:#e7e0fa;font-size:12px;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}dialog{width:min(600px,calc(100vw - 48px));max-height:85vh;overflow:auto;padding:24px;border:1px solid #635176;border-radius:14px;background:#211d2b;color:#eee8f8}dialog::backdrop{background:#0009}dialog h2{font-size:20px;margin:0 0 12px}dialog p{font-size:13px;line-height:1.6;color:#b6aec3}dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:10px;font-size:13px;margin:18px 0}dt{color:#aaa5b7}dd{margin:0;overflow-wrap:anywhere}.buttons{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.buttons button[type=submit]{background:#69539d}
</style>

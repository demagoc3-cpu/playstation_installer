<script setup lang="ts">
import type { Ps4SystemSnapshot } from '../../shared/types/ps4-system'

const props = defineProps<{ psIp: string }>()
const snapshot = ref<Ps4SystemSnapshot>()
const checking = ref(false)
const updatedAt = ref('')
let timer: ReturnType<typeof setInterval> | undefined
let debounce: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
let generation = 0

async function refresh() {
  controller?.abort()
  controller = new AbortController()
  const current = ++generation
  checking.value = true
  try {
    const result = await $fetch<Ps4SystemSnapshot>('/api/ps4/system-info', { query: { ip: props.psIp }, signal: controller.signal })
    if (current !== generation) return
    snapshot.value = result
    updatedAt.value = result.ready ? new Date().toLocaleTimeString('ru-RU') : ''
  } catch {
    if (current !== generation) return
    snapshot.value = { ready: false, ip: props.psIp, updateRequired: false, issues: [], system: null, storage: null, runtime: null,
      reason: 'Не удалось получить данные. Проверьте IP консоли и запуск PackegeFlowService.' }
    updatedAt.value = ''
  } finally { if (current === generation) checking.value = false }
}
function bytes(value: number | null) {
  if (value === null) return 'Неизвестно'
  return `${(value / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГиБ`
}
function uptime(value: number) {
  const days = Math.floor(value / 86400), hours = Math.floor(value % 86400 / 3600), minutes = Math.floor(value % 3600 / 60)
  return [days ? `${days} д` : '', hours ? `${hours} ч` : '', minutes ? `${minutes} мин` : '', !days && !hours && !minutes ? `${value} с` : ''].filter(Boolean).join(' ')
}
function usedPercent(volume: NonNullable<Ps4SystemSnapshot['storage']>[number]) {
  return volume.totalBytes && volume.usedBytes !== null ? Math.round(volume.usedBytes / volume.totalBytes * 100) : 0
}
function diskError(volume: NonNullable<Ps4SystemSnapshot['storage']>[number]) {
  if (volume.error === -2147352574) return 'Раздел /user не виден сервису. Процесс может оставаться в файловой изоляции приложения.'
  if (volume.error === -2147352575 || volume.error === -2147352563 || volume.errno === 1 || volume.errno === 13) return 'Система отказала сервису в доступе к этому разделу.'
  return 'Не удалось прочитать объём диска. Код ниже поможет определить причину.'
}
function errorCode(volume: NonNullable<Ps4SystemSnapshot['storage']>[number]) {
  return volume.errorHex || (volume.error === null ? 'Неизвестно' : `0x${(volume.error >>> 0).toString(16).toUpperCase().padStart(8, '0')}`)
}
onMounted(() => { void refresh(); timer = setInterval(() => { if (!checking.value && !debounce) void refresh() }, 15000) })
watch(() => props.psIp, () => {
  ++generation; controller?.abort(); snapshot.value = undefined; updatedAt.value = ''; checking.value = false
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => { debounce = undefined; void refresh() }, 500)
})
onBeforeUnmount(() => { ++generation; controller?.abort(); if (timer) clearInterval(timer); if (debounce) clearTimeout(debounce) })
</script>

<template>
  <div class="system-heading">
    <div><p class="eyebrow">PLAYSTATION 4</p><h1>О системе</h1><p class="description">Сведения о консоли и свободное место на диске.</p></div>
    <button class="secondary" :disabled="checking" @click="refresh">{{ checking ? 'Обновляем…' : 'Обновить' }}</button>
  </div>
  <section class="system-connection" aria-live="polite">
    <div class="connection-title"><span class="indicator" :class="{ online: snapshot?.ready }" /><strong>{{ snapshot?.ready ? 'PackegeFlowService подключён' : checking ? 'Проверяем соединение…' : 'Нет соединения с сервисом' }}</strong></div>
    <span class="connection-address">{{ psIp }}:12801</span>
    <p v-if="!snapshot?.ready">{{ snapshot?.reason || 'Запустите PackegeFlowService на PS4. Адрес консоли можно изменить в верхней панели.' }}</p>
    <p v-else>Сервис {{ snapshot.version || 'Неизвестно' }}<template v-if="snapshot.pkgVersion"> · PKG {{ snapshot.pkgVersion }}</template><template v-if="updatedAt"> · Обновлено {{ updatedAt }}</template></p>
  </section>
  <template v-if="snapshot?.ready">
    <p v-if="snapshot.environment === 'host'" class="system-notice">Тестовый запуск на компьютере. Показатели диска относятся к этому компьютеру.</p>
    <div v-if="snapshot.issues.length" class="system-notice" role="status"><p v-for="issue in snapshot.issues" :key="issue">{{ issue }}</p></div>
    <template v-if="snapshot.system">
      <div class="system-grid">
        <article class="system-card"><span class="card-label">Модель консоли</span><strong>{{ snapshot.system.model || snapshot.system.modelFamily || 'Неизвестно' }}</strong><p v-if="!snapshot.system.model">Точный номер модели CUH пока недоступен.</p></article>
        <article class="system-card"><span class="card-label">Прошивка</span><strong>{{ snapshot.system.firmware || 'Неизвестно' }}</strong><p>Системное программное обеспечение</p></article>
        <article class="system-card"><span class="card-label">HEN</span><strong>{{ snapshot.system.henName || 'Неизвестно' }}</strong><p>{{ snapshot.system.henVersion ? `Версия ${snapshot.system.henVersion}` : 'Версия релиза HEN пока недоступна.' }}</p><p v-if="snapshot.system.henSdk">SDK {{ snapshot.system.henSdk }} · отдельная версия API</p></article>
      </div>
    </template>
    <div v-if="snapshot.environment === 'ps4' && snapshot.system?.filesystemAccess && !snapshot.system.filesystemAccess.enabled" class="system-notice">
      <p>Сервис не получил доступ к системным разделам. Этот результат не определяет, запущен ли HEN.</p>
      <p>Код: {{ snapshot.system.filesystemAccess.errorHex || (snapshot.system.filesystemAccess.error ?? 'Неизвестно') }}<template v-if="snapshot.system.filesystemAccess.stage"> · Этап: {{ snapshot.system.filesystemAccess.stage }}</template>.</p>
      <p v-if="snapshot.system.filesystemAccess.sdkProbed === false">SDK HEN пока не проверен. Автоматическая проверка отключена в этой сборке для диагностики запуска.</p>
      <p v-if="snapshot.system.filesystemAccess.sdkResult !== null">Ответ SDK: {{ snapshot.system.filesystemAccess.sdkResult }}<template v-if="snapshot.system.filesystemAccess.sdkResultHex"> ({{ snapshot.system.filesystemAccess.sdkResultHex }})</template><template v-if="snapshot.system.filesystemAccess.sdkErrno"> · errno {{ snapshot.system.filesystemAccess.sdkErrno }}</template>.</p>
      <p v-if="snapshot.system.filesystemAccess.sdkRawRaxHex">Исходный ответ SDK: RAX {{ snapshot.system.filesystemAccess.sdkRawRaxHex }} · Флаг ошибки: {{ snapshot.system.filesystemAccess.sdkCarry === null ? 'Неизвестно' : snapshot.system.filesystemAccess.sdkCarry ? 'Да' : 'Нет' }}.</p>
    </div>
    <section v-if="snapshot.storage" class="system-storage">
      <h2>Хранилище</h2>
      <article v-for="volume in snapshot.storage" :key="volume.id" class="storage-volume">
        <div class="storage-title"><strong>{{ volume.id === 'internal' ? 'Внутренний диск · приложения' : volume.id === 'host' ? 'Диск компьютера' : 'Дополнительный диск' }}</strong><span>{{ volume.path }}</span></div>
        <template v-if="volume.available">
          <div class="storage-values"><div><span>Доступно для записи</span><strong>{{ bytes(volume.availableBytes) }}</strong></div><div><span>Всего</span><strong>{{ bytes(volume.totalBytes) }}</strong></div><div><span>Занято</span><strong>{{ bytes(volume.usedBytes) }}</strong></div></div>
          <div class="storage-bar" role="progressbar" :aria-valuenow="usedPercent(volume)" :aria-valuemin="0" :aria-valuemax="100" aria-label="Занято на диске"><i :style="{ width: `${usedPercent(volume)}%` }" /></div>
          <p>{{ usedPercent(volume) }}% занято · Свободно {{ bytes(volume.freeBytes) }}. Доступное для записи место может быть меньше из-за резерва системы.</p>
        </template>
        <template v-else><p>{{ diskError(volume) }}</p><p class="storage-error">Ошибка {{ errorCode(volume) }}<template v-if="volume.stage"> · Этап {{ volume.stage }}</template><template v-if="volume.errno"> · errno {{ volume.errno }}</template></p></template>
      </article>
    </section>
    <section v-if="snapshot.runtime" class="system-runtime"><h2>Состояние сервиса</h2><dl><div><dt>Время работы</dt><dd>{{ uptime(snapshot.runtime.uptimeSeconds) }}</dd></div><div><dt>Запросы</dt><dd>{{ snapshot.runtime.requests }}</dd></div><div><dt>Ответы</dt><dd>{{ snapshot.runtime.replies }}</dd></div></dl><p>Счётчики обновляются каждые 15 секунд, пока открыт раздел.</p></section>
  </template>
</template>

<style scoped>
.system-heading { display: flex; align-items: center; justify-content: space-between; gap: 24px; max-width: 1000px; }.description { color: #a9a6b2; font-size: 13px; }.system-heading button { flex: none; }
.system-connection, .system-card, .system-storage, .system-runtime { border: 1px solid #2d2c33; border-radius: 10px; background: #1b1a1f; }
.system-connection { position: relative; max-width: 1000px; padding: 22px 24px; margin: 24px 0; }.connection-title { font-size: 13px; }.indicator { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #dc7d72; margin-right: 8px; }.indicator.online { background: #7ec78a; }.connection-address { display: block; margin-top: 8px; font: 12px 'DM Mono', monospace; color: #aaa4c0; }
.system-connection p, .system-card p, .storage-volume p, .system-runtime p { margin: 9px 0 0; color: #96939f; font-size: 12px; line-height: 1.7; }
.system-grid { max-width: 1000px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }.system-card { padding: 24px; min-width: 0; }.card-label { display: block; color: #9a95a7; font-size: 11px; margin-bottom: 16px; }.system-card strong { font-size: 23px; letter-spacing: -.6px; overflow-wrap: anywhere; }
.system-storage, .system-runtime { max-width: 1000px; padding: 24px; margin-top: 20px; }h2 { font-size: 16px; margin: 0 0 22px; }.storage-title { display: flex; justify-content: space-between; gap: 20px; font-size: 13px; }.storage-title span { color: #88838f; font: 11px 'DM Mono', monospace; }
.storage-values { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 16px; margin: 24px 0 18px; }.storage-values span { display: block; color: #9a95a7; font-size: 11px; margin-bottom: 8px; }.storage-values strong { font-size: 20px; }.storage-values > div:first-child strong { color: #a89ae7; }.storage-bar { height: 7px; border-radius: 5px; overflow: hidden; background: #323039; }.storage-bar i { display: block; height: 100%; background: #9681df; border-radius: inherit; transition: width .2s; }
.system-runtime dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin: 0; }.system-runtime dt { color: #9a95a7; font-size: 11px; margin-bottom: 8px; }.system-runtime dd { margin: 0; font-size: 17px; }.system-notice { max-width: 1000px; padding: 14px 20px; border: 1px solid #61523c; border-radius: 8px; color: #d4bc8e; font-size: 12px; line-height: 1.7; margin: 0 0 20px; }.system-notice p { margin: 0; }
</style>

<script setup lang="ts">
const props = defineProps<{ psIp: string }>()
interface ServiceStatus { ready: boolean; ip: string; version?: string; reason?: string }
const status = ref<ServiceStatus>()
const checking = ref(false)

async function checkService() {
  checking.value = true
  try { status.value = await $fetch<ServiceStatus>('/api/ps4/service-status', { query: { ip: props.psIp } }) }
  catch { status.value = { ready: false, ip: props.psIp, reason: 'Не удалось проверить сервис' } }
  finally { checking.value = false }
}

onMounted(() => void checkService())
watch(() => props.psIp, () => { status.value = undefined; void checkService() })
</script>

<template>
  <p class="eyebrow">ФАЙЛЫ КОНСОЛИ</p>
  <h1>FTP и управление файлами</h1>
  <p class="ftp-description">Проводник будет работать через файловый API PackageFlowService на PS4. Доступ ко всей файловой системе, загрузка и скачивание файлов, папки, переименование и удаление входят в план.</p>
  <div class="ftp-status">
    <div><span class="ftp-indicator" :class="{ online: status?.ready }" /><strong>{{ status?.ready ? 'PackageFlowService доступен' : 'Ожидаем PackageFlowService' }}</strong><small>{{ status?.ready ? `PS4 ${status.ip} · версия ${status.version}` : status?.reason || 'Проверяем соединение…' }}</small></div>
    <button type="button" :disabled="checking" @click="checkService">{{ checking ? 'Проверяем…' : 'Проверить /ping' }}</button>
  </div>
  <div class="ftp-next"><h2>Следующий этап</h2><p>После проверки сервиса на приставке подключим список каталогов и потоковую передачу файлов. Загрузка PKG на диск консоли сама по себе не запускает установку: для этого сервису понадобится отдельная команда установки.</p><p>Веб-раздел использует API нашего демона. Подключение FileZilla по стандартному FTP-протоколу в этот вариант не входит.</p></div>
</template>

<style scoped>
.eyebrow { margin: 0 0 9px; color: #978ae1; font-weight: 800; letter-spacing: 1.4px; font-size: 10px; }
h1 { margin: 0 0 10px; font-size: 30px; letter-spacing: -1.2px; }
.ftp-description { max-width: 760px; margin: 0; color: #a9a6b2; font-size: 13px; line-height: 1.7; }
.ftp-status, .ftp-next { max-width: 800px; margin-top: 25px; padding: 22px 24px; border: 1px solid #2d2c33; border-radius: 10px; background: #1b1a1f; }
.ftp-status { display: flex; justify-content: space-between; align-items: center; gap: 20px; }
.ftp-status strong, .ftp-status small { display: block; }.ftp-status strong { font-size: 13px; }.ftp-status small { margin: 6px 0 0 14px; color: #85838b; font-size: 11px; }
.ftp-indicator { display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: #dc7d72; }.ftp-indicator.online { background: #7ec78a; }
.ftp-status button { flex: none; padding: 9px 12px; border: 1px solid #3b3941; border-radius: 6px; background: #28272d; color: #d8d5e4; font-size: 11px; font-weight: 800; }.ftp-status button:disabled { opacity: .5; }
.ftp-next h2 { margin: 0 0 11px; font-size: 16px; }.ftp-next p { color: #a9a6b2; font-size: 12px; line-height: 1.7; }
</style>

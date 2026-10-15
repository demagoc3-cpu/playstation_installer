<script setup lang="ts">
const props = defineProps<{ consoleId: string }>()
const { t } = useAppLocale()
const info = ref<any>(), message = ref(''), busy = ref(false)
let generation = 0, polling: number | undefined, timer: ReturnType<typeof setInterval> | undefined
const active = computed(() => info.value?.flow && ['active', 'unconfirmed'].includes(info.value.flow.state))
async function refresh() {
  if (polling === generation) return
  const request = generation; polling = request
  try { const value = await $fetch('/api/consoles/app-update', { query: { consoleId: props.consoleId } }); if (request === generation) { info.value = value; message.value = '' } }
  catch (error: any) { if (request === generation) message.value = error?.data?.message || 'Не удалось проверить приложение PS5' }
  finally { if (polling === request) polling = undefined }
}
async function update() {
  if (!info.value?.canUpdate || !window.confirm(t('Установить приложение PackageFlow из комплекта? Открытый PackageFlow на PS5 закроется для обновления. Настройки подключения сохранятся.'))) return
  const request = generation; busy.value = true; message.value = ''
  try { const value = await $fetch('/api/consoles/app-update', { method: 'POST', body: { consoleId: props.consoleId }, timeout: 90000 }); if (request === generation) info.value = value }
  catch (error: any) { if (request === generation) { const failure = error?.data?.message || 'Не удалось получить результат обновления'; await refresh(); message.value = failure } }
  finally { if (request === generation) busy.value = false }
}
watch(() => props.consoleId, () => { generation++; info.value = undefined; message.value = ''; busy.value = false; void refresh() }, { immediate: true })
onMounted(() => { timer = setInterval(() => { if (active.value && !busy.value) void refresh() }, 2500) })
onBeforeUnmount(() => { generation++; clearInterval(timer) })
</script>

<template>
  <section class="app-updates" :aria-label="t('Обновление приложения PS5')">
    <header><div><span class="eyebrow">PS5 · PackageFlow</span><h2>{{ t('Приложение на консоли') }}</h2></div><span v-if="info?.flow?.state==='completed'" class="verified">✓ {{ t('Обновлено') }}</span></header>
    <div class="versions">
      <div><span>{{ t('На PS5') }}</span><strong>{{ info?.current || '—' }}</strong><small>{{ info?.currentBuildId || t('Сборка пока не подтверждена') }}</small></div>
      <div><span>{{ t('В комплекте') }}</span><strong>{{ info?.release?.version || '—' }}</strong><small>{{ info?.release?.buildId || '—' }}</small></div>
    </div>
    <p aria-live="polite">{{ t(info?.message || 'Проверяем приложение…') }}</p>
    <progress v-if="active && info?.flow?.progress !== undefined" :value="info.flow.progress" max="100" :aria-label="t('Передача приложения')" />
    <div class="actions"><button class="primary" :disabled="busy || !info?.canUpdate" @click="update">{{ t(busy ? 'Подготавливаем обновление…' : info?.installed ? 'Обновить приложение' : 'Установить приложение') }}</button><button :disabled="busy" @click="refresh">{{ t('Проверить результат') }}</button></div>
    <p v-if="message" class="error" role="alert">{{ t(message) }}</p>
  </section>
</template>

<style scoped>
.app-updates{padding:20px;border:1px solid #5798df4d;border-radius:14px;background:linear-gradient(130deg,#123d6870,#061933ba);box-shadow:inset 0 1px 0 #d8efff12;backdrop-filter:blur(16px);color:#e4efff;display:grid;gap:16px;min-width:0}header,.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.eyebrow{color:#7ebfff;font-size:10px;letter-spacing:.12em}h2{font-size:17px;margin:5px 0 0}.versions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.versions>div{padding:12px 14px;border:1px solid #5798df33;border-radius:10px;background:#0a244765;display:grid;gap:7px}.versions span,small{font-size:11px;color:#a8c2e6;overflow-wrap:anywhere}.versions strong{font-size:15px;font-variant-numeric:tabular-nums}.verified{font-size:11px;color:#58e6bc;padding:6px 10px;border:1px solid #42d9b147;border-radius:20px;background:#086b5440}p{margin:0;font-size:12px;color:#b8cdeb;line-height:1.65;overflow-wrap:anywhere}.actions{justify-content:flex-start}button{min-height:40px;padding:10px 15px;border:1px solid #5d9bd955;border-radius:9px;background:#14375c8c;color:#e5efff;font-size:12px;cursor:pointer}button.primary{background:linear-gradient(110deg,#00aafa,#315cfb 62%,#7357f8);border-color:#64c7ff9e;box-shadow:0 0 14px #0785fd2d}button:disabled{opacity:.4;cursor:default}button:focus-visible{outline:2px solid #80dcff;outline-offset:3px}progress{width:100%;height:8px;accent-color:#6a7bff;border:0;border-radius:20px;overflow:hidden}.error{color:#ffc1cb}@media(max-width:480px){.app-updates{padding:15px}.versions{grid-template-columns:1fr}.actions>button{width:100%}}
</style>

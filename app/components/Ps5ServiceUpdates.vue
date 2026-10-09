<script setup lang="ts">
const props = defineProps<{ consoleId: string; name: string; ip: string }>()
const { t } = useAppLocale()
const app = ref<any>(), info = ref<any>(), message = ref(''), busy = ref(false)
let generation = 0, polling = false, timer: ReturnType<typeof setInterval> | undefined
const inProgress = computed(() => info.value?.flow && !['completed', 'failed', 'unconfirmed'].includes(info.value.flow.state))
async function refresh() {
  if (polling) return
  const request = generation; polling = true
  try { const value = await $fetch('/api/consoles/service-update', { query: { consoleId: props.consoleId } }); if (request === generation) {info.value = value; const launchInfo=await $fetch('/api/consoles/app-launch',{query:{consoleId:props.consoleId}});if(request===generation)app.value=launchInfo} }
  catch (error: any) { if (request === generation) message.value = error?.data?.message || 'Нет ответа от WEB' }
  finally { polling = false }
}
async function launch() {
 const request=generation;busy.value=true;message.value=''
 try {const value=await $fetch('/api/consoles/app-launch',{method:'POST',body:{consoleId:props.consoleId}});if(request===generation)app.value=value}
 catch(error:any){if(request===generation)message.value=error?.data?.message || 'Не удалось запустить приложение'}
 finally{if(request===generation)busy.value=false}
}
async function install() {
  if (!info.value?.release || !window.confirm(t('Обновить фоновую службу PS5? Интерфейс PackageFlow закроется, сопряжение сохранится.'))) return
  const request = generation; busy.value = true; message.value = ''
  try { const value = await $fetch('/api/consoles/service-update', { method: 'POST', body: { consoleId: props.consoleId } }); if (request === generation) info.value = value }
  catch (error: any) { if (request === generation) { message.value = error?.data?.message || 'Нет ответа от WEB'; await refresh() } }
  finally { if (request === generation) busy.value = false }
}
watch(() => props.consoleId, () => { generation++; app.value = undefined; info.value = undefined; message.value = ''; void refresh() }, { immediate: true })
onMounted(() => { timer = setInterval(() => { if (inProgress.value || ['intent','accepted'].includes(app.value?.flow?.state)) void refresh() }, 2000) })
onBeforeUnmount(() => { generation++; clearInterval(timer) })
</script>
<template>
<section class="updates">
<p>{{ name }} · PS5 {{ ip }}</p><h2>{{ t('Обновление PackageFlowService') }}</h2>
<p>{{ t('Сервис') }} {{ info?.current || '—' }}</p>
<p>{{ t(info?.message || 'Подождите…') }}</p>
<template v-if="info?.release"><p>{{ t('Доступная версия') }}: {{ info.release.version }}</p><button :disabled="busy || inProgress || info.flow?.state==='unconfirmed'" @click="install">{{ t('Обновить сервис') }}</button></template>
<p v-if="app?.release">{{ t('Приложение') }} {{ app.release.version }} · {{ t(app.message) }}</p>
<button :disabled="busy || inProgress || !app?.available || !app?.release || app?.running || ['intent','accepted','unconfirmed'].includes(app?.flow?.state)" @click="launch">{{ t('Запустить PackageFlow') }}</button>
<button :disabled="busy" @click="refresh">{{ t('Проверить результат') }}</button>
<p v-if="info?.flow" aria-live="polite">{{ t(info.flow.message) }}</p><p v-if="message" role="alert">{{ t(message) }}</p>
</section>
</template>
<style scoped>
.updates{padding:16px;border:1px solid #343039;border-radius:10px;background:#1b1a1f}h2{font-size:16px}p{font-size:12px;color:#aaa3b7;line-height:1.7}button{padding:10px 14px;margin:4px;background:#302a3b;color:#d8caed;border:1px solid #514360;border-radius:7px;cursor:pointer}button:disabled{opacity:.4;cursor:default}
</style>

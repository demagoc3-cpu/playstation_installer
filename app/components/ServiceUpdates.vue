<script setup lang="ts">
const props = defineProps<{ ip: string; current: string }>()
const emit = defineEmits<{ changed: [] }>()
const release = ref<any>(); const artifact = ref<any>(); const flow = ref<any>(); const message = ref(''); const busy = ref(false)
let timer: ReturnType<typeof setInterval> | undefined; let generation = 0; let completed = ''
function error(e: any) { return e?.data?.message || e?.message || 'Нет ответа от PS4' }
async function check() { const id = generation; const current = props.current; busy.value = true; try { const r = await $fetch('/api/ps4/service-update/check', { query: { current } }); if (id === generation && current === props.current) release.value = r } catch (e) { if (id === generation && current === props.current) message.value = error(e) } finally { if (id === generation) busy.value = false } }
async function poll() { const id = generation; try { const r = await $fetch<any>('/api/ps4/maintenance', { query: { ip: props.ip } }); if (id !== generation) return; flow.value = r?.kind === 'update' ? r : null; if (r?.kind === 'update' && r.state === 'completed' && completed !== r.id) { completed = r.id; artifact.value = undefined; emit('changed') } } catch (e) { if (id === generation && flow.value) message.value = error(e) } }
async function select(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return
  const id = generation; busy.value = true; message.value = ''; artifact.value = undefined
  try { const a = await $fetch('/api/ps4/service-update/package', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }); if (id === generation) artifact.value = a }
  catch (e) { if (id === generation) message.value = error(e) } finally { if (id === generation) busy.value = false; (event.target as HTMLInputElement).value = '' }
}
async function github() { const id = generation; busy.value = true; try { const a = await $fetch('/api/ps4/service-update/github', { method: 'POST', body: { current: props.current } }); if (id === generation) artifact.value = a } catch (e) { if (id === generation) message.value = error(e) } finally { if (id === generation) busy.value = false } }
async function install() {
  if (!artifact.value || !window.confirm(`Установить PackegeFlowService ${artifact.value.version}? WEB и PS4 должны оставаться включёнными. После установки будет доступен перезапуск через запускатель.`)) return
  const id = generation; busy.value = true
  try { const r = await $fetch('/api/ps4/service-update/install', { method: 'POST', body: { ip: props.ip, artifactId: artifact.value.id } }); if (id === generation) flow.value = r }
  catch (e) { if (id === generation) { message.value = error(e); await poll() } } finally { if (id === generation) busy.value = false }
}
async function restart() {
  if (!window.confirm('Закройте активную игру. Запускатель заменит фоновый сервис; подключение на несколько секунд прервётся. Продолжить?')) return
  const id = generation; busy.value = true
  try { const r = await $fetch('/api/ps4/service-update/restart', { method: 'POST', body: { ip: props.ip } }); if (id === generation) flow.value = r } catch (e) { if (id === generation) message.value = error(e) } finally { if (id === generation) busy.value = false }
}
watch(() => props.ip, () => { generation++; flow.value = undefined; artifact.value = undefined; message.value = ''; busy.value = false; void poll() })
watch(() => props.current, current => { if (current) void check() }, { immediate: true })
onMounted(() => { void poll(); timer = setInterval(() => { if (flow.value && !['completed', 'failed'].includes(flow.value.state)) void poll() }, 2500) })
onBeforeUnmount(() => { generation++; clearInterval(timer) })
</script>
<template>
  <section class="updates"><h2>Обновление PackegeFlowService</h2><p>Установлено: PKG {{ current || '—' }}. Сопряжение с WEB сохраняется после обновления.</p>
    <div class="actions"><button :disabled="busy" @click="check">Проверить GitHub</button><button v-if="release?.available" :disabled="busy" @click="github">Скачать PKG {{ release.version }}</button><label class="file-button">Выбрать PKG на компьютере<input type="file" accept=".pkg" :disabled="busy" @change="select"></label></div>
    <p v-if="release">{{ release.message }} · <a :href="release.releaseUrl" target="_blank" rel="noopener">Релизы проекта</a></p>
    <p v-if="current && Number(current) < 1.19">Первое обновление до 1.19 установите вручную на PS4. Следующие версии можно устанавливать отсюда.</p>
    <div v-if="artifact" class="artifact"><strong>Проверен PKG {{ artifact.version }}</strong><p>{{ (artifact.size / 1024 / 1024).toFixed(1) }} МБ · SHA-256: {{ artifact.sha256 }}</p><button :disabled="busy || (flow && !['completed', 'failed'].includes(flow.state))" @click="install">Установить обновление на PS4</button></div>
    <div v-if="flow" class="flow" aria-live="polite"><strong>{{ flow.state === 'completed' ? 'Сервис обновлён' : flow.state === 'failed' ? 'Обновление не выполнено' : 'Обновление сервиса' }}</strong><p>{{ flow.message }}</p><progress v-if="flow.job?.downloadTotalBytes" :value="flow.job.downloadedBytes" :max="flow.job.downloadTotalBytes"/><button v-if="flow.state === 'restart_ready'" :disabled="busy" @click="restart">Перезапустить сервис</button><button v-else-if="!['completed', 'failed'].includes(flow.state)" :disabled="busy" @click="poll">Проверить результат</button></div>
    <p v-if="message" role="alert">{{ message }}</p><p v-if="busy">Подождите…</p>
  </section>
</template>
<style scoped>
.updates { max-width: 1000px; padding: 24px; margin-top: 20px; background: #1b1a1f; border: 1px solid #343039; border-radius: 10px; } h2 { font-size: 16px; margin-top: 0; } p { color: #aaa3b7; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; } .actions { display: flex; flex-wrap: wrap; gap: 12px; } button, .file-button { padding: 10px 14px; background: #302a3b; color: #d8caed; border: 1px solid #514360; border-radius: 7px; cursor: pointer; font-size: 12px; } input { display: none; } .artifact, .flow { padding: 18px; margin-top: 16px; border-radius: 8px; background: #242028; font-size: 13px; } a { color: #b3a0df; } progress { display: block; width: 100%; margin: 12px 0; accent-color: #9781df; }
</style>

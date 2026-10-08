<script setup lang="ts">
import type { DeviceSelection, DeviceInstallPreview } from '#shared/types/consoles'
const props = defineProps<{ selection: DeviceSelection }>()
const emit = defineEmits<{ close: []; queued: [] }>()
const { t } = useAppLocale()
const preview = ref<DeviceInstallPreview>(), selected = ref<string[]>([]), query = ref(''), filter = ref('all')
const busy = ref(false), message = ref(''), attempted = ref(false)
const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('')
const results = ref<Array<{consoleId:string;name:string;state:string;message:string}>>([])
const shown = computed(() => (preview.value?.devices || []).filter(item => (filter.value === 'all' || item.profile.platform === filter.value) && `${item.profile.name} ${item.profile.ip} ${item.profile.model || ''}`.toLowerCase().includes(query.value.toLowerCase())))
const bytes = (value?: number) => {if(value===undefined)return t('Не определено');const unit=value>=1024**3?3:value>=1024**2?2:1;return `${(value/1024**unit).toLocaleString('ru-RU',{maximumFractionDigits:1})} ${t(unit===3?'ГБ':unit===2?'МБ':'КБ')}`}
async function load() {
  busy.value=true; message.value=''
  try {
    preview.value = await $fetch<DeviceInstallPreview>('/api/consoles/install-preview',{method:'POST',body:props.selection})
    let remembered:string[]=[]; try { remembered=JSON.parse(localStorage.getItem('packageflow-install-devices') || '[]') } catch {}
    selected.value=preview.value.devices.filter(item=>item.eligible && remembered.includes(item.profile.id)).map(item=>item.profile.id)
  } catch(error:any) { message.value=error?.data?.message || 'Не удалось проверить набор файлов' }
  finally { busy.value=false }
}
async function receive(value:any) { results.value=value.results; if(value.state==='completed') { message.value='Проверьте результаты по каждому устройству'; emit('queued') } else message.value='WEB ещё запускает очереди. Проверьте результат через несколько секунд' }
async function check() { busy.value=true; try { await receive(await $fetch('/api/consoles/install-batch',{query:{requestId}})) } catch(error:any) { message.value=error?.data?.message || 'Не удалось получить результат. Команда повторно не отправлена' } finally { busy.value=false } }
async function install() {
  if (!preview.value || !selected.value.length || busy.value || attempted.value) return
  attempted.value=true; busy.value=true; message.value=''
  try { localStorage.setItem('packageflow-install-devices',JSON.stringify(selected.value)) } catch {}
  try { await receive(await $fetch('/api/consoles/install-batch',{method:'POST',body:{requestId,selection:preview.value.selection,consoleIds:selected.value}})) }
  catch { message.value='Ответ WEB не получен. Нажмите «Проверить результат»; повторная установка не отправлена' }
  finally { busy.value=false }
}
onMounted(load)
</script>
<template>
<div class="device-overlay" @click.self="!busy && emit('close')"><section class="device-dialog" role="dialog" aria-modal="true" :aria-label="t('Выберите устройства для установки')">
<header><div><h2>{{ t('Установить на устройства') }}</h2><p v-if="preview">{{ preview.files }} {{ t('файлов') }} · {{ bytes(preview.size) }} · {{ t('Весь набор проверяется для каждой приставки') }}</p></div><button :disabled="busy" :aria-label="t('Закрыть')" @click="emit('close')">×</button></header>
<div class="device-toolbar"><input v-model="query" :placeholder="t('Имя или IP устройства')"><select v-model="filter"><option value="all">{{ t('Все') }}</option><option value="ps4">PS4</option><option value="ps5">PS5</option></select><button v-if="!attempted" :disabled="busy" @click="load">{{ t(busy?'Проверяем…':'Обновить') }}</button></div>
<div class="device-table"><table><thead><tr><th><input type="checkbox" :disabled="busy || attempted" :aria-label="t('Выбрать доступные устройства')" :checked="!!shown.filter(item=>item.eligible).length && shown.filter(item=>item.eligible).every(item=>selected.includes(item.profile.id))" @change="selected=($event.target as HTMLInputElement).checked ? [...new Set([...selected,...shown.filter(item=>item.eligible).map(item=>item.profile.id)])] : selected.filter(id=>!shown.some(item=>item.profile.id===id))"></th><th>{{ t('Устройство') }}</th><th>{{ t('Тип / модель') }}</th><th>{{ t('Свободно') }}</th><th>{{ t('Установка') }}</th></tr></thead><tbody><tr v-for="item in shown" :key="item.profile.id" :class="{unavailable:!item.eligible}"><td><input v-model="selected" :value="item.profile.id" type="checkbox" :disabled="busy || attempted || !item.eligible" :aria-label="t(`Установить на ${item.profile.name}`)"></td><td><strong>{{ item.profile.name }}</strong><small>{{ item.profile.ip }}</small></td><td>{{ item.profile.platform.toUpperCase() }}<small>{{ item.profile.model || '—' }}</small></td><td>{{ bytes(item.profile.freeBytes) }}<small>{{ t('Для набора и очереди:') }} {{ bytes(item.requiredBytes) }}</small></td><td><span :class="{ready:item.eligible}">{{ t(item.reason || 'Готово') }}</span><small v-if="item.pending">{{ t('В очереди:') }} {{ item.pending }}</small></td></tr></tbody></table><p v-if="preview && !preview.devices.length">{{ t('Добавьте и сопрягите приставки в разделе «Устройства».') }}</p></div>
<p v-if="message" class="pf-notice" role="status">{{ t(message) }}</p><ul v-if="results.length" class="device-results"><li v-for="result in results" :key="result.consoleId" :class="result.state"><strong>{{ result.name }}</strong> · {{ t(result.message) }}</li></ul>
<footer><span>{{ t('Выбрано устройств:') }} {{ selected.length }}</span><button :disabled="busy" @click="emit('close')">{{ t(attempted?'Закрыть':'Отмена') }}</button><button v-if="attempted" :disabled="busy" @click="check">{{ t('Проверить результат') }}</button><button v-else class="primary" :disabled="busy || !selected.length" @click="install">{{ t('Установить') }}</button></footer>
</section></div>
</template>
<style scoped>
.device-overlay{position:fixed;inset:0;z-index:250;background:#000b;display:grid;place-items:center;padding:24px}.device-dialog{width:min(1000px,100%);max-height:90vh;background:#19191c;border:1px solid #454052;border-radius:14px;padding:22px;display:flex;flex-direction:column;gap:16px;color:#ece9f2}header,footer,.device-toolbar{display:flex;align-items:center;gap:12px}header{justify-content:space-between}h2{margin:0;font-size:22px}p{font-size:12px;color:#aaa6b4;margin:6px 0}.device-toolbar input{width:320px;max-width:60%}.device-table{overflow:auto;min-height:0}table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}th,td{padding:12px 10px;border-bottom:1px solid #333139}th{color:#aaa5b5;font-size:11px}small{display:block;color:#95909f;font-size:10px;margin-top:5px}.unavailable{color:#aaa5b5}.ready,.queued{color:#93cea7}.failed,.uncertain{color:#e8a291}.device-results{max-height:170px;overflow:auto;font-size:12px;padding-left:20px}footer{flex-shrink:0}footer span{flex:1;font-size:12px}button,input:not([type=checkbox]),select{padding:9px 12px;border:1px solid #454052;border-radius:8px;background:#27262d;color:#eee;font-size:12px}input{accent-color:#a786df}button{cursor:pointer}button.primary{background:#7754ad;border-color:#a786df}button:disabled{opacity:.4;cursor:default}
</style>

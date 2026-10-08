<script setup lang="ts">
import type { ConsoleProfiles, DeviceActivity } from '#shared/types/consoles'
const props = defineProps<{ profiles: ConsoleProfiles; activity?: DeviceActivity[], DeviceActivity }>()
const emit = defineEmits<{ updated: [value: ConsoleProfiles] }>()
const { t } = useAppLocale()
const showCreate = ref(false), pending = ref(false), message = ref(''), code = ref('')
const draft = reactive({ id: undefined as string|undefined, name: '', ip: '', platform: 'ps4' as 'ps4' | 'ps5', model:'',transport:'service' as 'service'|'payload' })
const query=ref(''),filter=ref('all'),onlyOnline=ref(false),detailId=ref('')
const shown=computed(()=>props.profiles.consoles.filter(item=>(filter.value==='all'||item.platform===filter.value)&&(!onlyOnline.value||item.online)&&`${item.name} ${item.ip} ${item.model || ''}`.toLowerCase().includes(query.value.toLowerCase())))
const activityFor=(id:string)=>props.activity?.find(item=>item.consoleId===id)
const bytes=(value?:number)=>value===undefined?'—':`${(value/1024**3).toLocaleString('ru-RU',{maximumFractionDigits:1})} ГБ`
function edit(profile?:ConsoleProfiles['consoles'][number]) { Object.assign(draft,{id:profile?.id,name:profile?.name||'',ip:profile?.ip||'',platform:profile?.platform||'ps4',model:profile?.model||'',transport:profile?.transport||'service'});showCreate.value=true }
const showConfig = ref(false), configHost = ref(''), configPort = ref('3000')
const active = computed(() => props.profiles.consoles.find(item => item.id === (detailId.value || props.profiles.activeId)))
async function request(path: string, body: unknown) {
  pending.value = true; message.value = ''
  try { emit('updated', await $fetch<ConsoleProfiles>(`/api/consoles/${path}`, { method: 'POST', body })); code.value = '' }
  catch (error: any) { message.value = error?.data?.message || 'Не удалось сохранить подключение' }
  finally { pending.value = false }
}
async function downloadConfig() {
  if (!active.value) return
  message.value = ''
  try {
    const contents = await $fetch<string>('/api/consoles/ui-config', { query: { consoleId: active.value.id, host: configHost.value, port: configPort.value }, responseType: 'text' })
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }))
    const link = document.createElement('a'); link.href = url; link.download = 'packageflow-ui.conf'; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000); showConfig.value = false
  } catch (error: any) { message.value = error?.data?.message || 'Не удалось скачать конфигурацию' }
}
function openConfig() {
  configHost.value = location.hostname; configPort.value = location.port || '3000'; showConfig.value = true
}
async function create() {
  await request('', draft); if(!message.value) await request('refresh',{})
  if (!message.value) { showCreate.value = false; draft.name = ''; draft.ip = '' }
}
</script>

<template>
<section class="devices-workspace">
<header class="profile-heading"><div><h1>{{ t('Устройства') }}</h1><p>{{ profiles.consoles.length }} {{ t('устройств') }} · {{ t('Отдельное сопряжение и очередь для каждой приставки') }}</p></div><div class="profile-actions"><button :disabled="pending" @click="request('refresh',{})">{{ t(pending?'Проверяем…':'Обновить подключения') }}</button><button class="primary" :disabled="pending" @click="edit()">＋ {{ t('Добавить устройство') }}</button></div></header>
<div class="profile-toolbar"><input v-model="query" :placeholder="t('Найти по имени, модели или IP')"><select v-model="filter"><option value="all">{{ t('Все') }}</option><option value="ps4">PS4</option><option value="ps5">PS5</option></select><label><input v-model="onlyOnline" type="checkbox"> {{ t('В сети') }}</label></div>
<div class="profiles-scroll"><table><thead><tr><th>{{ t('Устройство') }}</th><th>{{ t('Тип / модель') }}</th><th>{{ t('Соединение') }}</th><th>{{ t('Свободно') }}</th><th>{{ t('Задания') }}</th><th></th></tr></thead><tbody><tr v-for="profile in shown" :key="profile.id" :class="{selected:detailId===profile.id}"><td><strong>{{ profile.name }}</strong><small>{{ profile.ip }}</small></td><td>{{ profile.platform.toUpperCase() }} · {{ profile.model || '—' }}<small>{{ profile.firmware || '—' }} · {{ t('Сервис') }} {{ profile.version || '—' }}</small></td><td><span :class="{online:profile.online}">● {{ t(profile.online?'В сети':'Нет связи') }}</span><small>{{ t(profile.paired?'Сопряжено':profile.transport==='payload'?'PyLoader':'Нужно сопряжение') }}</small></td><td>{{ bytes(profile.freeBytes) }}</td><td>{{ t('Активные:') }} {{ activityFor(profile.id)?.counts.active || 0 }}<small>{{ t('В очереди:') }} {{ activityFor(profile.id)?.counts.queued || 0 }}</small></td><td><div class="profile-actions"><button @click="detailId=profile.id;code=''">{{ t('Подключение') }}</button><button @click="edit(profile)">{{ t('Изменить') }}</button><button :disabled="pending || profiles.activeId===profile.id" @click="request('active',{id:profile.id})">{{ t(profiles.activeId===profile.id?'Открыто':'Открыть') }}</button></div></td></tr></tbody></table><p v-if="!shown.length">{{ t('Устройства не найдены. Добавьте приставку или измените фильтр.') }}</p></div>
<section v-if="active" class="profile-details"><div class="profile-heading"><h2>{{ active.name }} · {{ active.platform.toUpperCase() }}</h2><button :disabled="pending" @click="request('probe',{id:active.id})">{{ t('Проверить подключение') }}</button></div><p>{{ active.ip }} · {{ t(active.transport==='payload'?'PyLoader':'PackageFlowService') }}</p>
<form v-if="active.transport!=='payload'" class="profile-actions" @submit.prevent="request('pair',{id:active.id,code})"><label>{{ t('Код с экрана приставки') }}<input v-model="code" :maxlength="active.platform==='ps5'?6:7" autocomplete="off" :placeholder="active.platform==='ps5'?'000000':'F7Y-YUH'" required></label><button class="primary" :disabled="pending || !code">{{ t(active.paired?'Повторить сопряжение':'Сопряжение') }}</button></form>
<button v-if="active.platform==='ps5'" @click="openConfig">{{ t('Конфигурация приложения PS5') }}</button><p v-if="active.platform==='ps5'&&!active.capabilities.formats.length">{{ t('Просмотр библиотеки доступен. Установка ожидает подтверждённой поддержки формата в сервисе PS5.') }}</p>
</section><p v-if="message" class="pf-notice" role="alert">{{ t(message) }}</p>
<div v-if="showCreate" class="profile-modal" @click.self="showCreate=false"><form class="profile-dialog" @submit.prevent="create"><h2>{{ t(draft.id?'Изменить устройство':'Добавить устройство') }}</h2><label>{{ t('Название') }}<input v-model="draft.name" maxlength="64" required :placeholder="t('Приставка в гостиной')"></label><label>{{ t('Тип') }}<select v-model="draft.platform" :disabled="!!draft.id"><option value="ps4">PlayStation 4</option><option value="ps5">PlayStation 5</option></select></label><label>{{ t('Модель') }}<input v-model="draft.model" maxlength="64" placeholder="Fat / Slim / Pro"></label><label>{{ t('IP приставки') }}<input v-model="draft.ip" :disabled="!!draft.id" placeholder="192.168.1.10" required></label><label v-if="draft.platform==='ps4'">{{ t('Способ установки') }}<select v-model="draft.transport"><option value="service">PackageFlowService</option><option value="payload">PyLoader</option></select></label><div class="profile-actions"><button type="button" @click="showCreate=false">{{ t('Отмена') }}</button><button class="primary" :disabled="pending">{{ t('Сохранить') }}</button></div><p v-if="message" role="alert">{{ t(message) }}</p></form></div>
<div v-if="showConfig" class="profile-modal" @click.self="showConfig=false"><form class="profile-dialog" @submit.prevent="downloadConfig"><h2>{{ t('Подключение приложения PS5 к WEB') }}</h2><label>{{ t('Локальный IP компьютера с WEB') }}<input v-model="configHost" required placeholder="192.168.1.10"></label><label>{{ t('Порт WEB') }}<input v-model="configPort" required inputmode="numeric"></label><p>{{ t('Добавьте packageflow-ui.conf в assets приложения PS5 перед сборкой. Адрес также можно изменить в приложении.') }}</p><div class="profile-actions"><button type="button" @click="showConfig=false">{{ t('Отмена') }}</button><button class="primary">{{ t('Скачать') }}</button></div><p v-if="message" role="alert">{{ t(message) }}</p></form></div>
</section>
</template>
<style scoped>
.devices-workspace{height:100%;min-height:0;display:flex;flex-direction:column;gap:16px}.profile-heading,.profile-actions,.profile-toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.profile-heading{justify-content:space-between}h1{margin:0;font-size:24px}h2{margin:0;font-size:17px}p{font-size:12px;color:#a7a2b1;margin:6px 0}.profile-toolbar>input{width:320px;max-width:50%}.profile-toolbar label{font-size:12px}.profiles-scroll{flex:1;min-height:140px;overflow:auto}table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}th,td{padding:12px;border-bottom:1px solid #333139}th{color:#9691a0;font-size:11px}small{display:block;font-size:10px;color:#95909f;margin-top:6px}.selected{background:#25232b}.online{color:#87d0a2}.profile-details{padding:16px;border:1px solid #3b3941;background:#19191c;border-radius:10px;display:grid;gap:12px}.profile-details label{display:flex;align-items:center;gap:12px;font-size:12px}.profile-details input{width:130px}.profile-details>button{justify-self:start}button,input:not([type=checkbox]),select{border:1px solid #454052;border-radius:8px;background:#27262d;color:#e9e6ef;padding:9px 12px;font-size:12px}button{cursor:pointer}button:disabled{opacity:.4;cursor:default}button.primary{background:#7754ad;border-color:#a786df}input{accent-color:#a786df}.profile-modal{position:fixed;inset:0;background:#000b;z-index:250;display:grid;place-items:center;padding:20px}.profile-dialog{width:min(420px,100%);max-height:90vh;overflow:auto;background:#1d1d21;border:1px solid #454052;border-radius:14px;padding:24px;display:grid;gap:16px}.profile-dialog label{display:grid;gap:6px;font-size:12px}.profile-dialog input,.profile-dialog select{width:100%}.profile-dialog .profile-actions{justify-content:flex-end}
</style>

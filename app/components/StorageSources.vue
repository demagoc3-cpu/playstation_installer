<script setup lang="ts">
import type { StorageInput, StorageKind, StorageSource } from '../../shared/types/storage'
const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ changed: [] }>()
const { t, formatLocale } = useAppLocale()
const sources = ref<StorageSource[]>([]), error = ref(''), saving = ref(false), showForm = ref(false), filter = ref('')
const platform = ref(''), docker = ref(false)
const defaults = (): StorageInput => ({ id:undefined, kind:'local', name:'', path:'', username:'', domain:'', password:'', clearPassword:false, enabled:true, autoIndex:false, indexIntervalMinutes:60 })
const form = reactive<StorageInput>(defaults())
const modal = ref<HTMLDialogElement>()
const protocols: { value: StorageKind; label: string; example: string }[] = [
  { value:'local', label:'Локальная папка', example:'D:\\Games или /srv/games' },
  { value:'smb', label:'SMB', example:'\\\\NAS\\games или smb://NAS/games' },
  { value:'nfs', label:'NFS', example:'NAS:/volume1/games' },
  { value:'webdav', label:'WebDAV', example:'https://NAS:5006/games/' },
]
const filtered = computed(() => sources.value.filter(s => `${s.name} ${s.path} ${s.kind}`.toLowerCase().includes(filter.value.toLowerCase())))
const busy = (s: StorageSource) => ['connecting','indexing'].includes(s.state)
const states = { unknown:'Не проверено', connecting:'Подключаем…', online:'Доступно', offline:'Недоступно', indexing:'Индексируем…', disabled:'Отключено' }
const bytes = (n: number) => n >= 2**40 ? `${(n/2**40).toFixed(2)} ТБ` : n >= 2**30 ? `${(n/2**30).toFixed(1)} ГБ` : `${(n/2**20).toFixed(1)} МБ`
const date = (n?: number) => n ? new Date(n).toLocaleString(formatLocale.value) : t('Ещё не индексировалось')
const message = (e:any) => e?.data?.message || e?.message || 'Не удалось выполнить действие'
let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined, generation = 0
function stop() { generation++; clearTimeout(timer); controller?.abort(); controller=undefined }
async function load() {
  const current = generation
  controller = new AbortController()
  try {
    const value = await $fetch<{ sources:StorageSource[]; platform:string; docker:boolean }>('/api/storage', { signal:controller.signal })
    if(current!==generation)return
    const changed = JSON.stringify(sources.value.map(s=>[s.id,s.lastIndexedAt])) !== JSON.stringify(value.sources.map(s=>[s.id,s.lastIndexedAt]))
    sources.value=value.sources; platform.value=value.platform; docker.value=value.docker
    if(changed)emit('changed')
  } catch(e:any) { if(current===generation)error.value=message(e) }
  finally { if(current===generation && props.visible)timer=setTimeout(load, sources.value.some(busy)?2000:10000) }
}
async function refresh() { stop(); if(props.visible)await load() }
watch(() => props.visible, visible => { stop(); if(visible)void load(); else close() }, { immediate:true })
onBeforeUnmount(()=>{stop();modal.value?.close()})
function edit(source?: StorageSource) { Object.assign(form, defaults(), source ? { id:source.id, kind:source.kind, name:source.name, path:source.path, username:source.username, domain:source.domain, enabled:source.enabled, autoIndex:source.autoIndex, indexIntervalMinutes:source.indexIntervalMinutes } : {}); error.value=''; showForm.value=true; void nextTick(()=>modal.value?.showModal()) }
watch(()=>form.kind,()=>{if(!form.id){form.password='';form.username='';form.domain='';form.clearPassword=false}})
function close() { modal.value?.close(); showForm.value=false; form.password='' }
async function save() {
  saving.value=true; error.value=''
  try { await $fetch('/api/storage', { method:'POST', body:{...form} }); close(); await refresh() }
  catch(e:any) { error.value=message(e) }
  finally { saving.value=false }
}
async function action(source:StorageSource, action:string) {
  error.value=''
  try { await $fetch(`/api/storage/${source.id}/action`, { method:'POST', body:{action} }); await refresh() }
  catch(e:any) { error.value=message(e) }
}
async function remove(source:StorageSource) {
  if(!window.confirm(t('Убрать хранилище из библиотеки? Исходные файлы останутся на месте.')+`\n${source.name}`))return
  error.value=''
  try { await $fetch(`/api/storage/${source.id}`, { method:'DELETE' }); emit('changed'); await refresh() }
  catch(e:any) { error.value=message(e) }
}
async function chooseFolder() {
  error.value=''
  try {
    const result = await $fetch<{ directory?:string; manual?:boolean; cancelled?:boolean; docker?:boolean }>('/api/packages/select-directory', { method:'POST', body:{initial:form.path} })
    if(result.directory&&!result.cancelled)form.path=result.directory
    else if(result.manual)error.value=t(result.docker?'Укажите путь внутри контейнера. Папка должна быть подключена к Docker.':'Введите полный путь на компьютере, где запущен WEB.')
  } catch(e:any) { error.value=message(e) }
}
</script>

<template>
  <div class="storage-page">
    <header class="storage-heading"><div><h1>{{ t('Хранилище') }}</h1><p>{{ sources.length }} {{ t('подключений') }} · {{ t('Файлы остаются в источниках. Каталог общий для PS4 и PS5.') }}</p></div><button class="primary" @click="edit()">+ {{ t('Добавить хранилище') }}</button></header>
    <p v-if="error&&!showForm" class="storage-error" role="alert">{{ t(error) }}</p>
    <dialog ref="modal" class="storage-modal" aria-labelledby="storage-dialog-title" @cancel.prevent="!saving&&close()" @click.self="!saving&&close()">
    <form v-if="showForm" class="storage-form" @submit.prevent="save">
      <header class="wide storage-modal-heading"><h2 id="storage-dialog-title">{{ t(form.id ? 'Настройки хранилища' : 'Новое хранилище') }}</h2><button type="button" class="storage-close" :disabled="saving" :aria-label="t('Закрыть')" @click="close()">×</button></header>
      <p v-if="error" class="wide storage-error" role="alert">{{ t(error) }}</p>
      <label><span>{{ t('Протокол') }}</span><select v-model="form.kind" :disabled="!!form.id" autofocus><option v-for="p in protocols" :key="p.value" :value="p.value">{{ t(p.label) }}</option></select></label>
      <label><span>{{ t('Название') }}</span><input v-model="form.name" maxlength="100" :placeholder="t('Например: Основная библиотека')"></label>
      <label class="wide"><span>{{ t('Путь или адрес') }}</span><div class="storage-path"><input v-model="form.path" required maxlength="2048" :disabled="!!form.id" :placeholder="protocols.find(p=>p.value===form.kind)?.example"><button v-if="form.kind==='local'&&!form.id" type="button" class="secondary" @click="chooseFolder">{{ t('Выбрать папку') }}</button></div></label>
      <template v-if="form.kind==='smb'||form.kind==='webdav'">
        <label><span>{{ t('Логин') }}</span><input v-model="form.username" maxlength="256" autocomplete="username"></label>
        <label><span>{{ t('Пароль') }}</span><input v-model="form.password" type="password" maxlength="4096" autocomplete="new-password" :placeholder="t(form.id?'пусто — оставить сохранённый':'')"></label>
        <label v-if="form.kind==='smb'"><span>{{ t('Домен (необязательно)') }}</span><input v-model="form.domain" maxlength="128"></label>
        <label v-if="form.id" class="storage-check"><input v-model="form.clearPassword" type="checkbox">{{ t('Удалить сохранённый пароль') }}</label>
      </template>
      <p v-if="form.kind==='nfs'" class="wide storage-note">{{ t(platform==='win32'?'NFS требует NFS-Win и WinFsp. На сервере разрешите доступ компьютеру WEB.':'NFS требует nfs-common и право монтирования у WEB. На сервере разрешите доступ компьютеру WEB.') }}</p>
      <p v-if="form.kind==='webdav'" class="wide storage-note">{{ t(platform==='win32'?'WebDAV требует rclone и WinFsp на компьютере WEB.':'WebDAV требует rclone и FUSE на компьютере WEB.') }}</p>
      <p v-if="form.kind==='smb'&&platform!=='win32'" class="wide storage-note">{{ t('SMB: пользовательское подключение Linux (GVfs) или cifs-utils с правом монтирования.') }}</p>
      <p v-if="docker" class="wide storage-note">{{ t('В Docker локальные папки должны быть подключены к контейнеру. Сетевым подключениям нужны компоненты и права внутри контейнера.') }}</p>
      <label class="storage-check"><input v-model="form.enabled" type="checkbox">{{ t('Хранилище включено') }}</label>
      <label class="storage-check"><input v-model="form.autoIndex" type="checkbox">{{ t('Обновлять каталог автоматически') }}</label>
      <label v-if="form.autoIndex"><span>{{ t('Интервал, минут') }}</span><input v-model.number="form.indexIntervalMinutes" type="number" min="5" max="10080" required></label>
      <p class="wide storage-note">{{ t('После добавления начнётся индексация. Пароль хранится зашифрованным на компьютере WEB. Игры не копируются.') }}</p>
      <div class="wide storage-actions"><button class="primary" :disabled="saving">{{ t(saving?'Сохраняем…':'Сохранить') }}</button><button type="button" class="secondary" :disabled="saving" @click="close">{{ t('Отмена') }}</button></div>
    </form>
    </dialog>
    <div class="storage-toolbar"><input v-model="filter" type="search" :placeholder="t('Найти по названию, пути или протоколу')"><button class="secondary" @click="refresh">{{ t('Обновить') }}</button></div>
    <p v-if="!sources.length" class="storage-note">{{ t('Добавьте папку или сетевое хранилище, чтобы наполнить библиотеку.') }}</p>
    <div v-if="filtered.length" class="storage-table-wrap">
      <table class="storage-table">
        <thead><tr><th scope="col">{{ t('Хранилище') }}</th><th scope="col">{{ t('Протокол') }}</th><th scope="col">{{ t('Статус') }}</th><th scope="col">{{ t('Пакеты') }}</th><th scope="col">{{ t('Индексация') }}</th><th scope="col">{{ t('Действия') }}</th></tr></thead>
        <tbody><tr v-for="source in filtered" :key="source.id">
          <th scope="row" class="storage-identity"><strong>{{ source.name }}</strong><span class="storage-address">{{ source.path }}</span><span v-if="source.hasPassword" class="storage-subline">{{ t('Пароль сохранён') }}</span></th>
          <td>{{ t(protocols.find(p=>p.value===source.kind)?.label || source.kind) }}</td>
          <td class="storage-status-cell"><span class="storage-state" :class="source.state">● {{ t(states[source.state]) }}</span><span v-if="source.message" class="storage-subline">{{ t(source.message) }}</span><span v-if="source.state==='offline'" class="storage-subline">{{ t('Последний каталог сохранён. Установка будет доступна после восстановления подключения.') }}</span></td>
          <td class="storage-count"><strong>{{ source.packageCount }}</strong><span class="storage-subline">{{ t(bytes(source.indexedBytes)) }}</span></td>
          <td class="storage-index-cell">{{ date(source.lastIndexedAt) }}<span v-if="source.autoIndex" class="storage-subline">{{ t('Автообновление, минут:') }} {{ source.indexIntervalMinutes }}</span></td>
          <td><div class="storage-row-actions"><button class="primary" :disabled="busy(source)||!source.enabled" @click="action(source,'index')">{{ t('Переиндексировать') }}</button><button class="secondary" :disabled="busy(source)" @click="edit(source)">{{ t('Настройки') }}</button><details class="storage-more"><summary :aria-label="t('Другие действия')" :title="t('Другие действия')">•••</summary><div class="storage-more-actions"><button class="secondary" :disabled="busy(source)||!source.enabled" @click="action(source,'connect')">{{ t('Проверить подключение') }}</button><button class="secondary" :disabled="busy(source)||!source.enabled" :title="t('Перечитать метаданные всех файлов')" @click="action(source,'rebuild')">{{ t('Полный пересчёт') }}</button><button class="secondary storage-remove" :disabled="busy(source)" @click="remove(source)">{{ t('Убрать') }}</button></div></details></div></td>
        </tr></tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.storage-modal{width:min(800px,calc(100vw - 32px));max-height:calc(100dvh - 40px);padding:0;border:1px solid #4c425d;border-radius:16px;background:#1d1b22;color:#eee;box-shadow:0 24px 80px #0008;overflow:auto}.storage-modal::backdrop{background:#000b;backdrop-filter:blur(3px)}.storage-modal .storage-form{margin:0;border:0;border-radius:0;padding:24px}.storage-modal-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.storage-modal-heading h2{font-size:21px;margin:0}.storage-close{border:1px solid #484152;border-radius:8px;background:#28252f;color:#eee;min-width:34px;height:34px;font-size:24px;cursor:pointer}.storage-close:disabled{opacity:.4;cursor:default}

.storage-page{max-width:1400px;margin:auto}.storage-heading,.storage-source-top,.storage-toolbar,.storage-actions{display:flex;gap:12px;align-items:center;justify-content:space-between}.storage-heading{flex-wrap:wrap;margin-bottom:24px}.storage-heading p,.storage-details,.storage-note{color:#aaa6b5;font-size:13px;line-height:1.6}.storage-form,.storage-source{border:1px solid #393543;background:#1d1b22;border-radius:12px;padding:22px;margin-bottom:16px}.storage-form{display:grid;grid-template-columns:1fr 1fr;gap:16px}.storage-form h2,.wide{grid-column:1/-1}.storage-form label{display:flex;flex-direction:column;gap:8px;font-size:13px}.storage-form .storage-check{flex-direction:row;align-items:center}.storage-check input{width:auto}.storage-path{display:flex;gap:10px}.storage-path input{flex:1;min-width:0}.storage-toolbar{margin:22px 0;justify-content:flex-start}.storage-toolbar input{width:min(450px,80%)}input,select{background:#28252f;color:#eee;border:1px solid #484152;border-radius:8px;padding:10px;font:inherit}input:focus,select:focus{outline:2px solid #9a77d1}.storage-actions{justify-content:flex-start;flex-wrap:wrap;margin-top:16px}.storage-remove{margin-left:auto}.storage-address{overflow-wrap:anywhere;margin:8px 0;color:#aaa6b5;font-size:13px}.storage-source h2{font-size:17px;margin:0}.storage-source h2 small{font-size:11px;font-weight:400;margin-left:8px;border:1px solid #484152;border-radius:5px;padding:3px 6px}.storage-state{color:#ada7b6;font-size:12px;white-space:nowrap}.storage-state.online{color:#82c99c}.storage-state.offline{color:#ed9b91}.storage-state.indexing,.storage-state.connecting{color:#c4a7ff}.storage-details{display:flex;gap:24px;flex-wrap:wrap;margin-top:12px}.storage-error{background:#392328;color:#ffb4b4;border:1px solid #683b43;border-radius:8px;padding:12px}.storage-note{margin:10px 0 0}@media(max-width:700px){.storage-form{grid-template-columns:1fr}.storage-source-top{align-items:flex-start;flex-direction:column}.storage-details{gap:8px}.storage-path{flex-wrap:wrap}.storage-path input{width:100%}}
</style>

<style scoped>
.storage-table-wrap{overflow-x:auto;border:1px solid #393543;border-radius:12px;background:#1d1b22}.storage-table{width:100%;border-collapse:collapse;text-align:left;font-size:13px}.storage-table thead{background:#25222d;color:#aaa6b5}.storage-table th,.storage-table td{padding:13px 16px;vertical-align:top;border-bottom:1px solid #393543}.storage-table thead th{font-size:12px;font-weight:500;white-space:nowrap}.storage-table tbody tr:last-child>*{border-bottom:0}.storage-table tbody tr:hover{background:#25222d}.storage-identity{min-width:200px;max-width:360px;font-weight:400}.storage-identity strong{display:block;font-size:14px;color:#eee}.storage-table .storage-address{display:block;margin:5px 0 0;font-size:12px}.storage-subline{display:block;color:#aaa6b5;font-size:12px;line-height:1.5;margin-top:5px;font-weight:400}.storage-status-cell{min-width:110px;max-width:230px}.storage-count{white-space:nowrap}.storage-index-cell{min-width:140px}.storage-row-actions{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;min-width:250px}.storage-row-actions>button{white-space:nowrap}.storage-more summary{cursor:pointer;list-style:none;border:1px solid #484152;border-radius:8px;background:#28252f;padding:8px 10px;color:#ddd;font-weight:700}.storage-more summary::-webkit-details-marker{display:none}.storage-more summary:focus-visible{outline:2px solid #9a77d1}.storage-more-actions{display:flex;flex-direction:column;align-items:stretch;gap:6px;margin-top:8px}.storage-more-actions .storage-remove{margin-left:0;color:#ed9b91}@media(max-width:700px){.storage-table{min-width:900px}.storage-table th,.storage-table td{padding:12px}.storage-row-actions{min-width:230px}}
</style>

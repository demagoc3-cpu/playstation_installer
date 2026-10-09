<script setup lang="ts">
import type { StorageSource } from '../../shared/types/storage'
const props=defineProps<{modelValue:string; visible?:boolean}>()
const emit=defineEmits<{ 'update:modelValue':[string]; manage:[] }>()
const {t}=useAppLocale()
const {data,error,refresh}=await useFetch<{sources:StorageSource[]}>('/api/storage',{server:false})
watch(()=>props.visible,visible=>{if(visible)void refresh()})
const available=computed(()=>data.value?.sources.filter(s=>s.enabled&&s.kind==='local')||[])
</script>
<template><div class="storage-select"><select :value="props.modelValue" @change="emit('update:modelValue',($event.target as HTMLSelectElement).value)"><option value="">{{t('Выберите хранилище')}}</option><option v-if="props.modelValue&&!available.some(s=>s.localPath===props.modelValue)" :value="props.modelValue" disabled>{{t('Хранилище не подключено:')}} {{props.modelValue}}</option><option v-for="s in available" :key="s.id" :value="s.localPath">{{s.name}} · {{s.kind==='local'?t('Локальная папка'):s.kind.toUpperCase()}}</option></select><button type="button" class="tiny" @click="emit('manage')">{{t('Хранилище')}}</button><small v-if="error">{{t('Не удалось загрузить хранилища')}}</small></div></template>
<style scoped>.storage-select{display:flex;gap:8px;flex-wrap:wrap}.storage-select select{flex:1;min-width:0;background:#28252f;color:#eee;border:1px solid #484152;border-radius:8px;padding:10px}.storage-select small{color:#ed9b91}</style>

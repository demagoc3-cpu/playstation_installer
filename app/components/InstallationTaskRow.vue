<script setup lang="ts">
import { TASK_STATE_LABELS, type InstallationTask } from '#shared/types/tasks'
const { t, formatLocale } = useAppLocale()
const props = defineProps<{ task: InstallationTask; busy?: boolean }>()
const emit = defineEmits<{ cancel: [task: InstallationTask] }>()
const included = ref(true)
watch(() => [props.task.id,props.task.state,props.busy],()=>{if(!props.busy)included.value=true})
function select(checked:boolean){included.value=checked;if(!checked&&props.task.canCancel&&!props.busy)emit('cancel',props.task)}
</script>
<template><PackageTreeRow :item="task" :selectable="task.category==='queued'" :checked="included" :disabled="busy || !task.canCancel" :checkbox-label="t('Снимите галочку, чтобы убрать пакет из очереди')" :detail="`${t(TASK_STATE_LABELS[task.state] || task.state)} · ${t(task.detail)}`" :progress="task.category==='active' ? (task.size ? task.bytesSent/task.size*100 : 0) : undefined" @select="select"><template #subtitle><small class="task-details">{{ task.transport==='service'?'PackageFlowService':'PyLoader' }} · PS4 {{ task.psIp }}<template v-if="task.createdAt"> · {{ new Date(task.createdAt).toLocaleString(formatLocale) }}</template></small></template><template #actions><button v-if="task.canCancel" class="tiny" :disabled="busy || task.cancelRequested" @click="emit('cancel',task)">{{ t(task.cancelRequested?'Отменяем…':task.category==='queued'?'Убрать из очереди':'Отменить задание') }}</button></template></PackageTreeRow></template>
<style scoped>.task-details{font:10px 'DM Mono',monospace;color:#85828a;display:block;margin-top:3px}</style>

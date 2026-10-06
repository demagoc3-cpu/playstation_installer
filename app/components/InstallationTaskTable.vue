<script setup lang="ts">
import { TASK_STATE_LABELS, type InstallationTask } from '#shared/types/tasks'
const { t } = useAppLocale()
const props = defineProps<{ tasks: InstallationTask[]; busy: boolean }>()
const emit = defineEmits<{ cancel: [task: InstallationTask] }>()
const included = reactive<Record<string, boolean>>({})
watch(() => props.busy, busy => { if (!busy) for (const task of props.tasks) included[task.id] = true })
function toggleQueued(task: InstallationTask, checked: boolean) { included[task.id] = checked; if (!checked && task.canCancel && !props.busy) emit('cancel', task) }
const progress = (task: InstallationTask) => task.size ? Math.min(100, Math.round(task.bytesSent / task.size * 100)) : 0
</script>
<template>
  <table class="task-table"><thead><tr><th>{{ t('Игра / Пакет') }}</th><th>{{ t('Файл / Сведения') }}</th><th>{{ t('Тип') }}</th><th>{{ t('Статус') }}</th><th>{{ t('Прогресс') }}</th><th>{{ t('Действия') }}</th></tr></thead><tbody>
    <tr v-for="task in tasks" :key="task.id" :class="task.category"><td><small class="game-label">{{ task.groupTitle }} · {{ task.titleId }}</small><label v-if="task.category === 'queued'" class="table-queue" :title="t('Снимите галочку, чтобы убрать пакет из очереди')"><input type="checkbox" :checked="included[task.id] !== false" :disabled="busy || !task.canCancel" :aria-label="`${t('Оставить в очереди')}: ${task.fileName}`" @change="toggleQueued(task, ($event.target as HTMLInputElement).checked)"></label><strong>{{ task.title }}</strong></td><td class="table-file"><span>{{ task.fileName }}</span><small>{{ t(task.detail) }}</small></td><td>{{ t(task.type) }}</td><td class="task-state" :class="task.state">{{ t(TASK_STATE_LABELS[task.state] || task.state) }}</td><td><template v-if="task.category === 'active'">{{ progress(task) }}%<progress :value="progress(task)" max="100" /></template><span v-else>—</span></td><td><button v-if="task.canCancel" :disabled="busy || task.cancelRequested" @click="emit('cancel', task)">{{ t(task.cancelRequested ? 'Отменяем…' : task.category === 'queued' ? 'Убрать из очереди' : 'Отменить задание') }}</button></td></tr>
  </tbody></table>
</template>
<style scoped>
.table-queue { float: left; margin-right: 8px; }.table-queue input { accent-color: #a789df; cursor: pointer; }
.task-table { width: 100%; border-collapse: collapse; background: #19191c; font-size: 11px; }th { padding: 12px; text-align: left; color: #a999c0; background: #1e1d22; position: sticky; top: 0; z-index: 1; }td { padding: 9px 12px; border-top: 1px solid #393042; vertical-align: middle; }td:first-child { width: 26%; min-width: 165px; }.table-file { width: 38%; min-width: 180px; }td strong,td span,td small { display: block; }td strong { font-size: 12px; }td span { margin: 4px 0; color: #85828a; font: 10px 'DM Mono', monospace; overflow-wrap: anywhere; }td small { font-size: 9px; line-height: 1.35; color: #a09da6; }.game-label { color: #85828a; margin-bottom: 5px; }.task-state{font-size:9px;line-height:1.35;color:#a09da6}.task-state.installed,.task-state.delivered{color:#8dc98c}.task-state.sending,.task-state.receiving,.task-state.waiting,.task-state.installing,.task-state.verifying{color:#c4b9ff}.task-state.failed,.task-state.unconfirmed{color:#e78a80}.task-state.skipped{color:#e3bd77}.active { background: #202025; }progress { display: block; width: 75px; height: 5px; margin-top: 6px; accent-color: #b48bee; }button { border: 1px solid #645071; border-radius: 8px; background: #3e2e4b; color: #eee5fa; font-size: 10px; padding: 8px; cursor: pointer; }button:disabled { opacity: .5; cursor: default; }
</style>

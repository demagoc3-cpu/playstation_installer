<script setup lang="ts">
import {
  installationTaskProgress,
  installationTaskRemainingMinutes,
  installationTaskSpeed,
  installationTaskStateLabel,
  type InstallationTask,
} from '#shared/types/tasks';
/** One line for a device heading: the task in progress, as its active card shows it. */
const props = defineProps<{ task: InstallationTask }>();
const { t, formatLocale } = useAppLocale(),
  now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => (timer = setInterval(() => (now.value = Date.now()), 1000)));
onBeforeUnmount(() => clearInterval(timer));
const percent = computed(() => installationTaskProgress(props.task)),
  speed = computed(() => installationTaskSpeed(props.task, now.value)),
  remaining = computed(() => installationTaskRemainingMinutes(props.task, now.value));
</script>
<template>
  <span class="device-current"
    ><span class="device-current-line"
      ><b>{{ task.title }}</b
      ><em
        >{{ t(installationTaskStateLabel(task)) }} · {{ Math.round(percent) }}%<template
          v-if="speed"
        >
          ·
          {{ (speed / 1048576).toLocaleString(formatLocale, { maximumFractionDigits: 1 }) }}
          {{ t('МиБ/с') }}</template
        ><template v-if="remaining !== undefined"> · {{ remaining }} {{ t('мин') }}</template></em
      ></span
    ><progress :value="percent" max="100" :aria-label="`${t('Прогресс')}: ${task.title}`"
  /></span>
</template>
<style scoped>
.device-current {
  flex: 1 1 260px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.device-current-line {
  display: flex;
  gap: 10px;
  min-width: 0;
  font-size: 12px;
}
.device-current-line b {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #e6efff;
  font-weight: 600;
}
.device-current-line em {
  flex: none;
  font-style: normal;
  color: #a6bee1;
  font-size: 11px;
}
progress {
  width: 100%;
  height: 5px;
}
</style>

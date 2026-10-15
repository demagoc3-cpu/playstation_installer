<script setup lang="ts">
import {
  installationTaskSpeed,
  installationTaskMegabytes,
  type InstallationTask,
} from '#shared/types/tasks';
const props = defineProps<{ task: InstallationTask }>();
const { t, formatLocale } = useAppLocale();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onUnmounted(() => clearInterval(timer));
const speed = computed(() => installationTaskSpeed(props.task, now.value));
const megabytes = computed(() => installationTaskMegabytes(props.task));
const number = (value: number) =>
  value.toLocaleString(formatLocale.value, { maximumFractionDigits: 1 });
</script>
<template>
  <span class="transfer-info"
    ><small
      class="transfer-bytes"
      :title="t(task.progressPhase === 'source-check' ? 'Проверено / всего' : 'Передано / всего')"
      >{{ number(megabytes.transferred) }} / {{ number(megabytes.total) }} {{ t('МБ') }}</small
    ><small
      v-if="speed !== undefined"
      class="transfer-speed"
      :title="
        t(
          (task.consolePlatform || task.platform) === 'ps4'
            ? 'Скорость загрузки по прогрессу PS4'
            : 'Скорость передачи по байтам, подтверждённым PS5',
        )
      "
      >{{ number(speed / 1048576) }} {{ t('МиБ/с') }} · {{ number((speed * 8) / 1000000) }}
      {{ t('Мбит/с') }}</small
    ></span
  >
</template>
<style scoped>
.transfer-info {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.transfer-bytes,
.transfer-speed {
  color: #c4b9ff;
  font:
    10px 'DM Mono',
    monospace;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>

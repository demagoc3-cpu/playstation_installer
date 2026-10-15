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
      class="transfer-speed"
      :title="
        t(
          (task.consolePlatform || task.platform) === 'ps4'
            ? 'Скорость загрузки по прогрессу PS4'
            : 'Скорость передачи по байтам, подтверждённым PS5',
        )
      "
      ><template v-if="speed !== undefined"
        ><span>{{ number(speed / 1048576) }} {{ t('МиБ/с') }}</span
        ><span>· {{ number((speed * 8) / 1000000) }} {{ t('Мбит/с') }}</span></template
      ></small
    ></span
  >
</template>
<style scoped>
.transfer-info {
  display: inline-grid;
  inline-size: 34ch;
  max-inline-size: 100%;
  min-inline-size: 0;
  gap: 5px;
  container: transfer-telemetry / inline-size;
  font:
    10px 'DM Mono',
    monospace;
}
.transfer-bytes,
.transfer-speed {
  color: #89dfff;
  font:
    10px 'DM Mono',
    monospace;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.transfer-bytes {
  overflow-wrap: anywhere;
}
.transfer-speed {
  display: flex;
  flex-wrap: wrap;
  align-content: start;
  gap: 0 0.8ch;
  min-block-size: 1.4em;
}
.transfer-speed > span {
  white-space: nowrap;
}
/* Keep the second rate line reserved when a narrow card wraps the two units. */
@container transfer-telemetry (max-width: 30ch) {
  .transfer-speed {
    min-block-size: 2.8em;
  }
}
</style>

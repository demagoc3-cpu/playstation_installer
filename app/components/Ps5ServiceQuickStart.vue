<script setup lang="ts">
/** Installation review: the same service status as Devices → «Сервис», with a
 * one-click start when the saved service is stopped. */
const props = defineProps<{ consoleId: string; disabled?: boolean }>();
const emit = defineEmits<{ ready: [] }>();
const { t } = useAppLocale();
type Status = {
  service: { state: string; version?: string; buildId?: string };
  manager: { available: boolean; saved?: { slot: string } };
  busy: string;
  operation?: { id: string; state: string; message: string };
};
const status = ref<Status>(),
  started = ref(''),
  error = ref(''),
  sending = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false;
async function load() {
  try {
    status.value = await $fetch<Status>('/api/consoles/service', {
      query: { consoleId: props.consoleId },
    });
    error.value = '';
  } catch (e: any) {
    error.value = e?.data?.message || t('Не удалось проверить службу');
  }
  const op = status.value?.operation;
  if (started.value && op?.id === started.value) {
    if (op.state === 'running' && !disposed) timer = setTimeout(load, 2000);
    else if (op.state === 'completed') emit('ready');
  }
}
async function start() {
  sending.value = true;
  try {
    status.value = await $fetch<Status>('/api/consoles/service', {
      method: 'POST',
      body: { consoleId: props.consoleId, action: 'start' },
    });
    started.value = status.value.operation?.id || '';
    timer = setTimeout(load, 1500);
  } catch (e: any) {
    error.value = e?.data?.message || t('Команда не выполнена');
  } finally {
    sending.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
});
const text = computed(() => {
  if (error.value) return error.value;
  const s = status.value;
  if (!s) return t('Проверяем службу…');
  const op = s.operation;
  if (started.value && op?.id === started.value)
    return op.state === 'running'
      ? t('Запускаем службу…')
      : op.state === 'completed'
        ? t('Служба запущена')
        : t(op.message);
  if (s.service.state === 'running') return t('Служба работает');
  if (s.service.state === 'unreachable') return t('Приставка не в сети');
  if (!s.manager.available) return t('Служба остановлена, PLDMGR недоступен');
  if (!s.manager.saved)
    return t('Служба не сохранена в PLDMGR. Установите её в «Устройства» → «Сервис»');
  return t('Служба остановлена');
});
const canStart = computed(
  () =>
    !started.value &&
    status.value?.service.state === 'stopped' &&
    !!status.value.manager.saved &&
    !status.value.busy,
);
</script>

<template>
  <div class="quick-service">
    <small>{{ t(text) }}</small>
    <button v-if="canStart" :disabled="disabled || sending" @click="start">
      {{ t('Запустить службу') }}
    </button>
  </div>
</template>

<style scoped>
.quick-service {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.quick-service small {
  font-size: 11px;
  color: #acbfdc;
}
.quick-service button {
  padding: 6px 10px;
  font-size: 11px;
}
</style>

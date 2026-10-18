<script setup lang="ts">
import type { Ps5ServiceStartInfo } from '#shared/types/ps5-service-start';

const props = defineProps<{ consoleId: string; online?: boolean; disabled?: boolean }>();
const emit = defineEmits<{ ready: [] }>();
const { locale, t } = useAppLocale();
const label = (ru: string, en: string) => (locale.value === 'en' ? en : ru);
const info = ref<Ps5ServiceStartInfo>(),
  busy = ref(false),
  error = ref(''),
  responseUnknown = ref(false);
const inProgress = computed(() =>
  ['checking', 'starting', 'verifying'].includes(info.value?.operation?.state || ''),
);
const unconfirmed = computed(
  () => responseUnknown.value || info.value?.operation?.state === 'unconfirmed',
);
const status = computed(() => {
  if (error.value) return error.value;
  if (busy.value && !info.value) return label('Проверяем службу…', 'Checking the service…');
  if (info.value?.state === 'running')
    return t(info.value.message || label('Служба работает.', 'The service is running.'));
  const operation = info.value?.operation;
  if (operation?.state === 'checking')
    return label('Проверяем возможность запуска…', 'Checking whether the service can start…');
  if (operation?.state === 'starting') return label('Запускаем службу…', 'Starting the service…');
  if (operation?.state === 'verifying')
    return label('Ожидаем ответа службы…', 'Waiting for the service to respond…');
  if (unconfirmed.value)
    return label(
      'Запуск пока не подтверждён. Проверьте результат.',
      'Startup is not confirmed yet. Check the result.',
    );
  return t(
    operation?.message ||
      info.value?.message ||
      (props.online
        ? label('Служба отвечает.', 'The service is responding.')
        : label('Проверьте службу перед запуском.', 'Check the service before starting it.')),
  );
});
let generation = 0,
  disposed = false,
  pendingRequestId = '',
  readyId = '',
  controller: AbortController | undefined,
  timer: ReturnType<typeof setTimeout> | undefined;

function accept(value: Ps5ServiceStartInfo) {
  info.value = value;
  if (
    value.state === 'running' ||
    (value.operation?.id === pendingRequestId &&
      ['completed', 'failed'].includes(value.operation.state))
  )
    responseUnknown.value = false;
  if (value.state === 'running') {
    const id = value.operation?.id || 'running';
    if (readyId !== id) {
      readyId = id;
      emit('ready');
    }
  }
}
function schedulePoll() {
  clearTimeout(timer);
  if (!disposed && inProgress.value) timer = setTimeout(() => void check(), 1000);
}
async function check() {
  if (disposed || busy.value || (props.disabled && !inProgress.value)) return;
  const token = generation;
  busy.value = true;
  error.value = '';
  controller = new AbortController();
  try {
    const value = await $fetch<Ps5ServiceStartInfo>('/api/consoles/service-start', {
      query: { consoleId: props.consoleId },
      signal: controller.signal,
    });
    if (token === generation && !disposed) accept(value);
  } catch (failure: any) {
    if (token === generation && !disposed)
      error.value = t(
        failure?.data?.message ||
          label('Не удалось проверить службу.', 'Could not check the service.'),
      );
  } finally {
    if (token === generation && !disposed) {
      busy.value = false;
      schedulePoll();
    }
  }
}
async function start(action: 'start' | 'install') {
  if (
    disposed ||
    props.disabled ||
    busy.value ||
    inProgress.value ||
    unconfirmed.value ||
    !(action === 'start' ? info.value?.canStart : info.value?.canInstall)
  )
    return;
  const token = generation;
  pendingRequestId = crypto
    .getRandomValues(new Uint8Array(16))
    .reduce((value, byte) => value + byte.toString(16).padStart(2, '0'), '');
  busy.value = true;
  error.value = '';
  controller = new AbortController();
  try {
    const value = await $fetch<Ps5ServiceStartInfo>('/api/consoles/service-start', {
      method: 'POST',
      body: { consoleId: props.consoleId, requestId: pendingRequestId, action },
      signal: controller.signal,
    });
    if (token === generation && !disposed) accept(value);
  } catch (failure: any) {
    if (token === generation && !disposed) {
      const notDispatched = failure?.data?.data?.dispatched === false;
      responseUnknown.value = !notDispatched;
      if (notDispatched) {
        info.value = undefined;
        pendingRequestId = '';
      }
      error.value = t(
        failure?.data?.message ||
          label(
            'Ответ не получен. Проверьте результат; команда повторно не отправлена.',
            'No reply received. Check the result; the command has not been sent again.',
          ),
      );
    }
  } finally {
    if (token === generation && !disposed) {
      busy.value = false;
      schedulePoll();
    }
  }
}
function reset() {
  generation++;
  controller?.abort();
  clearTimeout(timer);
  info.value = undefined;
  busy.value = false;
  error.value = '';
  responseUnknown.value = false;
  pendingRequestId = '';
  readyId = '';
}
watch(() => props.consoleId, reset);
onBeforeUnmount(() => {
  disposed = true;
  reset();
});
</script>

<template>
  <div class="ps5-service-control">
    <div class="service-actions">
      <button
        :class="{ 'service-primary': !unconfirmed && (info?.canStart || info?.canInstall) }"
        :disabled="disabled || busy || inProgress"
        @click="
          unconfirmed || (!info?.canStart && !info?.canInstall)
            ? check()
            : start(info.canStart ? 'start' : 'install')
        "
      >
        {{
          unconfirmed
            ? label('Проверить результат', 'Check result')
            : info?.canStart
              ? label('Запустить службу', 'Start service')
              : info?.canInstall
                ? label('Установить службу', 'Install service')
                : label('Проверить службу', 'Check service')
        }}
      </button>
    </div>
    <p
      class="service-status"
      :class="{ 'service-error': !!error }"
      role="status"
      aria-live="polite"
    >
      {{ t(status) }}
    </p>
  </div>
</template>

<style scoped>
.ps5-service-control {
  width: min(100%, 23rem);
  min-width: 12rem;
  margin-top: 8px;
}
.service-actions {
  min-height: 34px;
  display: flex;
  align-items: center;
}
button {
  width: 100%;
  min-height: 34px;
  padding: 6px 9px;
  border: 1px solid var(--pf-line, #5897e74d);
  border-radius: 8px;
  background: #102b46;
  color: var(--pf-text, #f3f7ff);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
button.service-primary {
  background: linear-gradient(110deg, #087fba, #6855d8);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.service-status {
  height: 3.9em;
  margin: 6px 0 0;
  overflow: auto;
  overflow-wrap: anywhere;
  color: var(--pf-muted, #a8bed7);
  font-size: 11px;
  line-height: 1.3;
}
.service-error {
  color: #ffb6a7;
}
</style>

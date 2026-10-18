<script setup lang="ts">
/** Devices → «Сервис» for one PS5: status, PLDMGR actions and their progress. */
const props = defineProps<{ consoleId: string; name: string; ip: string; action: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const { t } = useAppLocale();

type Status = {
  service: { state: string; version?: string; buildId?: string; pid?: number };
  manager: {
    available: boolean;
    version?: string;
    saved?: { slot: string; path: string };
    autoload?: boolean;
    message?: string;
  };
  bundle?: { version: string; buildId: string };
  release?: { tag: string; version: string; buildId: string; url: string } | null;
  releaseError?: string;
  updateAvailable: boolean;
  bundleDiffers: boolean;
  busy: string;
  operation?: {
    id: string;
    action: string;
    state: 'running' | 'completed' | 'failed';
    message: string;
    steps: string[];
    details?: string[];
  };
};
const titles: Record<string, string> = {
  status: 'Состояние службы',
  'check-update': 'Проверка обновлений',
  start: 'Запуск службы',
  stop: 'Остановка службы',
  restart: 'Перезапуск службы',
  install: 'Установка службы из комплекта WEB',
  update: 'Обновление службы из релиза GitHub',
  'autoload-on': 'Включение автозапуска',
  'autoload-off': 'Отключение автозапуска',
  remove: 'Удаление службы',
  diagnostics: 'Диагностика запуска',
};
const confirmFirst = ['stop', 'remove', 'install', 'update'];
const status = ref<Status>(),
  error = ref(''),
  loading = ref(false),
  sending = ref(false),
  awaitingConfirm = ref(confirmFirst.includes(props.action)),
  started = ref('');
let timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false;

async function load(release = false) {
  loading.value = true;
  try {
    status.value = await $fetch<Status>('/api/consoles/service', {
      query: { consoleId: props.consoleId, ...(release ? { release: '1' } : {}) },
    });
    error.value = '';
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || t('Не удалось прочитать состояние службы');
  } finally {
    loading.value = false;
  }
}
async function follow() {
  if (disposed) return;
  await load();
  const op = status.value?.operation;
  if (op && op.id === started.value && op.state === 'running') timer = setTimeout(follow, 2000);
  else if (started.value) emit('changed');
}
async function run(action = props.action) {
  awaitingConfirm.value = false;
  sending.value = true;
  error.value = '';
  try {
    status.value = await $fetch<Status>('/api/consoles/service', {
      method: 'POST',
      body: { consoleId: props.consoleId, action },
    });
    started.value = status.value.operation?.id || '';
    timer = setTimeout(follow, 1500);
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || t('Команда не выполнена');
  } finally {
    sending.value = false;
  }
}
onMounted(async () => {
  await load(props.action === 'check-update');
  if (!['status', 'check-update'].includes(props.action) && !awaitingConfirm.value) await run();
});
onBeforeUnmount(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
});
const serviceLine = computed(() => {
  const s = status.value?.service;
  if (!s) return '—';
  if (s.state === 'running') return `${t('Работает')} · ${s.version} · ${s.buildId} · pid ${s.pid}`;
  if (s.state === 'stopped') return t('Остановлена (приставка в сети)');
  if (s.state === 'unreachable') return t('Приставка не отвечает');
  return t('На порту службы отвечает другая программа');
});
const operation = computed(() =>
  status.value?.operation && (!started.value || status.value.operation.id === started.value)
    ? status.value.operation
    : undefined,
);
</script>

<template>
  <div class="backdrop service-backdrop" @click.self="emit('close')">
    <section class="dialog service-dialog" role="dialog" aria-modal="true">
      <div class="service-heading">
        <div>
          <h2>{{ t(titles[action] || 'Сервис') }}</h2>
          <p>{{ name }} · {{ ip }}</p>
        </div>
        <button @click="emit('close')">{{ t('Закрыть') }}</button>
      </div>
      <dl class="service-facts">
        <dt>{{ t('Служба') }}</dt>
        <dd :class="{ good: status?.service.state === 'running' }">{{ serviceLine }}</dd>
        <dt>PLDMGR</dt>
        <dd>
          {{
            status?.manager.available
              ? `${status.manager.version} · ${status.manager.saved ? status.manager.saved.slot : t('служба не сохранена')}`
              : t(status?.manager.message || 'недоступен')
          }}
        </dd>
        <dt>{{ t('Автозапуск') }}</dt>
        <dd>
          {{
            status?.manager.autoload === undefined
              ? '—'
              : t(status.manager.autoload ? 'включён' : 'выключен')
          }}
        </dd>
        <dt>{{ t('Комплект WEB') }}</dt>
        <dd>
          {{ status?.bundle ? `${status.bundle.version} · ${status.bundle.buildId}` : '—' }}
        </dd>
        <template v-if="status?.release !== undefined || status?.releaseError">
          <dt>{{ t('Релиз GitHub') }}</dt>
          <dd>
            <template v-if="status?.release"
              >{{ status.release.tag }} · {{ status.release.version }} ·
              {{ status.release.buildId }}</template
            ><template v-else>{{
              t(status?.releaseError || 'В релизах пока нет службы PS5')
            }}</template>
          </dd>
        </template>
      </dl>
      <p v-if="status?.busy && !operation" class="service-warning">{{ t(status.busy) }}</p>
      <div v-if="awaitingConfirm" class="service-confirm">
        <p>
          {{
            t(
              action === 'remove'
                ? 'Служба будет остановлена, убрана из автозапуска и удалена из PLDMGR. Другие записи PLDMGR не изменятся.'
                : action === 'stop'
                  ? 'Служба будет остановлена. Установка на эту приставку станет недоступна до запуска.'
                  : 'Служба будет остановлена, заменена в PLDMGR и запущена заново. Имя записи не меняется.',
            )
          }}
        </p>
        <button class="primary" :disabled="sending || !!status?.busy" @click="run()">
          {{ t('Подтвердить') }}
        </button>
      </div>
      <div v-if="action === 'check-update' && status?.updateAvailable" class="service-confirm">
        <p>{{ t('Доступна новая сборка службы.') }}</p>
        <button class="primary" :disabled="sending || !!status?.busy" @click="run('update')">
          {{ t('Обновить') }} {{ status.release?.tag }}
        </button>
      </div>
      <p
        v-else-if="action === 'check-update' && status?.release && !status.updateAvailable"
        class="service-ok"
      >
        {{ t('Установлена актуальная сборка.') }}
      </p>
      <section v-if="operation" class="service-steps" aria-live="polite">
        <strong :class="operation.state">{{
          t(
            operation.state === 'running'
              ? 'Выполняется…'
              : operation.state === 'completed'
                ? 'Готово'
                : 'Не выполнено',
          )
        }}</strong>
        <ol>
          <li v-for="(step, index) in operation.steps" :key="index">{{ step }}</li>
        </ol>
        <pre v-if="operation.details?.length">{{
          operation.details.map((line) => t(line)).join('\n')
        }}</pre>
      </section>
      <p v-if="error" class="service-warning" role="alert">{{ t(error) }}</p>
      <div class="profile-actions">
        <button :disabled="loading" @click="load(action === 'check-update')">
          {{ t(loading ? 'Проверяем…' : 'Проверить ещё раз') }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.service-backdrop {
  position: fixed;
  inset: 0;
  z-index: 260;
  display: grid;
  place-items: center;
  padding: 20px;
  background: #000b;
}
.service-dialog {
  width: min(620px, 100%);
  max-height: 90vh;
  overflow: auto;
  padding: 24px;
  border: 1px solid #454052;
  border-radius: 14px;
  background: #1d1d21;
  display: grid;
  gap: 16px;
}
.service-dialog h2 {
  margin: 0;
  font-size: 17px;
}
.service-dialog p {
  margin: 4px 0;
  font-size: 12px;
}
.profile-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
button {
  border: 1px solid #454052;
  border-radius: 8px;
  background: #27262d;
  color: #e9e6ef;
  padding: 9px 12px;
  font-size: 12px;
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.service-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.service-facts {
  display: grid;
  grid-template-columns: 130px 1fr;
  gap: 10px 14px;
  margin: 0;
  font-size: 12px;
}
.service-facts dt {
  color: #9691a0;
}
.service-facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.good,
.service-ok,
.completed {
  color: #87d0a2;
}
.failed,
.service-warning {
  color: #f2a7be;
}
.service-confirm {
  display: grid;
  gap: 10px;
  justify-items: start;
}
.service-steps ol {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 12px;
  display: grid;
  gap: 4px;
}
.service-steps pre {
  max-height: 220px;
  overflow: auto;
  font-size: 11px;
  white-space: pre-wrap;
  background: #0006;
  padding: 10px;
  border-radius: 8px;
}
</style>

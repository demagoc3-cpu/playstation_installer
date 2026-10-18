<script setup lang="ts">
import type { ConsoleProfile } from '#shared/types/consoles';
import type { ConsoleSpeedJob, SpeedMode, Ps5TransferProfile } from '#shared/types/console-speed';
const props = defineProps<{ profile: ConsoleProfile }>(),
  emit = defineEmits<{ close: [] }>();
const { t } = useAppLocale();
const info = ref<{
    ready: boolean;
    message: string;
    queueStatus?: string;
    queueId?: string;
    lastJob?: ConsoleSpeedJob;
    lastTransferProfile?: Ps5TransferProfile;
  }>(),
  job = ref<ConsoleSpeedJob>(),
  busy = ref(false),
  message = ref(''),
  sizeMiB = ref(128),
  modes = ref<SpeedMode[]>(['latency', 'upload', 'download', 'disk']);
const labels = computed<Record<SpeedMode, string>>(() =>
  props.profile.platform === 'ps4'
    ? {
        latency: 'Задержка WEB ↔ PS4',
        upload: 'WEB → PS4 · сеть',
        download: 'PS4 → WEB · сеть',
        disk: 'WEB → PS4 · сеть и запись',
      }
    : {
        latency: 'Задержка WEB ↔ PS5',
        upload: 'WEB → PS5 · сеть',
        download: 'PS5 → WEB · сеть',
        disk: 'WEB → PS5 · сеть и запись',
      },
);
const profileRows: [keyof Ps5TransferProfile, string][] = [
  ['receiveWaitMs', 'Ожидание данных'],
  ['hashMs', 'Хеширование'],
  ['writeMs', 'Запись'],
  ['syncMs', 'Сохранение данных (fsync)'],
  ['checkpointMs', 'Контрольная точка хеша'],
  ['stateMs', 'Сохранение позиции'],
];
const running = computed(() => job.value?.state === 'running');
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
const error = (e: any) => e?.data?.message || e?.message || 'Не удалось выполнить тест';
async function refresh() {
  try {
    info.value = await $fetch('/api/consoles/speed', { query: { consoleId: props.profile.id } });
    if (!job.value && info.value?.lastJob) {
      job.value = info.value.lastJob;
      if (running.value) void poll();
    }
  } catch (e) {
    message.value = error(e);
  }
}
async function poll() {
  if (disposed || !job.value) return;
  try {
    job.value = await $fetch<ConsoleSpeedJob>('/api/consoles/speed', {
      query: { consoleId: props.profile.id, id: job.value.id },
    });
  } catch (e) {
    message.value = error(e);
    return;
  }
  if (running.value) timer = setTimeout(poll, 500);
  else await refresh();
}
async function start() {
  if (busy.value || running.value) return;
  busy.value = true;
  message.value = '';
  try {
    job.value = await $fetch<ConsoleSpeedJob>('/api/consoles/speed', {
      method: 'POST',
      body: {
        consoleId: props.profile.id,
        action: 'start',
        sizeMiB: sizeMiB.value,
        modes: modes.value,
      },
    });
    void poll();
  } catch (e) {
    message.value = error(e);
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  if (!job.value) return;
  try {
    await $fetch('/api/consoles/speed', {
      method: 'POST',
      body: { consoleId: props.profile.id, action: 'cancel', id: job.value.id },
    });
  } catch (e) {
    message.value = error(e);
  }
}
async function queue(action: 'pause' | 'resume') {
  busy.value = true;
  try {
    await $fetch('/api/consoles/tasks', {
      method: 'POST',
      body: { consoleId: props.profile.id, queueId: info.value?.queueId, action },
    });
    await refresh();
  } catch (e) {
    message.value = error(e);
  } finally {
    busy.value = false;
  }
}
const rate = (n?: number) =>
  n === undefined
    ? '—'
    : `${(n / 1048576).toFixed(1)} МиБ/с · ${((n * 8) / 1000000).toFixed(0)} Мбит/с`;
const ms = (n?: number) => (n === undefined ? '—' : `${n.toFixed(1)} мс`);
onMounted(refresh);
onBeforeUnmount(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
  if (running.value) void cancel();
});
</script>
<template>
  <Teleport to="body"
    ><div class="speed-overlay" @click.self="!running && emit('close')">
      <section
        class="speed-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('Тесты скорости')"
      >
        <header>
          <div>
            <h2>{{ t('Тесты скорости') }} · {{ profile.name }}</h2>
            <p>WEB ↔ {{ profile.ip }} · {{ profile.platform.toUpperCase() }}</p>
          </div>
          <button :disabled="running" @click="emit('close')">×</button>
        </header>
        <p>
          {{
            t(
              'Тест выполняется компьютером с WEB напрямую до выбранной приставки. Скорость вашего браузера и NAS в этот замер не входит.',
            )
          }}
        </p>
        <p v-if="info && !info.ready" class="notice">{{ t(info.message) }}</p>
        <div
          v-if="
            profile.platform === 'ps4' &&
            ['running', 'cancelling'].includes(info?.queueStatus || '')
          "
          class="queue-notice"
        >
          <p>
            {{ t('Дождитесь завершения установки на PS4 или отмените её в разделе «Задания».') }}
          </p>
        </div>
        <div
          v-else-if="
            profile.platform === 'ps5' &&
            (info?.queueStatus === 'running' || info?.queueStatus === 'paused')
          "
          class="queue-notice"
        >
          <p>
            {{
              t(
                info.queueStatus === 'paused'
                  ? 'Очередь приостановлена. Данные докачки сохранены.'
                  : 'Перед тестом приостановите передачу, чтобы она не влияла на результат.',
              )
            }}
          </p>
          <button
            :disabled="busy || running"
            @click="queue(info.queueStatus === 'paused' ? 'resume' : 'pause')"
          >
            {{
              t(info.queueStatus === 'paused' ? 'Продолжить передачу' : 'Приостановить передачу')
            }}
          </button>
        </div>
        <fieldset :disabled="busy || running">
          <legend>{{ t('Проверки') }}</legend>
          <label v-for="(label, mode) in labels" :key="mode"
            ><input v-model="modes" type="checkbox" :value="mode" />{{ t(label) }}</label
          ><label
            >{{ t('Объём для каждого теста')
            }}<select v-model.number="sizeMiB">
              <option :value="64">{{ t('64 МиБ') }}</option>
              <option :value="128">{{ t('128 МиБ') }}</option>
              <option :value="256">{{ t('256 МиБ') }}</option>
            </select></label
          >
        </fieldset>
        <p>
          {{
            t(
              profile.platform === 'ps4'
                ? 'Сетевые тесты используют искусственные данные без записи. Тест с записью измеряет сеть и файловый ввод-вывод вместе; временный файл удаляется. Скорость установки PKG измеряется отдельно.'
                : 'Сетевые тесты используют искусственные данные без записи. Тест с записью измеряет сеть и файловый ввод-вывод вместе, а не отдельную скорость SSD. Данные сохраняются группами по 16 МиБ; временный файл удаляется. Хеширование игры измеряется отдельно от этих тестов.',
            )
          }}
        </p>
        <div v-if="running" class="progress" role="status">
          {{ t('Выполняется') }}: {{ job?.current && t(labels[job.current])
          }}<span class="pulse"></span>
        </div>
        <p v-if="job">{{ t('Время замера') }}: {{ new Date(job.startedAt).toLocaleString() }}</p>
        <div class="results-scroll">
          <table v-if="job?.results.length">
            <thead>
              <tr>
                <th>{{ t('Тест') }}</th>
                <th>{{ t('Результат') }}</th>
                <th>{{ t('Объём / время') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in job.results" :key="r.mode">
                <td>
                  {{ t(labels[r.mode])
                  }}<small v-if="r.mode === 'disk'"
                    >{{
                      t(
                        r.receivePipeline
                          ? 'Приём и запись одновременно'
                          : 'Последовательный приём и запись',
                      )
                    }}
                    · {{ t('Время записи') }}: {{ ms(r.writeMs) }} · fsync: {{ ms(r.syncMs) }} ·
                    {{ t(r.cleanup ? 'Временный файл удалён' : 'Уборка не подтверждена') }}</small
                  >
                </td>
                <td>
                  {{ r.mode === 'latency' ? ms(r.latencyMedianMs) : rate(r.bytesPerSecond)
                  }}<small v-if="r.mode === 'latency'"
                    >min {{ ms(r.latencyMinMs) }} · max {{ ms(r.latencyMaxMs) }}</small
                  >
                </td>
                <td>
                  {{ t(r.mode === 'latency' ? '8 запросов' : `${r.bytes / 1048576} МиБ`) }} ·
                  {{ t(`${(r.elapsedMs / 1000).toFixed(2)} с`) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <section
          v-if="profile.platform === 'ps5' && info?.lastTransferProfile"
          class="transfer-profile"
        >
          <h3>{{ t('Последний блок передачи игры') }}</h3>
          <p>
            {{ new Date(info.lastTransferProfile.measuredAt).toLocaleString() }} ·
            {{ t(`${info.lastTransferProfile.bytes / 1048576} МиБ`) }} · BLAKE3
            {{ info.lastTransferProfile.hashMode.toUpperCase() }} ·
            {{ ms(info.lastTransferProfile.elapsedMs) }}
          </p>
          <p>
            {{
              t(
                'Замер внутри ELF. Приём идёт параллельно записи; ожидание данных не равно времени всей сети.',
              )
            }}
          </p>
          <table>
            <tbody>
              <tr v-for="[key, label] in profileRows" :key="key">
                <td>{{ t(label) }}</td>
                <td>{{ ms(info.lastTransferProfile[key] as number) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <p v-if="job && !running" role="status">
          {{
            t(
              job.state === 'completed'
                ? 'Тесты завершены'
                : job.state === 'cancelled'
                  ? 'Тест остановлен'
                  : 'Тест завершился с ошибкой',
            )
          }}<template v-if="job.error">: {{ t(job.error) }}</template>
        </p>
        <p v-if="message" class="notice" role="alert">{{ t(message) }}</p>
        <footer>
          <button v-if="running" @click="cancel">{{ t('Остановить тест') }}</button
          ><button
            v-else
            class="primary"
            :disabled="
              busy ||
              !info?.ready ||
              ['running', 'cancelling'].includes(info?.queueStatus || '') ||
              !modes.length
            "
            @click="start"
          >
            {{ t(busy ? 'Проверяем…' : 'Начать тесты') }}</button
          ><button :disabled="busy || running" @click="refresh">{{ t('Обновить проверку') }}</button
          ><button :disabled="running" @click="emit('close')">{{ t('Закрыть') }}</button>
        </footer>
      </section>
    </div></Teleport
  >
</template>
<style scoped>
.speed-overlay {
  position: fixed;
  inset: 0;
  z-index: 310;
  background: #000b;
  display: grid;
  place-items: center;
  padding: 20px;
}
.speed-dialog {
  width: min(850px, 100%);
  max-height: 90vh;
  overflow: auto;
  background: #1d1d23;
  border: 1px solid #494154;
  border-radius: 16px;
  padding: 24px;
  color: #eee9f6;
  display: grid;
  gap: 14px;
}
header,
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h2 {
  font-size: 20px;
  margin: 0;
}
p {
  margin: 0;
  color: #aaa1b8;
  font-size: 12px;
  line-height: 1.6;
}
fieldset {
  border: 1px solid #494154;
  border-radius: 10px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  padding: 16px;
}
legend {
  font-size: 13px;
}
label {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
}
input {
  accent-color: #a887de;
}
button,
select {
  border: 1px solid #4f455f;
  border-radius: 8px;
  background: #302936;
  color: #eee9f6;
  padding: 9px 13px;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.primary {
  background: #7851aa;
}
.notice {
  color: #f0be8b;
}
.queue-notice {
  padding: 12px;
  background: #2e2638;
  border-radius: 8px;
  display: flex;
  gap: 14px;
  align-items: center;
  justify-content: space-between;
}
.results-scroll {
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: left;
}
th,
td {
  padding: 12px;
  border-bottom: 1px solid #3c3545;
}
th {
  color: #aaa1b8;
}
small {
  display: block;
  color: #aaa1b8;
  margin-top: 6px;
  font-size: 10px;
}
.progress {
  padding: 12px;
  background: #30243f;
  border-radius: 8px;
  font-size: 13px;
}
.pulse {
  display: inline-block;
  width: 8px;
  height: 8px;
  background: #b995ee;
  border-radius: 50%;
  margin-left: 12px;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}
</style>

<script setup lang="ts">
import type { ConsoleProfiles, DeviceActivity } from '#shared/types/consoles';
import type { Ps4SystemSnapshot } from '#shared/types/ps4-system';
import { ps5InstallMessage } from '#shared/ps5-install-readiness';
const props = defineProps<{ profiles: ConsoleProfiles; activity?: DeviceActivity[] }>();
const emit = defineEmits<{ updated: [value: ConsoleProfiles] }>();
const { t } = useAppLocale();
const showCreate = ref(false),
  pending = ref(false),
  message = ref('');
const draft = reactive({
  id: undefined as string | undefined,
  name: '',
  ip: '',
  platform: 'ps4' as 'ps4' | 'ps5',
  model: '',
  transport: 'service' as 'service' | 'payload',
});
const query = ref(''),
  filter = ref('all'),
  onlyOnline = ref(false),
  detailId = ref('');
const shown = computed(() =>
  props.profiles.consoles.filter(
    (item) =>
      (filter.value === 'all' || item.platform === filter.value) &&
      (!onlyOnline.value || item.online) &&
      `${item.name} ${item.ip} ${item.model || ''}`
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
);
const activityFor = (id: string) => props.activity?.find((item) => item.consoleId === id);
const bytes = (value?: number) =>
  value === undefined
    ? '—'
    : `${(value / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ГБ`;
function edit(profile?: ConsoleProfiles['consoles'][number]) {
  Object.assign(draft, {
    id: profile?.id,
    name: profile?.name || '',
    ip: profile?.ip || '',
    platform: profile?.platform || 'ps4',
    model: profile?.model || '',
    transport: profile?.transport || 'service',
  });
  showCreate.value = true;
}
const showConfig = ref(false),
  configHost = ref(''),
  configPort = ref('3000');
const active = computed(() =>
  props.profiles.consoles.find((item) => item.id === (detailId.value || props.profiles.activeId)),
);
const updateId = ref(''),
  speedId = ref('');
const speedDevice = computed(() =>
  props.profiles.consoles.find((item) => item.id === speedId.value),
);
const restartingId = ref('');
let disposed = false;
onBeforeUnmount(() => {
  disposed = true;
});
const updatingDevice = computed(() =>
  props.profiles.consoles.find((item) => item.id === updateId.value),
);
watch(
  () => updatingDevice.value?.ip,
  () => {
    if (!updatingDevice.value) updateId.value = '';
  },
);
async function request(path: string, body: Record<string, unknown>) {
  pending.value = true;
  message.value = '';
  try {
    emit(
      'updated',
      await $fetch<ConsoleProfiles>(`/api/consoles/${path}`, { method: 'POST', body }),
    );
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось сохранить подключение';
  } finally {
    pending.value = false;
  }
}
async function restartService(profile: ConsoleProfiles['consoles'][number]) {
  if (
    pending.value ||
    restartingId.value ||
    profile.platform !== 'ps4' ||
    (activityFor(profile.id)?.counts.active || 0) > 0 ||
    (activityFor(profile.id)?.counts.queued || 0) > 0
  )
    return;
  // Keep the concrete target even when the user switches the active console.
  const { id, ip, name } = profile;
  pending.value = true;
  message.value = '';
  restartingId.value = id;
  try {
    const before = await $fetch<Ps4SystemSnapshot>('/api/ps4/system-info', { query: { ip } });
    if (!before.ready) throw new Error('Сначала проверьте подключение к PS4.');
    const response = await $fetch<{
      message: string;
      result?: { state: string; message?: string; errorHex?: string };
    }>('/api/ps4/service-restart', { method: 'POST', body: { ip } });
    if (response.result?.state === 'failed')
      throw new Error(
        response.result.message ||
          `PS4 отказала в перезапуске сервиса (${response.result.errorHex || '—'}).`,
      );
    message.value = `${name} (${ip}): ${t(response.message)}`;
    pending.value = false;
    // Poll reads only. A lost POST response must never cause another restart.
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (disposed) return;
      try {
        const after = await $fetch<Ps4SystemSnapshot>('/api/ps4/system-info', {
          query: { ip },
          timeout: 3000,
        });
        if (
          before.runtime?.processId &&
          after.ready &&
          after.runtime?.processId &&
          after.runtime.processId !== before.runtime.processId
        ) {
          message.value = `${name} (${ip}): ${t('Сервис перезапущен и снова отвечает.')}`;
          if (props.profiles.consoles.some((item) => item.id === id && item.ip === ip)) {
            try {
              emit(
                'updated',
                await $fetch<ConsoleProfiles>('/api/consoles/probe', {
                  method: 'POST',
                  body: { id },
                }),
              );
            } catch {
              /* Restart is confirmed; refresh remains available. */
            }
          }
          return;
        }
      } catch {
        /* A short disconnect is expected while the daemon changes. */
      }
    }
    message.value = `${name} (${ip}): ${t('Перезапуск пока не подтверждён. Проверьте подключение; повторная команда не отправлена.')}`;
  } catch (error: any) {
    if (!disposed)
      message.value = `${name} (${ip}): ${t(error?.data?.message || error?.message || 'Не удалось запросить перезапуск сервиса.')}`;
  } finally {
    pending.value = false;
    restartingId.value = '';
  }
}
async function downloadConfig() {
  if (!active.value) return;
  message.value = '';
  try {
    const contents = await $fetch<string>('/api/consoles/ui-config', {
      query: { consoleId: active.value.id, host: configHost.value, port: configPort.value },
      responseType: 'text',
    });
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'packageflow-ui.conf';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showConfig.value = false;
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось скачать конфигурацию';
  }
}
function openConfig() {
  configHost.value = location.hostname;
  configPort.value = location.port || '3000';
  showConfig.value = true;
}
async function create() {
  await request('', draft);
  if (!message.value) await request('refresh', {});
  if (!message.value) {
    showCreate.value = false;
    draft.name = '';
    draft.ip = '';
  }
}
</script>

<template>
  <section class="devices-workspace">
    <ConsoleSpeedModal
      v-if="speedDevice"
      :key="speedDevice.id"
      :profile="speedDevice"
      @close="speedId = ''"
    />
    <header class="profile-heading">
      <div>
        <h1>{{ t('Устройства') }}</h1>
        <p>
          {{ profiles.consoles.length }} {{ t('устройств') }} ·
          {{ t('Отдельное сопряжение и очередь для каждой приставки') }}
        </p>
      </div>
      <div class="profile-actions">
        <button :disabled="pending" @click="request('refresh', {})">
          {{ t(pending ? 'Проверяем…' : 'Обновить подключения') }}</button
        ><button class="primary" :disabled="pending" @click="edit()">
          ＋ {{ t('Добавить устройство') }}
        </button>
      </div>
    </header>
    <div class="profile-toolbar">
      <input v-model="query" :placeholder="t('Найти по имени, модели или IP')" /><select
        v-model="filter"
      >
        <option value="all">{{ t('Все') }}</option>
        <option value="ps4">PS4</option>
        <option value="ps5">PS5</option></select
      ><label><input v-model="onlyOnline" type="checkbox" /> {{ t('В сети') }}</label>
    </div>
    <div class="profiles-scroll">
      <table>
        <thead>
          <tr>
            <th>{{ t('Устройство') }}</th>
            <th>{{ t('Тип / модель') }}</th>
            <th>{{ t('Соединение') }}</th>
            <th>{{ t('Свободно') }}</th>
            <th>{{ t('Задания') }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="profile in shown"
            :key="profile.id"
            :class="{ selected: detailId === profile.id }"
          >
            <td>
              <strong>{{ profile.name }}</strong
              ><small>{{ profile.ip }}</small>
            </td>
            <td>
              {{ profile.platform.toUpperCase() }} · {{ profile.model || '—'
              }}<small
                >{{ profile.firmware || '—' }} · {{ t('Сервис') }} {{ profile.version || '—'
                }}<template v-if="profile.pkgVersion">
                  · PKG {{ profile.pkgVersion }}</template
                ></small
              >
            </td>
            <td>
              <span :class="{ online: profile.online }"
                >● {{ t(profile.online ? 'В сети' : 'Нет связи') }}</span
              ><small>{{
                t(
                  profile.paired
                    ? 'Сопряжено'
                    : profile.transport === 'payload'
                      ? 'PyLoader'
                      : 'Нужно сопряжение',
                )
              }}</small>
            </td>
            <td>{{ bytes(profile.freeBytes) }}</td>
            <td>
              {{ t('Активные:') }} {{ activityFor(profile.id)?.counts.active || 0
              }}<small
                >{{ t('В очереди:') }} {{ activityFor(profile.id)?.counts.queued || 0 }}</small
              >
            </td>
            <td>
              <div class="profile-actions">
                <button @click="detailId = profile.id">{{ t('Подключение') }}</button
                ><button v-if="profile.transport !== 'payload'" @click="updateId = profile.id">
                  {{ t('Обновить сервис') }}</button
                ><button
                  v-if="profile.platform === 'ps4'"
                  :disabled="
                    pending ||
                    !!restartingId ||
                    (activityFor(profile.id)?.counts.active || 0) > 0 ||
                    (activityFor(profile.id)?.counts.queued || 0) > 0
                  "
                  @click="restartService(profile)"
                >
                  {{
                    t(restartingId === profile.id ? 'Ожидаем перезапуска…' : 'Перезапустить сервис')
                  }}</button
                ><button @click="speedId = profile.id">{{ t('Тест скорости') }}</button
                ><button @click="edit(profile)">{{ t('Изменить') }}</button
                ><button
                  :disabled="pending || profiles.activeId === profile.id"
                  @click="request('active', { id: profile.id })"
                >
                  {{ t(profiles.activeId === profile.id ? 'Открыто' : 'Открыть') }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!shown.length">
        {{ t('Устройства не найдены. Добавьте приставку или измените фильтр.') }}
      </p>
    </div>
    <section v-if="active" class="profile-details">
      <div class="profile-heading">
        <h2>{{ active.name }} · {{ active.platform.toUpperCase() }}</h2>
        <button :disabled="pending" @click="request('probe', { id: active.id })">
          {{ t('Проверить подключение') }}
        </button>
      </div>
      <p>
        {{ active.ip }} ·
        {{ t(active.transport === 'payload' ? 'PyLoader' : 'PackageFlowService') }}
      </p>
      <form
        v-if="active.transport !== 'payload'"
        class="profile-actions"
        @submit.prevent="request('pair', { id: active.id })"
      >
        <p>{{ t('Выбранная приставка подключается автоматически, без кода.') }}</p>
        <button class="primary" :disabled="pending">
          {{ t(pending ? 'Подключаем…' : active.paired ? 'Переподключить' : 'Подключить') }}
        </button>
      </form>
      <button v-if="active.platform === 'ps5'" @click="openConfig">
        {{ t('Конфигурация приложения PS5') }}
      </button>
      <p v-if="active.platform === 'ps5'">{{ t(ps5InstallMessage(active.capabilities)) }}</p>
    </section>
    <p v-if="message" class="pf-notice" role="alert">{{ t(message) }}</p>
    <div v-if="updatingDevice" class="profile-modal" @click.self="updateId = ''">
      <section
        class="profile-dialog update-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t('Обновление PackageFlowService')"
      >
        <div class="profile-heading">
          <h2>{{ updatingDevice.name }} · {{ updatingDevice.platform.toUpperCase() }}</h2>
          <button @click="updateId = ''">{{ t('Закрыть') }}</button>
        </div>
        <Ps4ServiceUpdates
          v-if="updatingDevice.platform === 'ps4'"
          :key="updatingDevice.id + updatingDevice.ip"
          :ip="updatingDevice.ip"
          :name="updatingDevice.name"
        />
        <Ps5ServiceUpdates
          v-else
          :key="updatingDevice.id + updatingDevice.ip"
          :console-id="updatingDevice.id"
          :name="updatingDevice.name"
          :ip="updatingDevice.ip"
        />
      </section>
    </div>
    <div v-if="showCreate" class="profile-modal" @click.self="showCreate = false">
      <form class="profile-dialog" @submit.prevent="create">
        <h2>{{ t(draft.id ? 'Изменить устройство' : 'Добавить устройство') }}</h2>
        <label
          >{{ t('Название')
          }}<input
            v-model="draft.name"
            maxlength="64"
            required
            :placeholder="t('Приставка в гостиной')" /></label
        ><label
          >{{ t('Тип')
          }}<select v-model="draft.platform" :disabled="!!draft.id">
            <option value="ps4">PlayStation 4</option>
            <option value="ps5">PlayStation 5</option>
          </select></label
        ><label
          >{{ t('Модель')
          }}<input v-model="draft.model" maxlength="64" placeholder="Fat / Slim / Pro" /></label
        ><label
          >{{ t('IP приставки')
          }}<input
            v-model="draft.ip"
            :disabled="!!draft.id"
            placeholder="192.168.1.10"
            required /></label
        ><label v-if="draft.platform === 'ps4'"
          >{{ t('Способ установки')
          }}<select v-model="draft.transport">
            <option value="service">PackageFlowService</option>
            <option value="payload">PyLoader</option>
          </select></label
        >
        <div class="profile-actions">
          <button type="button" @click="showCreate = false">{{ t('Отмена') }}</button
          ><button class="primary" :disabled="pending">{{ t('Сохранить') }}</button>
        </div>
        <p v-if="message" role="alert">{{ t(message) }}</p>
      </form>
    </div>
    <div v-if="showConfig" class="profile-modal" @click.self="showConfig = false">
      <form class="profile-dialog" @submit.prevent="downloadConfig">
        <h2>{{ t('Подключение приложения PS5 к WEB') }}</h2>
        <label
          >{{ t('Локальный IP компьютера с WEB')
          }}<input v-model="configHost" required placeholder="192.168.1.10" /></label
        ><label
          >{{ t('Порт WEB') }}<input v-model="configPort" required inputmode="numeric"
        /></label>
        <p>
          {{
            t(
              'Добавьте packageflow-ui.conf в assets приложения PS5 перед сборкой. Адрес также можно изменить в приложении.',
            )
          }}
        </p>
        <div class="profile-actions">
          <button type="button" @click="showConfig = false">{{ t('Отмена') }}</button
          ><button class="primary">{{ t('Скачать') }}</button>
        </div>
        <p v-if="message" role="alert">{{ t(message) }}</p>
      </form>
    </div>
  </section>
</template>
<style scoped>
.devices-workspace {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.profile-heading,
.profile-actions,
.profile-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.profile-heading {
  justify-content: space-between;
}
h1 {
  margin: 0;
  font-size: 24px;
}
h2 {
  margin: 0;
  font-size: 17px;
}
p {
  font-size: 12px;
  color: #a7a2b1;
  margin: 6px 0;
}
.profile-toolbar > input {
  width: 320px;
  max-width: 50%;
}
.profile-toolbar label {
  font-size: 12px;
}
.profiles-scroll {
  flex: 1;
  min-height: 140px;
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 12px;
}
th,
td {
  padding: 12px;
  border-bottom: 1px solid #333139;
}
th {
  color: #9691a0;
  font-size: 11px;
}
small {
  display: block;
  font-size: 10px;
  color: #95909f;
  margin-top: 6px;
}
.selected {
  background: #25232b;
}
.online {
  color: #87d0a2;
}
.profile-details {
  padding: 16px;
  border: 1px solid #3b3941;
  background: #19191c;
  border-radius: 10px;
  display: grid;
  gap: 12px;
}
.profile-details label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
}
.profile-details input {
  width: 130px;
}
.profile-details > button {
  justify-self: start;
}
button,
input:not([type='checkbox']),
select {
  border: 1px solid #454052;
  border-radius: 8px;
  background: #27262d;
  color: #e9e6ef;
  padding: 9px 12px;
  font-size: 12px;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
button.primary {
  background: #7754ad;
  border-color: #a786df;
}
input {
  accent-color: #a786df;
}
.profile-modal {
  position: fixed;
  inset: 0;
  background: #000b;
  z-index: 250;
  display: grid;
  place-items: center;
  padding: 20px;
}
.profile-dialog {
  width: min(420px, 100%);
  max-height: 90vh;
  overflow: auto;
  background: #1d1d21;
  border: 1px solid #454052;
  border-radius: 14px;
  padding: 24px;
  display: grid;
  gap: 16px;
}
.profile-dialog label {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
.profile-dialog input,
.profile-dialog select {
  width: 100%;
}
.profile-dialog .profile-actions {
  justify-content: flex-end;
}
.update-dialog {
  width: min(900px, 100%);
}
</style>

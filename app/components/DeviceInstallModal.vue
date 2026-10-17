<script setup lang="ts">
import { installationSpaceSupported } from '#shared/device-eligibility';
import type { DeviceSelection, DeviceInstallPreview } from '../../shared/types/consoles';
const { t } = useAppLocale();
const props = defineProps<{ selection: DeviceSelection }>();
const emit = defineEmits<{
  close: [];
  queued: [];
  reinstall: [ip: string, pkg: { id: string; title: string; url: string }];
}>();
// Snapshot this command. Background library refreshes cannot change its contents.
let selection: DeviceSelection = JSON.parse(JSON.stringify(props.selection));
const preview = ref<DeviceInstallPreview>(),
  selected = ref<string[]>([]),
  query = ref(''),
  filter = ref('all');
const overwrite = ref<Record<string, string[]>>({}),
  reviewed = ref<Record<string, string>>({}),
  queueReviewed = ref<Record<string, string>>({});
const busy = ref(false),
  message = ref(''),
  attempted = ref(false),
  results = ref<any[]>([]);
const panel = ref<'selection' | 'installed' | 'queue' | ''>(''),
  panelDevice = ref(''),
  draft = ref<string[]>([]);
let generation = 0;
const requestId = crypto
  .getRandomValues(new Uint8Array(16))
  .reduce((s, n) => s + n.toString(16).padStart(2, '0'), '');
const shown = computed(
  () =>
    preview.value?.devices.filter(
      (item) =>
        (filter.value === 'all' || item.profile.platform === filter.value) &&
        `${item.profile.name} ${item.profile.ip}`.toLowerCase().includes(query.value.toLowerCase()),
    ) || [],
);
const current = computed(() =>
  preview.value?.devices.find((item) => item.profile.id === panelDevice.value),
);
function bytes(value?: number) {
  if (value === undefined) return '—';
  if (!value) return '0 Б';
  const i = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'][i]}`;
}
function required(item: DeviceInstallPreview['devices'][number]) {
  if (!installationSpaceSupported(item.profile)) return 0;
  const extra = item.installedPackages
    .filter((pkg) => overwrite.value[item.profile.id]?.includes(pkg.packageId))
    .reduce((sum, pkg) => sum + pkg.size, 0);
  // The server includes queued legacy/streaming plans and their reserves.
  // PS5 overwrite is currently admitted only for PKG, hence two copies for extra.
  if (item.profile.platform === 'ps5') return item.requiredBytes + extra * 2;
  const source = item.selectedBytes + item.queueBytes + extra;
  return source ? source + Math.max(Math.ceil(source * 0.05), 512 * 1024 * 1024) : 0;
}
function spaceEnough(item: DeviceInstallPreview['devices'][number]) {
  return (
    !required(item) ||
    (item.profile.freeBytes !== undefined && item.profile.freeBytes >= required(item))
  );
}
const ready = computed(
  () =>
    !panel.value &&
    !!selected.value.length &&
    selected.value.every((id) => {
      const item = preview.value?.devices.find((v) => v.profile.id === id);
      return (
        item?.eligible &&
        spaceEnough(item) &&
        (!item.installedPackages.length || reviewed.value[id] === item.reviewToken) &&
        (!item.queuedPackages.length || queueReviewed.value[id] === item.reviewToken)
      );
    }),
);
async function load(preserveSelection = false) {
  if (preserveSelection && attempted.value) return;
  const previous = preserveSelection ? preview.value : undefined,
    previousSelected = preserveSelection ? [...selected.value] : [],
    token = ++generation,
    captured = JSON.parse(JSON.stringify(selection));
  busy.value = true;
  message.value = '';
  panel.value = '';
  if (!preserveSelection) {
    preview.value = undefined;
    selected.value = [];
    reviewed.value = {};
    queueReviewed.value = {};
    overwrite.value = {};
  }
  try {
    const value = await $fetch<DeviceInstallPreview>('/api/consoles/install-preview', {
      method: 'POST',
      body: captured,
    });
    if (token !== generation) return;
    preview.value = value;
    selection = { packageIds: [...value.selection.packageIds] };
    if (preserveSelection) {
      selected.value = previousSelected.filter((id) =>
        value.devices.some((item) => item.profile.id === id),
      );
      overwrite.value = Object.fromEntries(
        value.devices.map((item) => [
          item.profile.id,
          (overwrite.value[item.profile.id] || []).filter((id) =>
            item.installedPackages.some(
              (pkg) => pkg.packageId === id && (pkg.canOverwrite || pkg.canReinstall),
            ),
          ),
        ]),
      );
      for (const item of value.devices) {
        const old = previous?.devices.find((device) => device.profile.id === item.profile.id);
        if (old?.reviewToken !== item.reviewToken) {
          delete reviewed.value[item.profile.id];
          delete queueReviewed.value[item.profile.id];
        }
      }
      return;
    }
    overwrite.value = Object.fromEntries(value.devices.map((item) => [item.profile.id, []]));
    let remembered: string[] = [];
    try {
      remembered = JSON.parse(localStorage.getItem('packageflow-install-devices') || '[]');
    } catch {}
    selected.value = value.devices
      .filter((item) => item.eligible && remembered.includes(item.profile.id))
      .map((item) => item.profile.id);
  } catch (error: any) {
    if (token === generation)
      message.value = error?.data?.message || 'Не удалось проверить набор файлов';
  } finally {
    if (token === generation) busy.value = false;
  }
}
function openSelection() {
  panel.value = 'selection';
  draft.value = [...(preview.value?.selection.packageIds || [])];
}
function openInstalled(item: DeviceInstallPreview['devices'][number]) {
  panelDevice.value = item.profile.id;
  panel.value = 'installed';
  draft.value = [...(overwrite.value[item.profile.id] || [])];
}
function openQueue(item: DeviceInstallPreview['devices'][number]) {
  panelDevice.value = item.profile.id;
  panel.value = 'queue';
}
function allReinstall(item: DeviceInstallPreview['devices'][number], checked: boolean) {
  overwrite.value[item.profile.id] = checked
    ? item.installedPackages.filter((p) => p.canOverwrite || p.canReinstall).map((p) => p.packageId)
    : [];
  reviewed.value[item.profile.id] = item.reviewToken;
}
async function applyPanel() {
  if (panel.value === 'selection') {
    if (!draft.value.length) {
      message.value = 'Выберите хотя бы один пакет';
      return;
    }
    selection = {
      packageIds: preview.value!.selection.packageIds.filter((id) => draft.value.includes(id)),
    };
    await load();
    return;
  }
  const item = current.value;
  if (!item) return;
  if (panel.value === 'installed') {
    for (const pkg of item.installedPackages.filter(
      (p) => p.affected.length && draft.value.includes(p.packageId),
    )) {
      if (
        item.installedPackages.some(
          (p) => p.titleId === pkg.titleId && !draft.value.includes(p.packageId),
        )
      ) {
        message.value =
          'Переустановка базы удаляет её патчи и DLC. Выберите все затронутые пакеты для восстановления';
        return;
      }
    }
    overwrite.value[item.profile.id] = draft.value.filter((id) =>
      item.installedPackages.some((p) => p.packageId === id && (p.canOverwrite || p.canReinstall)),
    );
    reviewed.value[item.profile.id] = item.reviewToken;
  } else queueReviewed.value[item.profile.id] = item.reviewToken;
  panel.value = '';
  message.value = '';
}
async function receive(value: any) {
  results.value = value.results;
  if (value.state === 'completed') {
    message.value = 'Проверьте результаты по каждому устройству';
    if (value.results?.some((r: any) => r.state === 'queued')) emit('queued');
  } else message.value = 'WEB ещё запускает очереди. Проверьте результат через несколько секунд';
}
async function check() {
  busy.value = true;
  try {
    await receive(await $fetch('/api/consoles/install-batch', { query: { requestId } }));
  } catch (error: any) {
    message.value =
      error?.data?.message || 'Не удалось получить результат. Команда повторно не отправлена';
  } finally {
    busy.value = false;
  }
}
async function install() {
  if (!preview.value || !ready.value || busy.value || attempted.value) return;
  attempted.value = true;
  busy.value = true;
  message.value = '';
  try {
    localStorage.setItem('packageflow-install-devices', JSON.stringify(selected.value));
  } catch {}
  try {
    await receive(
      await $fetch('/api/consoles/install-batch', {
        method: 'POST',
        body: {
          requestId,
          selection: { packageIds: [...preview.value.selection.packageIds] },
          consoleIds: [...selected.value],
          overwrite: Object.fromEntries(
            selected.value.map((id) => [id, [...(overwrite.value[id] || [])]]),
          ),
          reviewTokens: Object.fromEntries(
            selected.value.map((id) => [
              id,
              preview.value!.devices.find((item) => item.profile.id === id)!.reviewToken,
            ]),
          ),
        },
      }),
    );
  } catch (error: any) {
    message.value =
      error?.data?.message ||
      'Ответ WEB не получен. Нажмите «Проверить результат»; повторная установка не отправлена';
  } finally {
    busy.value = false;
  }
}
onMounted(() => load());
onBeforeUnmount(() => {
  generation++;
});
</script>
<template>
  <div class="device-overlay" @click.self="!busy && emit('close')">
    <section
      class="device-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="t('Выберите устройства для установки')"
    >
      <header>
        <div>
          <h2>{{ t('Установить на устройства') }}</h2>
          <p v-if="preview">
            {{ preview.files }} {{ t('файлов') }} · {{ bytes(preview.size) }} ·
            {{ t('Проверка наличия с каждой приставки') }}
          </p>
        </div>
        <button :disabled="busy" :aria-label="t('Закрыть')" @click="emit('close')">×</button>
      </header>
      <div class="device-toolbar">
        <input v-model="query" :placeholder="t('Имя или IP устройства')" /><select v-model="filter">
          <option value="all">{{ t('Все') }}</option>
          <option value="ps4">PS4</option>
          <option value="ps5">PS5</option></select
        ><button :disabled="busy || attempted" @click="load()">
          {{ t(busy ? 'Проверяем…' : 'Обновить') }}</button
        ><button v-if="preview" :disabled="busy || attempted" @click="openSelection">
          {{ t('Выбранные пакеты') }} · {{ preview.files }}
        </button>
      </div>
      <div class="device-table">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  :disabled="busy || attempted"
                  :aria-label="t('Выбрать доступные устройства')"
                  :checked="
                    !!shown.filter((item) => item.eligible).length &&
                    shown
                      .filter((item) => item.eligible)
                      .every((item) => selected.includes(item.profile.id))
                  "
                  @change="
                    selected = ($event.target as HTMLInputElement).checked
                      ? [
                          ...new Set([
                            ...selected,
                            ...shown.filter((item) => item.eligible).map((item) => item.profile.id),
                          ]),
                        ]
                      : selected.filter((id) => !shown.some((item) => item.profile.id === id))
                  "
                />
              </th>
              <th>{{ t('Устройство') }}</th>
              <th>{{ t('Тип / модель') }}</th>
              <th>{{ t('Свободно') }}</th>
              <th>{{ t('Установка') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in shown" :key="item.profile.id">
              <td>
                <input
                  v-model="selected"
                  :value="item.profile.id"
                  type="checkbox"
                  :disabled="busy || attempted || !item.eligible"
                  :aria-label="t(`Установить на ${item.profile.name}`)"
                />
              </td>
              <td>
                <strong>{{ item.profile.name }}</strong
                ><small>{{ item.profile.ip }}</small>
              </td>
              <td>
                {{ item.profile.platform.toUpperCase()
                }}<small>{{ item.profile.model || '—' }}</small>
              </td>
              <td>
                <template v-if="!installationSpaceSupported(item.profile)">{{
                  t('PyLoader: место проверяет приставка')
                }}</template
                ><template v-else
                  >{{ bytes(item.profile.freeBytes)
                  }}<small>{{ t('Требуется:') }} {{ bytes(required(item)) }}</small
                  ><small v-if="!spaceEnough(item)" class="failed">{{
                    t(
                      item.profile.freeBytes === undefined
                        ? 'Не удалось прочитать свободное место с приставки'
                        : 'Недостаточно свободного места',
                    )
                  }}</small></template
                >
              </td>
              <td>
                <span :class="{ ready: item.eligible && !item.warning, warning: !!item.warning }">{{
                  t(item.reason || item.warning || 'Готово')
                }}</span>
                <Ps5ServiceQuickStart
                  v-if="item.profile.platform === 'ps5' && !item.profile.online && !attempted"
                  :key="item.profile.id + item.profile.ip"
                  :console-id="item.profile.id"
                  :disabled="busy"
                  @ready="load(true)"
                />
                <div v-if="item.installedPackages.length" class="installed-packages">
                  <strong
                    >{{ t('Уже установлено на приставке:') }}
                    {{ item.installedPackages.length }}</strong
                  ><small v-if="item.profile.platform === 'ps4'" class="warning">{{
                    t(
                      'PS4 удалит выбранные компоненты перед установкой. Переустановка базы включает её патчи и DLC из набора.',
                    )
                  }}</small
                  ><label
                    ><input
                      type="checkbox"
                      :checked="
                        !!item.installedPackages.filter((p) => p.canOverwrite || p.canReinstall)
                          .length &&
                        item.installedPackages
                          .filter((p) => p.canOverwrite || p.canReinstall)
                          .every((p) => overwrite[item.profile.id]?.includes(p.packageId))
                      "
                      :disabled="
                        busy ||
                        attempted ||
                        !item.installedPackages.some((p) => p.canOverwrite || p.canReinstall)
                      "
                      @change="allReinstall(item, ($event.target as HTMLInputElement).checked)"
                    />
                    {{ t('Переустановить все доступные') }}</label
                  ><button :disabled="busy || attempted" @click="openInstalled(item)">
                    {{ t('Выбрать в таблице') }}</button
                  ><small
                    >{{ t('Переустановить:') }} {{ overwrite[item.profile.id]?.length || 0 }} ·
                    {{ t('Пропустить:') }}
                    {{
                      item.installedPackages.length - (overwrite[item.profile.id]?.length || 0)
                    }}</small
                  ><small>{{
                    t(
                      reviewed[item.profile.id] === item.reviewToken
                        ? 'Выбор подтверждён'
                        : 'Подтвердите, что переустановить или пропустить',
                    )
                  }}</small>
                </div>
                <div v-if="item.queuedPackages.length" class="installed-packages">
                  <strong>{{ t('Прежняя очередь:') }} {{ item.queuedPackages.length }}</strong
                  ><button :disabled="busy || attempted" @click="openQueue(item)">
                    {{ t('Посмотреть очередь') }}</button
                  ><small>{{
                    t(
                      queueReviewed[item.profile.id] === item.reviewToken
                        ? 'Добавление в очередь подтверждено'
                        : 'Подтвердите добавление в прежнюю очередь',
                    )
                  }}</small>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="preview && !preview.devices.length">
          {{ t('Добавьте и сопрягите приставки в разделе «Устройства».') }}
        </p>
      </div>
      <p v-if="message" class="pf-notice" role="status">{{ t(message) }}</p>
      <ul v-if="results.length" class="device-results">
        <li v-for="result in results" :key="result.consoleId" :class="result.state">
          <strong>{{ result.name }}</strong> · {{ t(result.message) }}
        </li>
      </ul>
      <footer>
        <span>{{ t('Выбрано устройств:') }} {{ selected.length }}</span
        ><button :disabled="busy" @click="emit('close')">
          {{ t(attempted ? 'Закрыть' : 'Отмена') }}</button
        ><button v-if="attempted" :disabled="busy" @click="check">
          {{ t('Проверить результат') }}</button
        ><button v-else class="primary" :disabled="busy || !ready" @click="install">
          {{ t('Подтвердить установку') }}
        </button>
      </footer>
    </section>
    <div v-if="panel" class="table-overlay" @click.self="panel = ''">
      <section
        class="device-dialog package-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="
          t(
            panel === 'installed'
              ? 'Установленные пакеты'
              : panel === 'queue'
                ? 'Прежняя очередь'
                : 'Выбранные пакеты',
          )
        "
      >
        <header>
          <div>
            <h2>
              {{
                t(
                  panel === 'installed'
                    ? 'Уже установлено на приставке'
                    : panel === 'queue'
                      ? 'Прежняя очередь'
                      : 'Выбранные пакеты',
                )
              }}
            </h2>
            <p v-if="current && panel !== 'selection'">
              {{ current.profile.name }} · {{ current.profile.ip }}
            </p>
            <p>
              {{
                t(
                  panel === 'installed'
                    ? 'Галочка — переустановить; без галочки — пропустить. Список прочитан с устройства.'
                    : panel === 'queue'
                      ? 'Эти задания уже находятся в очереди. Они не включены в ваш новый набор.'
                      : 'Установка включает только пакеты из этой таблицы. Снимите галочки с лишних.',
                )
              }}
            </p>
          </div>
          <button @click="panel = ''" :aria-label="t('Закрыть')">×</button>
        </header>
        <div class="device-table">
          <table>
            <thead>
              <tr>
                <th v-if="panel !== 'queue'">
                  <input
                    type="checkbox"
                    :aria-label="t('Выбрать все пакеты')"
                    :checked="
                      !!draft.length &&
                      draft.length ===
                        (panel === 'selection'
                          ? preview!.packages.length
                          : current!.installedPackages.filter(
                              (p) => p.canOverwrite || p.canReinstall,
                            ).length)
                    "
                    @change="
                      draft = ($event.target as HTMLInputElement).checked
                        ? panel === 'selection'
                          ? preview!.selection.packageIds
                          : [
                              ...current!.installedPackages
                                .filter((p) => p.canOverwrite || p.canReinstall)
                                .map((p) => p.packageId),
                            ]
                        : []
                    "
                  />
                </th>
                <th>{{ t('Пакет') }}</th>
                <th>{{ t('Тип / версия') }}</th>
                <th>{{ t('Размер') }}</th>
                <th>{{ t('Действие') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="pkg in panel === 'selection'
                  ? preview!.packages
                  : panel === 'queue'
                    ? current!.queuedPackages
                    : current!.installedPackages"
                :key="pkg.packageId"
              >
                <td v-if="panel !== 'queue'">
                  <input
                    v-model="draft"
                    type="checkbox"
                    :value="pkg.packageId"
                    :disabled="
                      panel === 'installed' &&
                      !(
                        'canReinstall' in pkg &&
                        (pkg.canReinstall || ('canOverwrite' in pkg && pkg.canOverwrite))
                      )
                    "
                    :aria-label="t(`Выбрать ${pkg.title}`)"
                  />
                </td>
                <td>
                  <strong>{{ pkg.title }}</strong
                  ><small>{{ pkg.titleId }}</small
                  ><template
                    v-if="'affected' in pkg && Array.isArray(pkg.affected) && pkg.affected.length"
                    ><small class="warning"
                      >{{ t('Удалятся и будут установлены заново:') }}
                      {{ pkg.affected.join(' · ') }}</small
                    ></template
                  >
                </td>
                <td>
                  {{ t(pkg.type) }}<small>{{ pkg.version || '—' }}</small>
                </td>
                <td>{{ bytes(pkg.size) }}</td>
                <td>
                  {{
                    t(
                      panel === 'queue'
                        ? 'В прежней очереди'
                        : draft.includes(pkg.packageId)
                          ? panel === 'installed'
                            ? 'Переустановить'
                            : 'Установить'
                          : panel === 'installed'
                            ? 'Пропустить'
                            : 'Убрать из набора',
                    )
                  }}<small v-if="'reinstallReason' in pkg">{{ t(pkg.reinstallReason) }}</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="message" class="warning" role="alert">{{ t(message) }}</p>
        <footer>
          <span>{{ t('Выбрано:') }} {{ draft.length }}</span
          ><button @click="panel = ''">{{ t('Назад') }}</button
          ><button class="primary" @click="applyPanel">
            {{ t(panel === 'queue' ? 'Добавить новый набор в эту очередь' : 'Подтвердить выбор') }}
          </button>
        </footer>
      </section>
    </div>
  </div>
</template>
<style scoped>
.device-overlay,
.table-overlay {
  position: fixed;
  inset: 0;
  background: #020813ba;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: grid;
  place-items: center;
  padding: 24px;
}
.device-overlay {
  z-index: 250;
}
.table-overlay {
  z-index: 251;
  background: #020813d9;
}
.device-dialog {
  width: min(1000px, 100%);
  max-height: 90vh;
  background: #0c2547;
  border: 1px solid var(--pf-line, #5897e74d);
  border-radius: 16px;
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--pf-text, #f3f7ff);
  background: linear-gradient(135deg, #12345af5, #08192ef7);
  box-shadow:
    0 24px 80px #00081880,
    inset 0 1px 0 #d8efff14;
}
.package-dialog {
  width: min(1100px, 100%);
}
header,
footer,
.device-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}
header {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 22px;
}
p {
  font-size: 12px;
  color: var(--pf-muted, #acbfdc);
  margin: 6px 0;
}
.device-toolbar {
  flex-wrap: wrap;
}
.device-toolbar input {
  width: 300px;
  max-width: 50%;
}
.device-table {
  overflow: auto;
  min-height: 0;
  border: 1px solid var(--pf-line, #5897e74d);
  border-radius: 12px;
  background: #06193366;
  scrollbar-width: thin;
  scrollbar-color: #3070b6 #07172b;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: left;
}
th,
td {
  padding: 12px 10px;
  border-bottom: 1px solid #5897e730;
}
th {
  color: #b9cce7;
  font-size: 11px;
  position: sticky;
  top: 0;
  background: #0c2547;
}
td {
  vertical-align: top;
}
tbody tr:hover {
  background: #24578240;
}
tbody tr:has(input:checked) {
  background: #10567d40;
}
small {
  display: block;
  color: #a6bee1;
  font-size: 11px;
  margin-top: 5px;
  max-width: 420px;
  overflow-wrap: anywhere;
}
.ready,
.queued {
  color: #93cea7;
}
.failed,
.uncertain {
  color: #e8a291;
}
.warning {
  color: #e3bd77;
}
.installed-packages {
  margin-top: 9px;
  padding: 10px;
  background: #12345880;
  border: 1px solid var(--pf-line, #5897e74d);
  border-radius: 8px;
}
.installed-packages label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  color: #e3bd77;
}
.installed-packages button {
  margin-top: 8px;
  padding: 6px 10px;
}
.device-results {
  max-height: 170px;
  overflow: auto;
  font-size: 12px;
  padding-left: 20px;
}
footer {
  flex-shrink: 0;
  flex-wrap: wrap;
  border-top: 1px solid var(--pf-line, #5897e74d);
  padding-top: 16px;
}
footer span {
  flex: 1;
  font-size: 12px;
}
button,
input:not([type='checkbox']),
select {
  padding: 9px 12px;
  border: 1px solid var(--pf-line, #5897e74d);
  border-radius: 8px;
  min-height: 38px;
  background: linear-gradient(145deg, #29426475, #142b4b9e);
  color: var(--pf-text, #f3f7ff);
  font-size: 12px;
}
input {
  accent-color: var(--pf-cyan, #37c9fb);
}
button {
  cursor: pointer;
  transition:
    background 0.16s,
    border-color 0.16s;
}
button:hover:not(:disabled) {
  background: #28517c99;
  border-color: #64d6ff80;
}
:focus-visible {
  outline: 2px solid var(--pf-cyan, #37c9fb);
  outline-offset: 2px;
}
button.primary {
  background: linear-gradient(115deg, #159dce, #7561ed);
  border-color: #93caff6e;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
@media (max-width: 600px) {
  .device-overlay,
  .table-overlay {
    padding: 12px;
  }
  .device-dialog {
    padding: 16px;
    max-height: calc(100dvh - 24px);
  }
  .device-toolbar input {
    width: 100%;
    max-width: 100%;
  }
}
</style>

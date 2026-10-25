<script setup lang="ts">
import type { StorageInput, StorageKind, StorageSource } from '../../shared/types/storage';
const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const { t, formatLocale } = useAppLocale();
const sources = ref<StorageSource[]>([]),
  error = ref(''),
  saving = ref(false),
  showForm = ref(false),
  filter = ref('');
const platform = ref(''),
  docker = ref(false);
const defaults = (): StorageInput => ({
  id: undefined,
  kind: 'local',
  name: '',
  path: '',
  username: '',
  domain: '',
  password: '',
  clearPassword: false,
  enabled: true,
  autoIndex: false,
  indexIntervalMinutes: 60,
});
const form = reactive<StorageInput>(defaults());
const modal = ref<HTMLDialogElement>();
const statusSource = ref<StorageSource>(),
  statusPosition = ref<Record<string, string>>({}),
  statusPanel = ref<HTMLElement>();
const menuSource = ref<StorageSource>(),
  menuPosition = ref<Record<string, string>>({}),
  menuPanel = ref<HTMLElement>();
let menuTrigger: HTMLButtonElement | undefined;
function positionPanel(anchor: DOMRect, width: number, height: number) {
  const left = Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12));
  const below = anchor.bottom + 8;
  return {
    left: `${left}px`,
    top: `${below + height <= window.innerHeight - 12 ? below : Math.max(12, anchor.top - height - 8)}px`,
    width: `${width}px`,
    maxHeight: `${window.innerHeight - 24}px`,
  };
}
function showStatus(source: StorageSource, event: Event) {
  if (menuSource.value) return;
  const anchor = (event.currentTarget as HTMLElement).getBoundingClientRect(),
    width = Math.min(360, window.innerWidth - 24);
  statusSource.value = source;
  statusPosition.value = positionPanel(anchor, width, 180);
  void nextTick(() => {
    if (statusSource.value?.id === source.id && statusPanel.value)
      statusPosition.value = positionPanel(
        anchor,
        width,
        statusPanel.value.getBoundingClientRect().height,
      );
  });
}
function hideStatus() {
  statusSource.value = undefined;
}
function closeMenu(restoreFocus = false) {
  menuPanel.value?.hidePopover();
  menuSource.value = undefined;
  if (restoreFocus) menuTrigger?.focus();
}
function openMenu(source: StorageSource, event: Event) {
  if (menuSource.value?.id === source.id) {
    closeMenu(true);
    return;
  }
  closeMenu();
  hideStatus();
  menuTrigger = event.currentTarget as HTMLButtonElement;
  const anchor = menuTrigger.getBoundingClientRect(),
    width = Math.min(256, window.innerWidth - 24);
  menuSource.value = source;
  menuPosition.value = positionPanel(anchor, width, 244);
  void nextTick(() => {
    if (menuSource.value?.id !== source.id || !menuPanel.value) return;
    menuPanel.value.showPopover();
    menuPosition.value = positionPanel(
      anchor,
      width,
      menuPanel.value.getBoundingClientRect().height,
    );
    menuPanel.value.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  });
}
function menuToggle(event: Event) {
  if ((event as ToggleEvent).newState === 'closed' && !menuPanel.value?.matches(':popover-open'))
    menuSource.value = undefined;
}
function menuKeys(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu(true);
    return;
  }
  const buttons = Array.from(
    menuPanel.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
  );
  if (!buttons.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  buttons[
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  ]?.focus();
}
function dismissFloating() {
  hideStatus();
  closeMenu();
}
onMounted(() => {
  window.addEventListener('scroll', dismissFloating, true);
  window.addEventListener('resize', dismissFloating);
});
const protocols: { value: StorageKind; label: string; example: string }[] = [
  { value: 'local', label: 'Локальная папка', example: 'D:\\Games или /srv/games' },
  { value: 'smb', label: 'SMB', example: '\\\\NAS\\games или smb://NAS/games' },
  { value: 'nfs', label: 'NFS', example: 'NAS:/volume1/games' },
  { value: 'webdav', label: 'WebDAV', example: 'https://NAS:5006/games/' },
];
const filtered = computed(() =>
  sources.value.filter((s) =>
    `${s.name} ${s.path} ${s.kind}`.toLowerCase().includes(filter.value.toLowerCase()),
  ),
);
const busy = (s: StorageSource) => ['connecting', 'indexing'].includes(s.state);
const states = {
  unknown: 'Не проверено',
  connecting: 'Подключаем…',
  online: 'Доступно',
  offline: 'Недоступно',
  indexing: 'Индексируем…',
  disabled: 'Отключено',
};
const bytes = (n: number) =>
  n >= 2 ** 40
    ? `${(n / 2 ** 40).toFixed(2)} ТБ`
    : n >= 2 ** 30
      ? `${(n / 2 ** 30).toFixed(1)} ГБ`
      : `${(n / 2 ** 20).toFixed(1)} МБ`;
const date = (n?: number) =>
  n ? new Date(n).toLocaleString(formatLocale.value) : t('Ещё не индексировалось');
const message = (e: any) => e?.data?.message || e?.message || 'Не удалось выполнить действие';
let timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined,
  generation = 0;
function stop() {
  generation++;
  clearTimeout(timer);
  controller?.abort();
  controller = undefined;
}
async function load() {
  const current = generation;
  controller = new AbortController();
  try {
    const value = await $fetch<{ sources: StorageSource[]; platform: string; docker: boolean }>(
      '/api/storage',
      { signal: controller.signal },
    );
    if (current !== generation) return;
    const changed =
      JSON.stringify(sources.value.map((s) => [s.id, s.lastIndexedAt])) !==
      JSON.stringify(value.sources.map((s) => [s.id, s.lastIndexedAt]));
    sources.value = value.sources;
    platform.value = value.platform;
    docker.value = value.docker;
    if (changed) emit('changed');
  } catch (e: any) {
    if (current === generation) error.value = message(e);
  } finally {
    if (current === generation && props.visible)
      timer = setTimeout(load, sources.value.some(busy) ? 2000 : 10000);
  }
}
async function refresh() {
  stop();
  if (props.visible) await load();
}
watch(
  () => props.visible,
  (visible) => {
    stop();
    if (visible) void load();
    else {
      close();
      dismissFloating();
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  stop();
  modal.value?.close();
  dismissFloating();
  window.removeEventListener('scroll', dismissFloating, true);
  window.removeEventListener('resize', dismissFloating);
});
function edit(source?: StorageSource) {
  closeMenu();
  hideStatus();
  Object.assign(
    form,
    defaults(),
    source
      ? {
          id: source.id,
          kind: source.kind,
          name: source.name,
          path: source.path,
          username: source.username,
          domain: source.domain,
          enabled: source.enabled,
          autoIndex: source.autoIndex,
          indexIntervalMinutes: source.indexIntervalMinutes,
        }
      : {},
  );
  error.value = '';
  showForm.value = true;
  void nextTick(() => modal.value?.showModal());
}
watch(
  () => form.kind,
  () => {
    if (!form.id) {
      form.password = '';
      form.username = '';
      form.domain = '';
      form.clearPassword = false;
    }
  },
);
function close() {
  modal.value?.close();
  showForm.value = false;
  form.password = '';
}
async function save() {
  saving.value = true;
  error.value = '';
  try {
    await $fetch('/api/storage', { method: 'POST', body: { ...form } });
    close();
    await refresh();
  } catch (e: any) {
    error.value = message(e);
  } finally {
    saving.value = false;
  }
}
async function action(source: StorageSource, action: string) {
  closeMenu(true);
  error.value = '';
  try {
    await $fetch(`/api/storage/${source.id}/action`, { method: 'POST', body: { action } });
    await refresh();
  } catch (e: any) {
    error.value = message(e);
  }
}
async function remove(source: StorageSource) {
  closeMenu(true);
  if (
    !window.confirm(
      t('Убрать хранилище из библиотеки? Исходные файлы останутся на месте.') + `\n${source.name}`,
    )
  )
    return;
  error.value = '';
  try {
    await $fetch(`/api/storage/${source.id}`, { method: 'DELETE' });
    emit('changed');
    await refresh();
  } catch (e: any) {
    error.value = message(e);
  }
}
async function chooseFolder() {
  error.value = '';
  try {
    const result = await $fetch<{
      directory?: string;
      manual?: boolean;
      cancelled?: boolean;
      docker?: boolean;
    }>('/api/packages/select-directory', { method: 'POST', body: { initial: form.path } });
    if (result.directory && !result.cancelled) form.path = result.directory;
    else if (result.manual)
      error.value = t(
        result.docker
          ? 'Укажите путь внутри контейнера. Папка должна быть подключена к Docker.'
          : 'Введите полный путь на компьютере, где запущен WEB.',
      );
  } catch (e: any) {
    error.value = message(e);
  }
}
</script>

<template>
  <div class="storage-page">
    <header class="storage-heading">
      <div>
        <h1>{{ t('Хранилище') }}</h1>
        <p>
          {{ sources.length }} {{ t('подключений') }} ·
          {{ t('Файлы остаются в источниках. Каталог общий для PS4 и PS5.') }}
        </p>
      </div>
      <button class="primary" @click="edit()">+ {{ t('Добавить хранилище') }}</button>
    </header>
    <p v-if="error && !showForm" class="storage-error" role="alert">{{ t(error) }}</p>
    <dialog
      ref="modal"
      class="storage-modal"
      aria-labelledby="storage-dialog-title"
      @cancel.prevent="!saving && close()"
      @click.self="!saving && close()"
    >
      <form v-if="showForm" class="storage-form" @submit.prevent="save">
        <header class="wide storage-modal-heading">
          <h2 id="storage-dialog-title">
            {{ t(form.id ? 'Настройки хранилища' : 'Новое хранилище') }}
          </h2>
          <button
            type="button"
            class="pf-close storage-close"
            :disabled="saving"
            :aria-label="t('Закрыть')"
            @click="close()"
          >
            ×
          </button>
        </header>
        <p v-if="error" class="wide storage-error" role="alert">{{ t(error) }}</p>
        <label
          ><span>{{ t('Протокол') }}</span
          ><select v-model="form.kind" :disabled="!!form.id" autofocus>
            <option v-for="p in protocols" :key="p.value" :value="p.value">{{ t(p.label) }}</option>
          </select></label
        >
        <label
          ><span>{{ t('Название') }}</span
          ><input
            v-model="form.name"
            maxlength="100"
            :placeholder="t('Например: Основная библиотека')"
        /></label>
        <label class="wide"
          ><span>{{ t('Путь или адрес') }}</span>
          <div class="storage-path">
            <input
              v-model="form.path"
              required
              maxlength="2048"
              :disabled="!!form.id"
              :placeholder="protocols.find((p) => p.value === form.kind)?.example"
            /><button
              v-if="form.kind === 'local' && !form.id"
              type="button"
              class="secondary"
              @click="chooseFolder"
            >
              {{ t('Выбрать папку') }}
            </button>
          </div></label
        >
        <template v-if="form.kind === 'smb' || form.kind === 'webdav'">
          <label
            ><span>{{ t('Логин') }}</span
            ><input v-model="form.username" maxlength="256" autocomplete="username"
          /></label>
          <label
            ><span>{{ t('Пароль') }}</span
            ><input
              v-model="form.password"
              type="password"
              maxlength="4096"
              autocomplete="new-password"
              :placeholder="t(form.id ? 'пусто — оставить сохранённый' : '')"
          /></label>
          <label v-if="form.kind === 'smb'"
            ><span>{{ t('Домен (необязательно)') }}</span
            ><input v-model="form.domain" maxlength="128"
          /></label>
          <label v-if="form.id" class="storage-check"
            ><input v-model="form.clearPassword" type="checkbox" />{{
              t('Удалить сохранённый пароль')
            }}</label
          >
        </template>
        <p v-if="form.kind === 'nfs'" class="wide storage-note">
          {{
            t(
              platform === 'win32'
                ? 'NFS требует NFS-Win и WinFsp. На сервере разрешите доступ компьютеру WEB.'
                : 'NFS требует nfs-common и право монтирования у WEB. На сервере разрешите доступ компьютеру WEB.',
            )
          }}
        </p>
        <p v-if="form.kind === 'webdav'" class="wide storage-note">
          {{
            t(
              platform === 'win32'
                ? 'WebDAV требует rclone и WinFsp на компьютере WEB.'
                : 'WebDAV требует rclone и FUSE на компьютере WEB.',
            )
          }}
        </p>
        <p v-if="form.kind === 'smb' && platform !== 'win32'" class="wide storage-note">
          {{
            t(
              'SMB: пользовательское подключение Linux (GVfs) или cifs-utils с правом монтирования.',
            )
          }}
        </p>
        <p v-if="docker" class="wide storage-note">
          {{
            t(
              'В Docker локальные папки должны быть подключены к контейнеру. Сетевым подключениям нужны компоненты и права внутри контейнера.',
            )
          }}
        </p>
        <label class="storage-check"
          ><input v-model="form.enabled" type="checkbox" />{{ t('Хранилище включено') }}</label
        >
        <label class="storage-check"
          ><input v-model="form.autoIndex" type="checkbox" />{{
            t('Обновлять каталог автоматически')
          }}</label
        >
        <label v-if="form.autoIndex"
          ><span>{{ t('Интервал, минут') }}</span
          ><input
            v-model.number="form.indexIntervalMinutes"
            type="number"
            min="5"
            max="10080"
            required
        /></label>
        <p class="wide storage-note">
          {{
            t(
              'После добавления начнётся индексация. Пароль хранится зашифрованным на компьютере WEB. Игры не копируются.',
            )
          }}
        </p>
        <div class="wide storage-actions">
          <button class="primary" :disabled="saving">
            {{ t(saving ? 'Сохраняем…' : 'Сохранить') }}</button
          ><button type="button" class="secondary" :disabled="saving" @click="close">
            {{ t('Отмена') }}
          </button>
        </div>
      </form>
    </dialog>
    <div class="storage-toolbar">
      <input
        v-model="filter"
        type="search"
        :placeholder="t('Найти по названию, пути или протоколу')"
      /><button class="secondary" @click="refresh">{{ t('Обновить') }}</button>
    </div>
    <p v-if="!sources.length" class="storage-note">
      {{ t('Добавьте папку или сетевое хранилище, чтобы наполнить библиотеку.') }}
    </p>
    <div v-if="filtered.length" class="storage-table-wrap">
      <table class="storage-table">
        <thead>
          <tr>
            <th scope="col">{{ t('Хранилище') }}</th>
            <th scope="col">{{ t('Протокол') }}</th>
            <th scope="col">{{ t('Статус') }}</th>
            <th scope="col">{{ t('Пакеты') }}</th>
            <th scope="col">{{ t('Индексация') }}</th>
            <th scope="col">{{ t('Действия') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="source in filtered" :key="source.id">
            <th scope="row" class="storage-identity">
              <strong :title="source.name">{{ source.name }}</strong
              ><span class="storage-address" :title="source.path">{{ source.path }}</span>
            </th>
            <td>{{ t(protocols.find((p) => p.value === source.kind)?.label || source.kind) }}</td>
            <td class="storage-status-cell">
              <button
                type="button"
                class="storage-state"
                :class="source.state"
                :aria-describedby="
                  statusSource?.id === source.id ? 'storage-status-detail' : undefined
                "
                @mouseenter="showStatus(source, $event)"
                @mouseleave="hideStatus"
                @focus="showStatus(source, $event)"
                @blur="hideStatus"
                @click="showStatus(source, $event)"
              >
                ● {{ t(states[source.state])
                }}<span
                  v-if="source.message || source.state === 'offline'"
                  class="storage-status-info"
                  aria-hidden="true"
                  >ⓘ</span
                >
              </button>
            </td>
            <td class="storage-count">
              <strong>{{ source.packageCount }}</strong
              ><span class="storage-subline">{{ t(bytes(source.indexedBytes)) }}</span>
            </td>
            <td class="storage-index-cell" :title="date(source.lastIndexedAt)">
              {{ source.lastIndexedAt ? date(source.lastIndexedAt) : '—'
              }}<span v-if="source.autoIndex" class="storage-subline"
                >{{ t('Автообновление, минут:') }} {{ source.indexIntervalMinutes }}</span
              >
            </td>
            <td class="storage-actions-cell">
              <button
                type="button"
                class="storage-menu-trigger"
                :aria-label="`${t('Действия')}: ${source.name}`"
                aria-haspopup="menu"
                :aria-expanded="menuSource?.id === source.id"
                @click="openMenu(source, $event)"
              >
                ••• <span aria-hidden="true">⌄</span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <Teleport to="body">
      <div
        v-if="statusSource"
        id="storage-status-detail"
        ref="statusPanel"
        class="storage-status-popover"
        :style="statusPosition"
        role="tooltip"
      >
        <header>
          <strong>{{ statusSource.name }}</strong
          ><span class="storage-state" :class="statusSource.state"
            >● {{ t(states[statusSource.state]) }}</span
          >
        </header>
        <p v-if="statusSource.message">{{ t(statusSource.message) }}</p>
        <p v-if="statusSource.state === 'offline'" class="storage-popover-note">
          {{
            t(
              'Последний каталог сохранён. Установка будет доступна после восстановления подключения.',
            )
          }}
        </p>
        <p v-if="statusSource.hasPassword" class="storage-popover-note">
          {{ t('Пароль сохранён') }}
        </p>
      </div>
      <div
        ref="menuPanel"
        popover="auto"
        class="storage-menu"
        :style="menuPosition"
        role="menu"
        :aria-label="menuSource ? `${t('Действия')}: ${menuSource.name}` : t('Действия')"
        @toggle="menuToggle"
        @keydown="menuKeys"
      >
        <template v-if="menuSource">
          <button
            role="menuitem"
            :disabled="busy(menuSource) || !menuSource.enabled"
            @click="action(menuSource, 'connect')"
          >
            <span aria-hidden="true">↻</span>{{ t('Проверить подключение') }}
          </button>
          <button
            role="menuitem"
            :disabled="busy(menuSource) || !menuSource.enabled"
            @click="action(menuSource, 'index')"
          >
            <span aria-hidden="true">⟳</span>{{ t('Переиндексировать') }}
          </button>
          <button
            role="menuitem"
            :disabled="busy(menuSource) || !menuSource.enabled"
            :title="t('Перечитать метаданные всех файлов')"
            @click="action(menuSource, 'rebuild')"
          >
            <span aria-hidden="true">▤</span>{{ t('Полный пересчёт') }}
          </button>
          <button role="menuitem" :disabled="busy(menuSource)" @click="edit(menuSource)">
            <span aria-hidden="true">⚙</span>{{ t('Настройки') }}
          </button>
          <button
            role="menuitem"
            class="storage-menu-remove"
            :disabled="busy(menuSource)"
            @click="remove(menuSource)"
          >
            <span aria-hidden="true">×</span>{{ t('Убрать') }}
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.storage-modal {
  width: min(800px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  padding: 0;
  border: 1px solid var(--pf-line);
  border-radius: 16px;
  background: rgb(14 29 51 / 97%);
  color: #e6efff;
  box-shadow: 0 24px 80px #0008;
  overflow: auto;
}
.storage-modal::backdrop {
  background: #000b;
  backdrop-filter: blur(3px);
}
.storage-modal .storage-form {
  margin: 0;
  border: 0;
  border-radius: 0;
  padding: 24px;
}
.storage-modal-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.storage-modal-heading h2 {
  font-size: 21px;
  margin: 0;
}
.storage-close {
  border: 1px solid var(--pf-line);
  border-radius: 8px;
  background: linear-gradient(145deg, #29426475, #142b4b9e);
  color: #e6efff;
  min-width: 34px;
  height: 34px;
  font-size: 24px;
  cursor: pointer;
}
.storage-close:disabled {
  opacity: 0.4;
  cursor: default;
}

.storage-page {
  max-width: 1400px;
  margin: auto;
}
.storage-heading,
.storage-source-top,
.storage-toolbar,
.storage-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.storage-heading {
  flex-wrap: wrap;
  margin-bottom: 24px;
}
.storage-heading p,
.storage-details,
.storage-note {
  color: #a6bee1;
  font-size: 13px;
  line-height: 1.6;
}
.storage-form,
.storage-source {
  border: 1px solid var(--pf-line);
  background: linear-gradient(145deg, var(--pf-panel), var(--pf-glass));
  border-radius: 12px;
  padding: 22px;
  margin-bottom: 16px;
}
.storage-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.storage-form h2,
.wide {
  grid-column: 1/-1;
}
.storage-form label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
}
.storage-form .storage-check {
  flex-direction: row;
  align-items: center;
}
.storage-check input {
  width: auto;
}
.storage-path {
  display: flex;
  gap: 10px;
}
.storage-path input {
  flex: 1;
  min-width: 0;
}
.storage-toolbar {
  margin: 22px 0;
  justify-content: flex-start;
}
.storage-toolbar input {
  width: min(450px, 80%);
}
input,
select {
  background: #07172b99;
  color: #e6efff;
  border: 1px solid var(--pf-line);
  border-radius: 8px;
  padding: 10px;
  font: inherit;
}
input:focus,
select:focus {
  outline: 2px solid #53cfff;
}
.storage-actions {
  justify-content: flex-start;
  flex-wrap: wrap;
  margin-top: 16px;
}
.storage-remove {
  margin-left: auto;
}
.storage-address {
  overflow-wrap: anywhere;
  margin: 8px 0;
  color: #a6bee1;
  font-size: 13px;
}
.storage-source h2 {
  font-size: 17px;
  margin: 0;
}
.storage-source h2 small {
  font-size: 11px;
  font-weight: 400;
  margin-left: 8px;
  border: 1px solid var(--pf-line);
  border-radius: 5px;
  padding: 3px 6px;
}
.storage-state {
  color: #a6bee1;
  font-size: 12px;
  white-space: nowrap;
}
.storage-state.online {
  color: #56ddb6;
}
.storage-state.offline {
  color: #ffadbd;
}
.storage-state.indexing,
.storage-state.connecting {
  color: #8dddff;
}
.storage-details {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.storage-error {
  background: #3a14264d;
  color: #ffadbd;
  border: 1px solid #ba59756b;
  border-radius: 8px;
  padding: 12px;
}
.storage-note {
  margin: 10px 0 0;
}
@media (max-width: 700px) {
  .storage-form {
    grid-template-columns: 1fr;
  }
  .storage-source-top {
    align-items: flex-start;
    flex-direction: column;
  }
  .storage-details {
    gap: 8px;
  }
  .storage-path {
    flex-wrap: wrap;
  }
  .storage-path input {
    width: 100%;
  }
}
</style>

<style scoped>
.storage-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--pf-line);
  border-radius: 12px;
  background: linear-gradient(145deg, var(--pf-panel), var(--pf-glass));
}
.storage-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  text-align: left;
  font-size: 13px;
}
.storage-table thead {
  background: #0b294980;
  color: #a6bee1;
}
.storage-table th,
.storage-table td {
  padding: 10px 14px;
  vertical-align: middle;
  border-bottom: 1px solid var(--pf-line);
}
.storage-table thead th {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
.storage-table thead th:nth-child(1) {
  width: 36%;
}
.storage-table thead th:nth-child(2) {
  width: 12%;
}
.storage-table thead th:nth-child(3) {
  width: 15%;
}
.storage-table thead th:nth-child(4) {
  width: 10%;
}
.storage-table thead th:nth-child(5) {
  width: 19%;
}
.storage-table thead th:nth-child(6) {
  width: 8%;
}
.storage-table tbody tr:last-child > * {
  border-bottom: 0;
}
.storage-table tbody tr:hover {
  background: #12305a66;
}
.storage-identity {
  font-weight: 400;
}
.storage-identity strong {
  display: block;
  font-size: 13px;
  color: #e6efff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.storage-table .storage-address {
  display: block;
  margin: 4px 0 0;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.storage-subline {
  display: block;
  color: #a6bee1;
  font-size: 11px;
  line-height: 1.4;
  margin-top: 3px;
  font-weight: 400;
}
.storage-status-cell .storage-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  padding: 3px 0;
  background: none;
  font: inherit;
  font-size: 12px;
  cursor: help;
}
.storage-state:focus-visible,
.storage-menu-trigger:focus-visible {
  outline: 2px solid #53cfff;
  outline-offset: 3px;
  border-radius: 5px;
}
.storage-status-info {
  font-size: 11px;
  opacity: 0.7;
}
.storage-count,
.storage-index-cell {
  white-space: nowrap;
}
.storage-index-cell {
  font-size: 12px;
}
.storage-actions-cell {
  text-align: right;
}
.storage-menu-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--pf-line);
  border-radius: 7px;
  background: linear-gradient(145deg, #29426475, #142b4b9e);
  padding: 5px 10px;
  color: #e6efff;
  font-size: 14px;
  cursor: pointer;
}
.storage-menu-trigger:hover,
.storage-menu-trigger[aria-expanded='true'] {
  background: #1c83d340;
  border-color: #53cfff99;
}
.storage-menu-trigger span {
  font-size: 12px;
}
.storage-status-popover,
.storage-menu {
  position: fixed;
  box-sizing: border-box;
  margin: 0;
  padding: 14px 16px;
  border: 1px solid #8ca7d14d;
  border-radius: 10px;
  background: rgb(14 29 51 / 97%);
  backdrop-filter: blur(18px);
  box-shadow: 0 12px 32px #000a;
  color: #e6efff;
  text-align: left;
  overflow: auto;
  z-index: 80;
}
.storage-status-popover {
  pointer-events: none;
  font-size: 12px;
  line-height: 1.5;
}
.storage-status-popover header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--pf-line);
}
.storage-status-popover strong {
  overflow-wrap: anywhere;
}
.storage-status-popover p {
  margin: 10px 0 0;
  overflow-wrap: anywhere;
}
.storage-popover-note {
  color: #a6bee1;
}
.storage-menu {
  padding: 6px;
}
.storage-menu button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  border: 0;
  border-radius: 6px;
  padding: 10px 12px;
  background: transparent;
  color: #e6efff;
  text-align: left;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.storage-menu button > span {
  width: 18px;
  font-size: 17px;
  text-align: center;
  color: #8dddff;
}
.storage-menu button:hover,
.storage-menu button:focus-visible {
  background: #1c83d340;
  outline: none;
}
.storage-menu button:disabled {
  opacity: 0.4;
  cursor: default;
}
.storage-menu .storage-menu-remove {
  margin-top: 5px;
  border-top: 1px solid var(--pf-line);
  border-radius: 0 0 6px 6px;
  color: #ffadbd;
}
.storage-menu .storage-menu-remove > span {
  color: #ffadbd;
}
@media (max-width: 850px) {
  .storage-table {
    min-width: 760px;
  }
  .storage-table th,
  .storage-table td {
    padding: 9px 12px;
  }
}
</style>

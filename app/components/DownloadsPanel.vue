<script setup lang="ts">
interface Torrent {
  hash: string;
  name: string;
  state: string;
  size: number;
  progress: number;
  downloaded: number;
  speed: number;
  uploadSpeed?: number;
  eta: number;
  seeds: number;
  peers?: number;
  autoInstall: boolean;
}
interface FileRow {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}
const props = defineProps<{
  items: Torrent[];
  ready: boolean;
  version?: string;
  downloadPath?: string;
  remotePath?: string;
  files: Record<string, FileRow[]>;
  ps5: boolean;
  control: (item: Torrent, action: 'pause' | 'resume' | 'delete') => Promise<void>;
}>();
const emit = defineEmits<{
  settings: [];
  refresh: [];
  files: [item: Torrent];
  auto: [item: Torrent, enabled: boolean];
  priority: [item: Torrent, file: FileRow, selected: boolean];
}>();
const { t, formatLocale } = useAppLocale();
const filter = ref('all'),
  selected = ref<string[]>([]),
  pending = ref(false);
const stopped = (item: Torrent) => /paused|stopped/i.test(item.state);
function category(item: Torrent) {
  if (/error|missingFiles|unknown/i.test(item.state)) return 'error';
  if (item.progress >= 1) return 'complete';
  if (/queued/i.test(item.state) || stopped(item)) return 'queued';
  return 'active';
}
const tabs = [
  { id: 'all', label: 'Все' },
  { id: 'active', label: 'Загружаются' },
  { id: 'queued', label: 'В очереди' },
  { id: 'complete', label: 'Завершены' },
];
const visible = computed(() =>
  props.items.filter((item) => filter.value === 'all' || category(item) === filter.value),
);
watch(
  () => props.items,
  (items) =>
    (selected.value = selected.value.filter((hash) => items.some((item) => item.hash === hash))),
);
const allSelected = computed(
  () => !!visible.value.length && visible.value.every((item) => selected.value.includes(item.hash)),
);
function selectAll(checked: boolean) {
  const hashes = visible.value.map((item) => item.hash);
  selected.value = checked
    ? [...new Set([...selected.value, ...hashes])]
    : selected.value.filter((hash) => !hashes.includes(hash));
}
function bytes(n: number) {
  if (!n) return `0 ${t('Б')}`;
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const i = Math.min(4, Math.max(0, Math.floor(Math.log(n) / Math.log(1024))));
  return `${(n / 1024 ** i).toLocaleString(formatLocale.value, { maximumFractionDigits: 1 })} ${t(units[i])}`;
}
function eta(item: Torrent) {
  if (item.progress >= 1 || stopped(item) || !item.eta || item.eta >= 8640000) return '—';
  return item.eta < 60
    ? `${item.eta} ${t('с')}`
    : item.eta < 3600
      ? `${Math.ceil(item.eta / 60)} ${t('мин')}`
      : `${Math.floor(item.eta / 3600)} ${t('ч')} ${Math.ceil((item.eta % 3600) / 60)} ${t('мин')}`;
}
function label(item: Torrent) {
  if (item.state === 'unknown') return 'Статус неизвестен';
  return /error|missingFiles/i.test(item.state)
    ? 'Ошибка'
    : stopped(item)
      ? 'Приостановлено'
      : category(item) === 'complete'
        ? 'Завершено'
        : category(item) === 'queued'
          ? 'В очереди'
          : 'Загружается';
}
async function handleControl(item: Torrent, action: 'pause' | 'resume' | 'delete') {
  if (pending.value) return;
  pending.value = true;
  try {
    await props.control(item, action);
  } finally {
    pending.value = false;
  }
}
async function batch(action: 'pause' | 'resume') {
  if (pending.value) return;
  const items = props.items.filter((item) => selected.value.includes(item.hash));
  pending.value = true;
  try {
    for (const item of items) await props.control(item, action);
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <div class="downloads-workspace glass-workspace">
    <div class="connection-strip glass-surface">
      <span class="connection-name"
        ><span aria-hidden="true">◈</span> qBittorrent
        <small v-if="version">{{ version }}</small></span
      ><span class="glass-status" :class="{ online: ready }"
        ><i />{{ t(ready ? 'Подключено' : 'Нет подключения') }}</span
      >
      <div class="strip-actions">
        <button @click="emit('refresh')">{{ t('Обновить') }}</button
        ><button @click="emit('settings')">⚙ {{ t('Настройки') }}</button>
      </div>
    </div>
    <slot name="settings" /><slot name="add" />
    <div class="workspace-toolbar">
      <div class="glass-tabs" :aria-label="t('Фильтр загрузок')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :class="{ active: filter === tab.id }"
          :aria-pressed="filter === tab.id"
          @click="filter = tab.id"
        >
          {{ t(tab.label) }}
          <span>{{
            tab.id === 'all'
              ? items.length
              : items.filter((item) => category(item) === tab.id).length
          }}</span>
        </button>
      </div>
      <span v-if="selected.length" class="selection-actions"
        >{{ t('Выбрано:') }} {{ selected.length
        }}<button :disabled="pending || !ready" @click="batch('pause')">{{ t('Пауза') }}</button
        ><button :disabled="pending || !ready" @click="batch('resume')">
          {{ t('Продолжить') }}
        </button></span
      >
    </div>
    <div class="glass-table-wrap glass-surface">
      <table class="glass-table download-table" :class="{ 'is-empty': !visible.length }">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                :aria-label="t('Выбрать все загрузки')"
                :checked="allSelected"
                :disabled="!visible.length"
                @change="selectAll(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th>{{ t('Название') }}</th>
            <th>{{ t('Прогресс') }}</th>
            <th>{{ t('Статус') }}</th>
            <th>{{ t('Загрузка') }}</th>
            <th>{{ t('Отдача') }}</th>
            <th>{{ t('Осталось') }}</th>
            <th>{{ t('Действия') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="item in visible" :key="item.hash"
            ><tr :class="{ selected: selected.includes(item.hash) }">
              <td>
                <input
                  v-model="selected"
                  type="checkbox"
                  :value="item.hash"
                  :aria-label="`${t('Выбрать')}: ${item.name}`"
                />
              </td>
              <td class="download-name">
                <strong>{{ item.name }}</strong
                ><small>{{ bytes(item.downloaded) }} / {{ bytes(item.size) }}</small>
              </td>
              <td class="download-progress">
                <strong>{{ Math.round(item.progress * 100) }}%</strong
                ><progress
                  :value="item.progress"
                  max="1"
                  :aria-label="`${t('Прогресс')}: ${item.name}`"
                />
              </td>
              <td>
                <span class="torrent-state" :class="category(item)">{{ t(label(item)) }}</span
                ><small
                  >{{ t('Сиды') }}: {{ item.seeds
                  }}<template v-if="item.peers !== undefined">
                    · {{ t('Пиры') }}: {{ item.peers }}</template
                  ></small
                >
              </td>
              <td class="numeric">{{ bytes(item.speed) }}/с</td>
              <td class="numeric">
                {{ item.uploadSpeed === undefined ? '—' : bytes(item.uploadSpeed) + '/с' }}
              </td>
              <td class="numeric">{{ eta(item) }}</td>
              <td>
                <div class="row-actions">
                  <button
                    :disabled="pending || !ready"
                    :aria-label="`${t(stopped(item) ? 'Продолжить' : 'Пауза')}: ${item.name}`"
                    :title="t(stopped(item) ? 'Продолжить' : 'Пауза')"
                    @click="handleControl(item, stopped(item) ? 'resume' : 'pause')"
                  >
                    {{ stopped(item) ? '▷' : 'Ⅱ' }}</button
                  ><button
                    :aria-expanded="!!files[item.hash]"
                    :aria-label="`${t('Файлы')}: ${item.name}`"
                    :title="t('Файлы')"
                    @click="emit('files', item)"
                  >
                    ▤</button
                  ><button
                    :disabled="pending || !ready"
                    :aria-label="`${t('Убрать задачу, не удаляя файлы')}: ${item.name}`"
                    :title="t('Убрать задачу, не удаляя файлы')"
                    @click="handleControl(item, 'delete')"
                  >
                    ×
                  </button>
                </div>
                <label class="download-auto"
                  ><input
                    type="checkbox"
                    :checked="item.autoInstall"
                    :disabled="ps5 && !item.autoInstall"
                    @change="emit('auto', item, ($event.target as HTMLInputElement).checked)"
                  />{{ t('Автоустановка') }}</label
                >
              </td>
            </tr>
            <tr v-if="files[item.hash]" class="download-files-row">
              <td colspan="8">
                <div class="download-file-list">
                  <label v-for="file in files[item.hash]" :key="file.index"
                    ><input
                      type="checkbox"
                      :checked="file.priority > 0"
                      @change="
                        emit('priority', item, file, ($event.target as HTMLInputElement).checked)
                      "
                    /><span>{{ file.name }}</span
                    ><small
                      >{{ bytes(file.size) }} · {{ Math.round(file.progress * 100) }}%</small
                    ></label
                  >
                </div>
              </td>
            </tr></template
          >
          <tr v-if="!visible.length">
            <td colspan="8" class="glass-empty">
              <span class="empty-symbol" aria-hidden="true">⇣</span
              ><strong>{{
                t(!ready ? 'Подключите qBittorrent' : 'Нет загрузок в этой категории')
              }}</strong
              ><span>{{
                t(
                  !ready
                    ? 'Настройте подключение, чтобы добавлять загрузки и управлять ими.'
                    : 'Добавьте magnet- или .torrent-ссылку либо выберите игру в поиске.',
                )
              }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="download-folder glass-surface">
      <span aria-hidden="true">▱</span>
      <div>
        <small>{{ t('Папка загрузок') }}</small
        ><strong>{{ downloadPath || t('Не задана') }}</strong
        ><small v-if="remotePath">qBittorrent: {{ remotePath }}</small>
      </div>
      <button @click="emit('settings')">{{ t('Изменить') }}</button>
    </div>
  </div>
</template>

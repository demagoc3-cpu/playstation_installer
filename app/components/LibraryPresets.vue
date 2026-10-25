<script setup lang="ts">
import { contentBranchKey } from '#shared/content-platform';
import type { DeviceSelection } from '#shared/types/consoles';
import type { PresetSummary, PresetPage, PresetItem } from '#shared/types/presets';
const { t } = useAppLocale();
const props = defineProps<{
  visible: boolean;
  consoleId?: string;
  installReady?: boolean;
  platform?: 'ps4' | 'ps5';
  ip: string;
  transport: string;
}>();
const emit = defineEmits<{ changed: []; library: []; install: [selection: DeviceSelection] }>();
const list = ref<PresetSummary[]>([]),
  current = ref<PresetPage | null>(null),
  id = ref(''),
  query = ref(''),
  editorOpen = ref(false),
  message = ref(''),
  busy = ref(false),
  page = ref(1),
  pages = ref(1),
  total = ref(0);
const selected = ref(new Map<string, PresetItem>()),
  expanded = reactive<Record<string, boolean>>({}),
  fileInput = ref<HTMLInputElement>();
let controller: AbortController | undefined,
  generation = 0;
const bytes = (value: number) =>
  value >= 1073741824
    ? `${(value / 1073741824).toFixed(2)} ${t('ГБ')}`
    : value >= 1048576
      ? `${(value / 1048576).toFixed(1)} ${t('МБ')}`
      : `${value} ${t('Б')}`;
const groups = computed(() => {
  const result = new Map<
    string,
    { id: string; titleId: string; title: string; icon?: string; items: PresetItem[] }
  >();
  for (const item of current.value?.items || []) {
    const key = contentBranchKey(item);
    let group = result.get(key);
    if (!group) {
      group = {
        id: key,
        titleId: item.titleId,
        title: item.groupTitle,
        icon: item.iconId,
        items: [],
      };
      result.set(key, group);
    }
    group.items.push(item);
  }
  return [...result.values()];
});
function presetCoverStyle(index: number, count: number) {
  const middle = (count - 1) / 2;
  const angle = middle * 8;
  // Spread every fan to the card edges, even when there are only two covers.
  const inset =
    12 + 38 * Math.cos((angle * Math.PI) / 180) + 108 * Math.sin((angle * Math.PI) / 180);
  const position = middle ? (index - middle) / middle : 0;
  return {
    left: `calc(50% - 38px + ${position} * (50% - ${inset}px))`,
    '--angle': `${(index - middle) * 8}deg`,
    '--depth': index,
  };
}
function toggle(item: PresetItem, checked: boolean) {
  const next = new Map(selected.value);
  if (checked) next.set(item.key, item);
  else next.delete(item.key);
  selected.value = next;
}
async function load() {
  controller?.abort();
  controller = new AbortController();
  const request = ++generation;
  try {
    if (id.value) {
      const result = await $fetch<PresetPage>(`/api/presets/${id.value}`, {
        query: { ip: props.ip, page: page.value, q: query.value },
        signal: controller.signal,
      });
      if (request !== generation) return;
      current.value = result;
      pages.value = result.pages;
      page.value = result.page;
      total.value = result.total;
    } else {
      const result = await $fetch<{
        items: PresetSummary[];
        pages: number;
        page: number;
        total: number;
      }>('/api/presets', {
        query: { ip: props.ip, page: page.value, q: query.value },
        signal: controller.signal,
      });
      if (request !== generation) return;
      list.value = result.items;
      pages.value = result.pages;
      page.value = result.page;
      total.value = result.total;
    }
  } catch (e: any) {
    if (request === generation && !controller.signal.aborted)
      message.value = e?.data?.message || 'Не удалось загрузить пресеты';
  }
}
function open(value: string) {
  id.value = value;
  page.value = 1;
  query.value = '';
  current.value = null;
  selected.value = new Map();
  message.value = '';
  void load();
}
async function action(body: any) {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    await $fetch('/api/presets', { method: 'POST', body });
    if (body.action === 'remove') selected.value = new Map();
    await load();
  } catch (e: any) {
    message.value = e?.data?.message || 'Не удалось изменить пресет';
  } finally {
    busy.value = false;
  }
}
async function removePreset() {
  if (!window.confirm(t(`Удалить пресет ${current.value?.name}? Файлы останутся в библиотеке.`)))
    return;
  busy.value = true;
  try {
    await $fetch(`/api/presets/${id.value}`, { method: 'DELETE' });
    open('');
  } catch (e: any) {
    message.value = e?.data?.message || 'Не удалось удалить пресет';
  } finally {
    busy.value = false;
  }
}
function install(all: boolean, presetId = id.value) {
  emit('install', {
    preset: { id: presetId, ...(all ? {} : { keys: [...selected.value.keys()] }) },
  });
}
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  busy.value = true;
  message.value = '';
  try {
    const data = JSON.parse(await file.text());
    const result = await $fetch<{ imported: number }>('/api/presets/import', {
      method: 'POST',
      body: data,
    });
    open('');
    message.value = `Импортировано пресетов: ${result.imported}`;
  } catch (e: any) {
    message.value = e?.data?.message || 'Не удалось загрузить файл пресетов';
  } finally {
    busy.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}
watch(
  () => props.ip,
  () => {
    selected.value.clear();
    page.value = 1;
    void load();
  },
);
watch(
  () => props.visible,
  (value) => {
    if (value) void load();
    else {
      controller?.abort();
      generation++;
    }
  },
);
onMounted(() => {
  if (props.visible) void load();
});
onUnmounted(() => {
  controller?.abort();
  generation++;
});
</script>
<template>
  <section class="presets-workspace">
    <header>
      <div>
        <h1>{{ current?.name || t('Пресеты') }}</h1>
        <p v-if="current">
          {{ t('Игр:') }} {{ current.games }} · {{ t('Файлов:') }} {{ current.files }} ·
          {{ bytes(current.size) }} · {{ t('Доступно:') }} {{ current.available
          }}<span v-if="current.missing" class="missing">
            · {{ t('Отсутствует:') }} {{ current.missing }}</span
          >
        </p>
        <p v-else>{{ t('Ваши подборки игр и пакетов. Общий список для WEB, PS4 и PS5.') }}</p>
      </div>
      <div class="controls">
        <button v-if="id" @click="open('')">← {{ t('Все пресеты') }}</button
        ><a :href="`/api/presets/export${id ? '?id=' + id : ''}`" download>{{
          t(id ? 'Скачать пресет' : 'Скачать список')
        }}</a
        ><button :disabled="busy" @click="fileInput?.click()">{{ t('Загрузить список') }}</button
        ><input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          hidden
          @change="importFile"
        />
      </div>
    </header>
    <form
      class="toolbar"
      @submit.prevent="
        page = 1;
        load();
      "
    >
      <input
        v-model="query"
        :placeholder="t(id ? 'Поиск по всему пресету' : 'Найти пресет')"
      /><button>{{ t('Найти') }}</button
      ><button type="button" @click="load">{{ t('Обновить') }}</button
      ><button v-if="!id" type="button" class="primary" @click="editorOpen = true">
        {{ t('Создать пресет') }}
      </button>
    </form>
    <div v-if="id && current" class="editor">
      <div class="controls">
        <button @click="editorOpen = true">{{ t('Редактировать пресет') }}</button
        ><button @click="emit('library')">{{ t('Добавить из библиотеки') }}</button
        ><button
          :disabled="busy || !selected.size"
          @click="action({ action: 'remove', id, keys: [...selected.keys()] })"
        >
          {{ t('Убрать выбранное') }}</button
        ><button :disabled="busy" @click="removePreset">{{ t('Удалить пресет') }}</button>
      </div>
      <p v-if="current.description">{{ current.description }}</p>
    </div>
    <PresetEditor
      v-if="editorOpen"
      :preset="current || undefined"
      @close="editorOpen = false"
      @saved="load"
    />
    <div v-if="id && current" class="install-bar">
      <span
        >{{ t('Выбрано файлов:') }} {{ selected.size }} ·
        {{ bytes([...selected.values()].reduce((sum, item) => sum + item.size, 0)) }}</span
      ><button
        :disabled="busy || !selected.size || [...selected.values()].some((item) => !item.available)"
        @click="install(false)"
      >
        {{ t('Установить выбранное') }}</button
      ><button :disabled="busy || !current.files || !!current.missing" @click="install(true)">
        {{ t('Установить весь пресет') }}
      </button>
    </div>

    <p v-if="message" class="pf-notice" role="status">{{ t(message) }}</p>
    <div class="preset-scroll" :aria-label="t('Список пресетов')">
      <div v-if="!id" class="preset-grid">
        <article v-for="preset in list" :key="preset.id" class="preset-card">
          <button
            class="preset-art"
            :aria-label="t(`Открыть пресет ${preset.name}`)"
            @click="open(preset.id)"
          >
            <span v-if="!preset.covers?.length" class="preset-symbol">▤</span
            ><span
              v-for="(cover, index) in preset.covers"
              :key="index"
              class="fan-cover"
              :style="presetCoverStyle(index, preset.covers.length)"
              ><img
                v-if="cover.iconId"
                :src="`/api/packages/${cover.iconId}?asset=icon`"
                :alt="cover.title"
                loading="lazy"
              /><span v-else>{{ cover.title.charAt(0) }}</span></span
            >
          </button>
          <div class="preset-info">
            <button class="preset-title" @click="open(preset.id)">{{ preset.name }}</button>
            <p v-if="preset.description" class="preset-description">{{ preset.description }}</p>
            <span
              >{{ t('Игр:') }} {{ preset.games }} · {{ t('Файлов:') }} {{ preset.files }} ·
              {{ bytes(preset.size) }}</span
            ><small v-if="preset.missing" class="missing"
              >{{ t('Отсутствует:') }} {{ preset.missing }}</small
            ><button
              class="preset-install"
              :disabled="busy || !preset.files || !!preset.missing"
              @click="install(true, preset.id)"
            >
              {{ t('Установить пресет') }}
            </button>
          </div>
        </article>
      </div>
      <GameTreeBranch
        v-for="group in id ? groups : []"
        :key="group.id"
        :title="group.title"
        :title-id="group.titleId"
        :cover="group.icon ? `/api/packages/${group.icon}?asset=icon` : undefined"
        :count="group.items.length"
        :open="expanded[group.id] !== false"
        @toggle="expanded[group.id] = expanded[group.id] === false"
        ><template #actions
          ><input
            type="checkbox"
            :aria-label="t(`Выбрать ${group.title}`)"
            :checked="group.items.every((item) => selected.has(item.key))"
            @change="
              group.items.forEach((item) =>
                toggle(item, ($event.target as HTMLInputElement).checked),
              )
            " /></template
        ><PackageTreeRow
          v-for="item in group.items"
          :key="item.key"
          :item="item"
          :checked="selected.has(item.key)"
          :state="!item.available ? 'failed' : item.installed ? 'installed' : 'ready'"
          :detail="
            !item.available ? 'Нет в библиотеке' : item.installed ? 'Установлено' : 'Доступен'
          "
          @select="toggle(item, $event)"
          ><template #actions
            ><button :disabled="busy" @click="action({ action: 'remove', id, keys: [item.key] })">
              {{ t('Убрать') }}
            </button></template
          ></PackageTreeRow
        ></GameTreeBranch
      >
      <p v-if="(!id && !list.length) || (id && !groups.length)">
        {{ t('Список пуст. Выберите игры в библиотеке и добавьте их в пресет.') }}
      </p>
    </div>
    <footer v-if="pages > 1">
      <button
        :disabled="page <= 1"
        @click="
          page--;
          load();
        "
      >
        ‹</button
      ><span>{{ page }} / {{ pages }} · {{ total }} {{ t(id ? 'игр' : 'пресетов') }}</span
      ><button
        :disabled="page >= pages"
        @click="
          page++;
          load();
        "
      >
        ›
      </button>
    </footer>
  </section>
</template>
<style scoped>
.presets-workspace {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
}
h1 {
  margin: 0;
  font-size: 24px;
}
p {
  margin: 5px 0;
  font-size: 12px;
  color: #a6bee1;
}
.controls,
.toolbar,
.install-bar,
footer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.controls {
  flex-wrap: wrap;
}
.toolbar input {
  width: 320px;
  max-width: 40vw;
}
.toolbar {
  flex-wrap: wrap;
}
.editor {
  display: grid;
  gap: 8px;
}
.editor p {
  white-space: pre-wrap;
}
.install-bar {
  border: 1px solid var(--pf-line);
  background: linear-gradient(145deg, var(--pf-panel), var(--pf-glass));
  border-radius: 12px;
  padding: 10px;
  font-size: 12px;
  flex-wrap: wrap;
}
.install-bar span {
  flex: 1;
}
input:not([type='checkbox']) {
  min-width: 0;
  border: 1px solid var(--pf-line);
  border-radius: 9px;
  background: #07172b99;
  color: #e6efff;
  padding: 9px;
  font-size: 12px;
}
input {
  accent-color: #37c9fb;
}
/* Glass buttons like the rest of PackageFlow; «Скачать список» is a link. */
button,
a {
  color: #e6efff;
  background: linear-gradient(145deg, #29426475, #142b4b9e);
  border: 1px solid var(--pf-line);
  border-radius: 9px;
  padding: 9px 12px;
  font-size: 11px;
  text-decoration: none;
  cursor: pointer;
}
button:disabled {
  opacity: 0.4;
}
button:hover:not(:disabled),
a:hover {
  border-color: #53cfff99;
}
.preset-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: grid;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 0;
  padding-right: 6px;
  scrollbar-color: #3070b6 #07172b;
}
.preset-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 8px 0;
}
.preset-grid > .preset-card {
  width: 300px;
  max-width: 100%;
  flex: none;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--pf-line);
  background: linear-gradient(145deg, var(--pf-panel), var(--pf-glass));
  box-shadow:
    0 14px 42px #00081820,
    inset 0 1px 0 #ffffff08;
  overflow: hidden;
  border-radius: 16px;
  min-width: 0;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.preset-grid > .preset-card:hover {
  border-color: #53cfff80;
  box-shadow:
    0 14px 42px #00081830,
    0 0 18px #22bfff26,
    inset 0 1px 0 #ffffff0d;
}
.preset-art {
  position: relative;
  width: 100%;
  height: 156px;
  display: block;
  flex-shrink: 0;
  overflow: hidden;
  border: 0;
  border-bottom: 1px solid var(--pf-line);
  border-radius: 0;
  background: radial-gradient(ellipse at 50% 100%, #1c83d355, transparent 70%), #0b294980;
}
.fan-cover {
  position: absolute;
  bottom: 16px;
  left: calc(50% - 38px);
  width: 76px;
  height: 108px;
  display: grid;
  place-items: center;
  border: 2px solid #5e85b9;
  border-radius: 7px;
  background: #122e58;
  color: #a5dfff;
  font-size: 28px;
  box-shadow: 0 6px 16px #00081899;
  transform: rotate(var(--angle));
  transform-origin: 50% 100%;
  z-index: var(--depth);
}
.fan-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 5px;
}
.preset-info {
  width: 100%;
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
}
.preset-title {
  font-size: 16px;
  text-align: left;
  padding: 0;
  border: 0;
  background: transparent;
  font-weight: 800;
  color: #fff;
}
.preset-info > span,
.preset-info > small {
  font-size: 11px;
  color: #a6bee1;
}
.preset-description {
  font-size: 12px;
  color: #a6bee1;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0;
}
.preset-install {
  width: 100%;
  margin-top: auto;
  padding: 10px 12px;
  color: #fff;
  background: linear-gradient(115deg, #159dce, #7561ed);
  border-color: #93caff6e;
  box-shadow:
    0 4px 18px #267ed826,
    inset 0 1px 0 #ffffff26;
}
.preset-install:hover:not(:disabled) {
  background: linear-gradient(115deg, #22b7e5, #8572ff);
}
.preset-install:disabled {
  opacity: 0.35;
  box-shadow: none;
}
.preset-art:hover {
  background-color: #0e3260a0;
}
.preset-symbol {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #8dddff;
  font-size: 48px;
}
.missing {
  color: #ffadbd !important;
}
footer {
  justify-content: center;
  font-size: 12px;
  color: #a6bee1;
}
</style>

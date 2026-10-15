<script setup lang="ts">
interface Entry {
  id: number;
  time: number;
  level: 'info' | 'warn' | 'error';
  text: string;
  count: number;
}
const props = defineProps<{ entries: Entry[] }>(),
  emit = defineEmits<{ clear: [] }>(),
  { t, formatLocale } = useAppLocale();
const filter = ref('all'),
  query = ref(''),
  list = ref<HTMLElement>();
const tabs = [
  { id: 'all', label: 'Все', icon: '◈' },
  { id: 'error', label: 'Ошибки', icon: '×' },
  { id: 'warn', label: 'Предупреждения', icon: '△' },
  { id: 'info', label: 'Информация', icon: 'i' },
];
const visible = computed(() =>
  props.entries
    .filter(
      (e) =>
        (filter.value === 'all' || e.level === filter.value) &&
        `${e.text} ${new Date(e.time).toLocaleString(formatLocale.value)}`
          .toLowerCase()
          .includes(query.value.trim().toLowerCase()),
    )
    .slice()
    .reverse(),
);
const labels = { info: 'Информация', warn: 'Предупреждение', error: 'Ошибка' };
function date(time: number) {
  return new Date(time).toLocaleString(formatLocale.value);
}
function summary(text: string) {
  return text.split('\n', 1)[0]?.slice(0, 180) ?? '';
}
</script>
<template>
  <section class="event-workspace glass-workspace">
    <div class="workspace-toolbar">
      <div class="glass-tabs" :aria-label="t('Уровень событий')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :class="[tab.id, { active: filter === tab.id }]"
          :aria-pressed="filter === tab.id"
          @click="filter = tab.id"
        >
          <span aria-hidden="true">{{ tab.icon }}</span
          >{{ t(tab.label) }}
          <span>{{
            tab.id === 'all' ? entries.length : entries.filter((e) => e.level === tab.id).length
          }}</span>
        </button>
      </div>
      <div class="event-tools">
        <input
          v-model="query"
          type="search"
          :aria-label="t('Поиск в журнале')"
          :placeholder="t('Поиск в журнале…')"
        /><button :disabled="!entries.length" @click="emit('clear')">{{ t('Очистить') }}</button>
      </div>
    </div>
    <div ref="list" class="event-timeline glass-surface">
      <details v-for="entry in visible" :key="entry.id" class="event-row" :class="entry.level">
        <summary>
          <span class="event-dot" aria-hidden="true">{{
            entry.level === 'error' ? '×' : entry.level === 'warn' ? '!' : 'i'
          }}</span
          ><time>{{ date(entry.time) }}</time
          ><span class="event-level">{{ t(labels[entry.level]) }}</span
          ><span class="event-summary"
            >{{ t(summary(entry.text))
            }}<small v-if="entry.count > 1"> ×{{ entry.count }}</small></span
          ><span class="event-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div class="event-detail">
          <small>{{ t('Подробности события') }}</small>
          <pre>{{ t(entry.text) }}</pre>
        </div>
      </details>
      <div v-if="!visible.length" class="glass-empty">
        <span class="empty-symbol" aria-hidden="true">☰</span
        ><strong>{{
          t(entries.length ? 'Нет событий по выбранным фильтрам' : 'Пока событий нет.')
        }}</strong
        ><span>{{
          t(
            entries.length
              ? 'Измените фильтр или поисковый запрос.'
              : 'Здесь появятся события передач, подключений и ошибки.',
          )
        }}</span
        ><button
          v-if="entries.length"
          @click="
            filter = 'all';
            query = '';
          "
        >
          {{ t('Сбросить фильтры') }}
        </button>
      </div>
    </div>
    <small class="workspace-footnote">{{
      t('Последние события сервера. Журнал начинается заново после перезапуска WEB.')
    }}</small>
  </section>
</template>

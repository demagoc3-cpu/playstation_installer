<script setup lang="ts">
/** «Сервис» dropdown on a Devices row: every service action in one place. */
const props = defineProps<{
  platform: 'ps4' | 'ps5';
  transport?: 'service' | 'payload';
  paired?: boolean;
  busy?: boolean;
  restartBlocked?: boolean;
}>();
const emit = defineEmits<{ select: [action: string] }>();
const { t } = useAppLocale();
const open = ref(false),
  root = ref<HTMLElement>();

type Item = { action: string; label: string; danger?: boolean; disabled?: boolean } | 'separator';
const items = computed<Item[]>(() =>
  props.platform === 'ps5'
    ? [
        { action: 'status', label: 'Проверить службу' },
        { action: 'start', label: 'Запустить' },
        { action: 'restart', label: 'Перезапустить' },
        { action: 'stop', label: 'Остановить' },
        'separator',
        { action: 'check-update', label: 'Проверить обновления' },
        { action: 'install', label: 'Установить из комплекта WEB' },
        { action: 'autoload-on', label: 'Добавить в автозапуск' },
        { action: 'autoload-off', label: 'Убрать из автозапуска' },
        { action: 'diagnostics', label: 'Диагностика запуска' },
        'separator',
        { action: 'pair', label: props.paired ? 'Переподключить' : 'Подключить' },
        { action: 'config', label: 'Конфигурация приложения PS5' },
        'separator',
        { action: 'remove', label: 'Удалить службу', danger: true },
      ]
    : [
        { action: 'probe', label: 'Проверить подключение' },
        ...(props.transport === 'payload'
          ? []
          : ([
              { action: 'ps4-update', label: 'Обновить сервис' },
              {
                action: 'ps4-restart',
                label: 'Перезапустить сервис',
                disabled: props.restartBlocked,
              },
              'separator',
              { action: 'pair', label: props.paired ? 'Переподключить' : 'Подключить' },
            ] as Item[])),
      ],
);
function choose(action: string) {
  open.value = false;
  emit('select', action);
}
function outside(event: MouseEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}
function key(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false;
}
onMounted(() => {
  document.addEventListener('mousedown', outside);
  document.addEventListener('keydown', key);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', outside);
  document.removeEventListener('keydown', key);
});
</script>

<template>
  <div ref="root" class="service-menu">
    <button
      :disabled="busy"
      :aria-expanded="open"
      aria-haspopup="menu"
      class="service-trigger"
      @click="open = !open"
    >
      {{ t('Сервис') }} <span aria-hidden="true">▾</span>
    </button>
    <div v-if="open" class="storage-menu service-list" role="menu">
      <template v-for="(item, index) in items" :key="index">
        <hr v-if="item === 'separator'" />
        <button
          v-else
          role="menuitem"
          :class="{ danger: item.danger }"
          :disabled="item.disabled"
          @click="choose(item.action)"
        >
          {{ t(item.label) }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.service-menu {
  position: relative;
  display: inline-block;
}
.service-trigger span {
  margin-left: 4px;
  font-size: 10px;
}
.service-list {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 40;
  min-width: 240px;
  padding: 6px;
  border: 1px solid rgb(148 186 244 / 22%);
  border-radius: 12px;
  background: rgb(16 31 54 / 96%);
  box-shadow: 0 18px 50px #000a;
  display: grid;
  gap: 2px;
}
.service-menu .service-list button {
  text-align: left;
  border: 0;
  background: transparent;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 12px;
  white-space: nowrap;
}
.service-menu .service-list button:hover:not(:disabled) {
  background: rgb(55 201 251 / 14%);
}
.service-menu .service-list .danger {
  color: #f2a7be;
}
.service-list hr {
  border: 0;
  border-top: 1px solid rgb(148 186 244 / 16%);
  margin: 4px 6px;
}
</style>

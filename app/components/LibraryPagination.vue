<script setup lang="ts">
const { t } = useAppLocale()
const props = defineProps<{ page: number; pages: number; pageSize: number; total: number; busy: boolean }>()
const emit = defineEmits<{ page: [value: number]; size: [value: number] }>()
const targetPage = ref(props.page)
watch(() => props.page, value => { targetPage.value = value })
function go() {
  const value = Number(targetPage.value)
  if (Number.isSafeInteger(value) && value >= 1 && value <= props.pages) emit('page', value)
  else targetPage.value = props.page
}
const range = computed(() => `${props.total ? (props.page - 1) * props.pageSize + 1 : 0}–${Math.min(props.page * props.pageSize, props.total)}`)
</script>

<template>
  <nav class="library-pagination" :aria-label="t('Страницы библиотеки')">
    <span class="page-range">{{ range }} {{ t('из') }} {{ total }} {{ t('пакетов') }}</span>
    <label class="page-size">{{ t('На странице') }}
      <select :value="pageSize" :disabled="busy" @change="emit('size', Number(($event.target as HTMLSelectElement).value))">
        <option :value="25">25</option><option :value="50">50</option><option :value="100">100</option>
      </select>
    </label>
    <div class="page-buttons">
      <button type="button" :disabled="busy || page <= 1" :aria-label="t('Первая страница')" @click="emit('page', 1)">«</button>
      <button type="button" :disabled="busy || page <= 1" :aria-label="t('Предыдущая страница')" @click="emit('page', page - 1)">‹</button>
      <form @submit.prevent="go">
        <label>{{ t('Страница') }} <input v-model.number="targetPage" type="number" :min="1" :max="pages" :disabled="busy" :aria-label="t('Номер страницы')"> {{ t('из') }} {{ pages }}</label>
        <button type="submit" :disabled="busy">{{ t('Перейти') }}</button>
      </form>
      <button type="button" :disabled="busy || page >= pages" :aria-label="t('Следующая страница')" @click="emit('page', page + 1)">›</button>
      <button type="button" :disabled="busy || page >= pages" :aria-label="t('Последняя страница')" @click="emit('page', pages)">»</button>
    </div>
  </nav>
</template>

<style scoped>
.library-pagination { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 16px 20px; color: #aaa4bb; font-size: 12px; }
.page-range { margin-right: auto; font-variant-numeric: tabular-nums; }
.page-size, .page-buttons, form, form label { display: flex; align-items: center; gap: 8px; }
button, select, input { border: 1px solid #49405c; border-radius: 8px; background: #252031; color: #eee8ff; padding: 8px 10px; font: inherit; }
button { cursor: pointer; min-width: 34px; }
button:hover:not(:disabled) { border-color: #a285ef; background: #3b2f52; }
button:disabled, select:disabled, input:disabled { opacity: .45; cursor: default; }
input { width: 62px; text-align: center; }
:focus-visible { outline: 2px solid #ad91ff; outline-offset: 2px; }
@media (max-width: 1100px) { .page-buttons { flex-wrap: wrap; } }
</style>

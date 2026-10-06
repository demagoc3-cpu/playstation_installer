<script setup lang="ts">
import type { SearchResult, SearchDetails } from '#shared/types/search'
const props = defineProps<{ results: SearchResult[]; busy: boolean; ready: boolean; pending: string; message: string; visible: boolean; searched: boolean; loadingMore: boolean; hasMore: boolean; total?: number }>()
const emit = defineEmits<{ download: [result: SearchResult, autoInstall: boolean]; loadMore: [] }>()
const { t, formatLocale } = useAppLocale()
const sort = ref('date')
const selected = ref<SearchResult | null>(null)
const modal = ref<HTMLDialogElement>()
const detailCache = reactive<Record<string, SearchDetails>>({})
const detailBusy = ref(false)
const detailMessage = ref('')
let generation = 0
const grid = ref<HTMLElement>()
let observer: IntersectionObserver | undefined
let stopped = false
const requests = new Map<string, { result: SearchResult; controller: AbortController; promise: Promise<void>; done: () => void; allowBrowser: boolean; started: boolean }>()
const waiting: string[] = []
let active = 0
const failure = reactive<Record<string, string>>({})

const details = computed(() => selected.value?.id ? detailCache[selected.value.id] : undefined)
const sorted = computed(() => [...props.results].sort((a, b) => {
  if (sort.value === 'date') return (Date.parse(b.published || '') || 0) - (Date.parse(a.published || '') || 0)
  if (sort.value === 'size') return a.size - b.size
  if (sort.value === 'title') return a.displayTitle.localeCompare(b.displayTitle, formatLocale.value)
  return (b.seeders ?? -1) - (a.seeders ?? -1)
}))
function cover(result: SearchResult) { return (result.id && detailCache[result.id]?.cover) || result.cover || undefined }
function number(value?: number) { return value === undefined ? '—' : value.toLocaleString(formatLocale.value) }
function bytes(value: number) {
  if (!value) return t('Не указан')
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'], index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4)
  return `${(value / 1024 ** index).toLocaleString(formatLocale.value, { maximumFractionDigits: index >= 3 ? 2 : 0 })} ${t(units[index])}`
}
function date(value?: string) { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(formatLocale.value) }
function close() { generation++; modal.value?.close(); selected.value = null; detailBusy.value = false }
function pump() {
  while (!stopped && props.visible && active < 2 && waiting.length) {
    const id = waiting.shift()!, job = requests.get(id)
    if (!job) continue
    active++
    job.started = true
    void $fetch<SearchDetails>(`/api/search/${id}/details`, { signal: job.controller.signal, query: job.allowBrowser ? { browser: '1' } : undefined })
      .then(value => {
        if (job.controller.signal.aborted) return
        detailCache[id] = value
        if (job.allowBrowser && value.status === 'available') {
          // A verified page may have unlocked HTTP for the other visible cards.
          for (const key of Object.keys(detailCache)) if (detailCache[key]?.status === 'unavailable') delete detailCache[key]
          for (const key of Object.keys(failure)) delete failure[key]
          void observeCards()
        }
      })
      .catch((error: any) => {
        if (!job.controller.signal.aborted) failure[id] = error?.data?.message || 'Не удалось получить описание из источника. Данные поиска сохранены; страницу раздачи можно открыть отдельно.'
      }).finally(() => { active--; if (requests.get(id) === job) requests.delete(id); job.done(); pump() })
  }
}
function preload(result: SearchResult, priority = false, allowBrowser = false): Promise<void> {
  if (!result.id || !result.sourcePage || stopped || !props.visible) return Promise.resolve()
  if (detailCache[result.id]?.status === 'available' || (!allowBrowser && (detailCache[result.id] || failure[result.id]))) return Promise.resolve()
  let job = requests.get(result.id)
  if (job && allowBrowser && !job.allowBrowser) {
    if (job.started) return job.promise.then(() => job.controller.signal.aborted ? undefined : preload(result, true, true))
    job.allowBrowser = true
  }
  if (!job) {
    if (allowBrowser) { delete detailCache[result.id]; delete failure[result.id] }
    let done!: () => void
    const promise = new Promise<void>(resolve => { done = resolve })
    job = { result, promise, done, controller: new AbortController(), allowBrowser, started: false }
    requests.set(result.id, job); waiting.push(result.id)
  }
  if (priority) { const index = waiting.indexOf(result.id); if (index >= 0) waiting.unshift(...waiting.splice(index, 1)) }
  pump()
  return job.promise
}
async function open(result: SearchResult) {
  const id = ++generation
  selected.value = result; detailMessage.value = ''; detailBusy.value = details.value?.status !== 'available' && !!result.sourcePage
  await nextTick(); if (id !== generation) return
  if (!modal.value?.open) modal.value?.showModal()
  await preload(result, true, true)
  if (id === generation) { detailBusy.value = false; detailMessage.value = (result.id && failure[result.id]) || '' }
}
function retry() {
  if (selected.value?.id) { delete detailCache[selected.value.id]; delete failure[selected.value.id] }
  if (selected.value) void open(selected.value)
}
async function observeCards() {
  await nextTick()
  observer?.disconnect()
  if (!props.visible || stopped) return
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const id = (entry.target as HTMLElement).dataset.resultId
      const result = props.results.find(result => result.id === id)
      if (result) void preload(result)
      observer?.unobserve(entry.target)
    }
  }, { rootMargin: '120px 0px' })
  for (const element of grid.value?.querySelectorAll('[data-result-id]') || []) observer.observe(element)
}
function cancelPreload() {
  observer?.disconnect()
  for (const id of waiting.splice(0)) { const job = requests.get(id); job?.done(); requests.delete(id) }
  for (const [id, job] of requests) { job.controller.abort(); job.done(); requests.delete(id) }
}
watch(() => props.visible, value => { if (!value) { close(); cancelPreload() } else void observeCards() })
watch(sorted, () => {
  if (selected.value && !props.results.some(result => result.id === selected.value?.id)) close()
  if (!props.results.length) {
    cancelPreload()
    for (const id of Object.keys(detailCache)) delete detailCache[id]
    for (const id of Object.keys(failure)) delete failure[id]
  }
  void observeCards()
})
onMounted(() => { void observeCards() })
onBeforeUnmount(() => { stopped = true; cancelPreload(); generation++ })
</script>

<template>
  <div class="search-catalog" :aria-busy="busy">
    <div v-if="results.length" class="catalog-toolbar">
      <p>{{ t('Результаты поиска') }} <span>{{ results.length }}<template v-if="total !== undefined"> / {{ total }}</template></span></p>
      <label>{{ t('Сортировка') }} <select v-model="sort"><option value="date">{{ t('Сначала новые') }}</option><option value="seeders">{{ t('Сначала больше сидов') }}</option><option value="size">{{ t('Сначала меньше размер') }}</option><option value="title">{{ t('По названию') }}</option></select></label>
    </div>
    <p v-if="busy" class="catalog-note" role="status">{{ t('Ищем раздачи в источнике…') }}</p>
    <p v-else-if="searched && !results.length" class="catalog-note">{{ t('По запросу ничего не найдено') }}</p>
    <p v-else-if="!results.length" class="catalog-note">{{ t('Найдите игру и откройте карточку, чтобы посмотреть состав раздачи.') }}</p>
    <div ref="grid" class="result-grid">
      <button v-for="result in sorted" :key="result.id || result.source" :data-result-id="result.id" type="button" class="result-card" @mouseenter="preload(result, true)" @focus="preload(result, true)" :disabled="busy" @click="open(result)">
        <div class="result-art"><SearchCover :cover="cover(result)" :title="result.displayTitle" /><div class="cover-badges"><span v-if="result.platform">{{ result.platform }}</span><span v-if="result.backport" class="backport">Backport</span></div><span class="open-hint">{{ t('Подробнее') }} ↗</span></div>
        <div class="result-info"><h3>{{ result.displayTitle }}</h3><p class="release-tags"><span v-if="result.version">v{{ result.version }}</span><span v-if="result.region">{{ result.region }}</span><span v-if="result.languages.length">{{ result.languages.map(label => t(label)).join(' / ') }}</span></p><div class="result-stats"><strong>{{ bytes(result.size) }}</strong><span class="seeds" :class="{ none: result.seeders === 0 }">↑ {{ number(result.seeders) }} {{ t('сидов') }}</span></div><div class="result-origin"><span>{{ result.indexer || 'Torznab' }}</span><time>{{ date(result.published) }}</time></div></div>
      </button>
    </div>
    <div v-if="hasMore" class="more-results"><button type="button" :disabled="busy || loadingMore" @click="emit('loadMore')">{{ t(loadingMore ? 'Загружаем ещё…' : 'Показать ещё') }}</button><p>{{ t('Сортировка применяется ко всем загруженным результатам.') }}</p></div>
  </div>

  <dialog ref="modal" class="release-dialog" aria-labelledby="release-title" @cancel.prevent="close" @click="($event.target === modal) && close()">
    <template v-if="selected">
      <div class="dialog-heading"><div><p>{{ selected.indexer || 'Torznab' }} <span v-if="selected.platform"> / {{ selected.platform }}</span></p><h2 id="release-title">{{ selected.displayTitle }}</h2></div><button type="button" class="close" :aria-label="t('Закрыть')" autofocus @click="close">×</button></div>
      <div class="release-layout">
        <aside class="release-cover"><SearchCover :cover="cover(selected)" :title="selected.displayTitle" /><a v-if="selected.sourcePage" :href="selected.sourcePage" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">{{ t('Открыть страницу раздачи') }} ↗</a></aside>
        <div class="release-main" tabindex="0" role="region" aria-labelledby="release-title">
          <div class="release-badges"><span v-if="selected.platform">{{ selected.platform }}</span><span v-if="selected.region">{{ selected.region }}</span><span v-if="selected.version">{{ t('Версия') }} {{ selected.version }}</span><span v-for="language in selected.languages" :key="language">{{ t(language) }}</span><span v-if="selected.backport" class="backport">Backport</span></div>
          <div class="release-metrics"><div><span>{{ t('Размер раздачи') }}</span><strong>{{ bytes(selected.size) }}</strong></div><div><span>{{ t('Сиды') }}</span><strong class="seeds">{{ number(selected.seeders) }}</strong></div><div><span>{{ t('Личеры') }}</span><strong>{{ number(selected.leechers) }}</strong></div><div><span>{{ t('Скачиваний') }}</span><strong>{{ number(selected.grabs) }}</strong></div></div>
          <dl class="release-meta"><dt>{{ t('Дата публикации') }}</dt><dd>{{ date(selected.published) }}</dd><template v-if="selected.peers !== undefined"><dt>{{ t('Участники раздачи') }}</dt><dd>{{ number(selected.peers) }}</dd></template><template v-if="selected.titleId"><dt>{{ t('Код диска') }}</dt><dd>{{ selected.titleId }}</dd></template><template v-if="selected.firmwareVersions.length"><dt>{{ t('Прошивки из названия') }}</dt><dd>{{ selected.firmwareVersions.join(' / ') }}</dd></template></dl>
          <p v-if="selected.backport || selected.version || selected.languages.length" class="metadata-note">{{ t('Метки версии, языка и Backport взяты из названия раздачи; совместимость PKG проверяется перед установкой.') }}</p>
          <div v-if="detailBusy" class="source-message" role="status"><i class="spinner" />{{ t('Загружаем описание и обложку из источника…') }}</div>
          <div v-if="detailMessage || details?.message" class="source-message" role="status"><span>{{ t(detailMessage || details?.message) }}</span><button v-if="selected.sourcePage && !detailBusy" type="button" @click="retry">{{ t('Повторить') }}</button></div>
          <section v-if="details?.description || selected.description" class="source-description"><h3>{{ t('Описание и сведения автора') }}</h3><p>{{ details?.description || selected.description }}</p></section>
          <details v-if="details?.fields.length" class="release-original" open><summary>{{ t('Сведения о релизе') }}</summary><dl class="release-meta"><template v-for="field in details?.fields || []" :key="field.label"><dt>{{ t(field.label) }}</dt><dd>{{ field.value }}</dd></template></dl></details>
          <details class="release-original"><summary>{{ t('Полное название раздачи') }}</summary><p>{{ selected.title }}</p><p v-if="selected.categories.length">{{ t('Категории источника') }}: {{ selected.categories.join(', ') }}</p></details>
        </div>
      </div>
      <div class="release-actions"><p role="status">{{ t(message || (ready ? 'Загрузка на WEB через qBittorrent. Установку на PS4 выполняет PackageFlowService.' : 'Для скачивания подключите qBittorrent в разделе «Загрузки».')) }}</p><div><button type="button" :disabled="!ready || !!pending" @click="emit('download', selected, false)">{{ t(pending === selected.source ? 'Добавляем…' : 'Скачать') }}</button><button type="button" class="primary" :disabled="!ready || !!pending" @click="emit('download', selected, true)">{{ t('Скачать и установить') }}</button></div></div>
    </template>
  </dialog>
</template>

<style scoped>
:global(html:has(.release-dialog[open])){overflow:hidden}
.search-catalog{padding:8px 20px 24px}.catalog-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}.catalog-toolbar p{margin:0;font-size:13px;font-weight:600;color:#dedbe7}.catalog-toolbar p span{margin-left:8px;padding:3px 8px;border-radius:5px;background:#383048;color:#c6b4ff}.catalog-toolbar label{display:flex;align-items:center;gap:10px;font-size:11px;color:#9a96a5}.catalog-toolbar select{border:1px solid #3d364b;background:#24212d;color:#d8d1e7;border-radius:6px;padding:8px;font-size:11px}.catalog-note{padding:12px 0;color:#9b96a9;font-size:12px;line-height:1.7}.result-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(195px,1fr));gap:16px}.result-card{text-align:left;padding:7px;background:#202028;border:1px solid #33303c;border-radius:15px;color:#ece9f3;cursor:pointer;min-width:0;transition:border-color .16s,transform .16s,background .16s}.result-card:hover,.result-card:focus-visible{border-color:#9680e7;background:#272232;transform:translateY(-3px);outline:2px solid #9680e733;outline-offset:2px}.result-card:disabled{opacity:.55;cursor:wait;transform:none}.result-art{position:relative}.cover-badges{position:absolute;top:10px;left:10px;right:10px;display:flex;justify-content:space-between;gap:6px}.cover-badges span,.release-badges span{font-size:10px;padding:5px 8px;border:1px solid #8e77e657;border-radius:6px;background:#1b182bea;color:#d6c9ff;letter-spacing:.03em}.cover-badges .backport,.release-badges .backport{color:#9ed4ed;border-color:#598fbd66;background:#152536ed}.open-hint{position:absolute;bottom:12px;right:12px;padding:6px 10px;border-radius:6px;background:#15121dde;color:#eee5ff;font-size:11px;opacity:0;transition:opacity .16s}.result-card:hover .open-hint,.result-card:focus-visible .open-hint{opacity:1}.result-info{padding:13px 8px 6px}.result-info h3{font-size:14px;line-height:1.5;margin:0 0 8px;min-height:42px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.release-tags{display:flex;gap:6px;flex-wrap:wrap;margin:0;min-height:32px;font-size:10px;color:#aba3bf}.release-tags span+span::before{content:'·';padding-right:6px;color:#6d617f}.result-stats,.result-origin{display:flex;align-items:center;justify-content:space-between;gap:8px}.result-stats{font-size:11px;margin:10px 0 13px}.result-stats strong{font-weight:500}.seeds{color:#85d9ab}.seeds.none{color:#dd9a8b}.result-origin{padding-top:11px;border-top:1px solid #38333f;font-size:10px;color:#928a9f}.result-origin span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.result-origin time{flex:none}
.more-results{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:24px}.more-results button{padding:11px 30px;border:1px solid #8870c1;border-radius:8px;background:#6446a4;color:#f5edff;font-size:13px;cursor:pointer}.more-results button:disabled{opacity:.5;cursor:wait}.more-results p{font-size:11px;color:#9a91ab;margin:0}.release-dialog{width:min(1040px,calc(100vw - 48px));max-height:90vh;max-height:90dvh;box-sizing:border-box;overflow:hidden;color-scheme:dark;padding:0;border:1px solid #5b4b78;border-radius:18px;background:#1b1923;color:#ede9f8;box-shadow:0 24px 100px #0008}.release-dialog[open]{display:flex;flex-direction:column}.release-dialog::backdrop{background:#07050cbe;backdrop-filter:blur(5px)}.dialog-heading{flex:none;display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:24px 28px;border-bottom:1px solid #38303f}.dialog-heading p{margin:0 0 8px;font-size:11px;color:#b69fe4;letter-spacing:.06em}.dialog-heading h2{margin:0;font-size:25px;font-weight:650;line-height:1.35;overflow-wrap:anywhere}.close{width:34px;height:34px;flex:none;padding:0;border:1px solid #564769;border-radius:8px;color:#d9c8f2;background:#302639;font-size:24px;cursor:pointer}.release-layout{flex:1;min-height:0;overflow:hidden;display:grid;grid-template-columns:230px minmax(0,1fr);grid-template-rows:minmax(0,1fr);gap:28px;padding:26px 28px}.release-cover{align-self:start}.release-cover :deep(.artwork){max-height:calc(90dvh - 280px)}.release-main{min-width:0;min-height:0;overflow-y:auto;padding-right:12px;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:#786397 transparent}.release-main:focus-visible{outline:1px solid #9680e7;outline-offset:4px;border-radius:4px}.release-main::-webkit-scrollbar,.release-layout::-webkit-scrollbar{width:6px}.release-main::-webkit-scrollbar-thumb,.release-layout::-webkit-scrollbar-thumb{background:#786397;border-radius:6px}.release-main::-webkit-scrollbar-track,.release-layout::-webkit-scrollbar-track{background:transparent}.release-cover a{display:block;margin-top:14px;font-size:12px;color:#bc9dfa;line-height:1.5;text-decoration:none}.release-cover a:hover{text-decoration:underline}.release-badges{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:18px}.release-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.release-metrics>div{padding:13px 12px;border:1px solid #3a3147;border-radius:9px;background:#25202f}.release-metrics span{display:block;margin-bottom:8px;font-size:10px;color:#a298b3}.release-metrics strong{font-size:15px;white-space:nowrap}.release-meta{display:grid;grid-template-columns:minmax(100px,38%) minmax(0,1fr);gap:10px 16px;font-size:12px;line-height:1.65;margin:22px 0}.release-meta dt{color:#9c91ab}.release-meta dd{margin:0;color:#e0d6ec;overflow-wrap:anywhere}.metadata-note{font-size:10px;color:#90859e;line-height:1.7}.source-message{display:flex;align-items:center;gap:9px;padding:12px 14px;border:1px solid #49405d;border-radius:8px;color:#b9a8d5;background:#2a2336;font-size:12px;line-height:1.7}.source-message button{flex:none;padding:6px 10px;border:1px solid #6b5488;border-radius:6px;background:#3b2d4d;color:#e5d5fa;font-size:11px;cursor:pointer}.spinner{width:14px;height:14px;flex:none;border:2px solid #6f5a92;border-top-color:#d6c0fa;border-radius:50%;animation:spin 1s linear infinite}.source-description h3{font-size:14px;color:#ece2f8;margin:25px 0 12px}.source-description p{font-size:12px;line-height:1.85;white-space:pre-line;color:#bfb6ce;overflow-wrap:anywhere}.release-original{margin-top:22px;padding-top:16px;border-top:1px solid #38313f;color:#998da9;font-size:11px}.release-original summary{cursor:pointer;color:#b39dcf}.release-original p{line-height:1.7;overflow-wrap:anywhere}.release-actions{flex:none;display:flex;align-items:center;justify-content:space-between;gap:22px;padding:18px 28px;border-top:1px solid #44344e;background:#211a2bf5;backdrop-filter:blur(10px)}.release-actions p{font-size:10px;line-height:1.7;color:#a79ab8;max-width:350px;margin:0}.release-actions>div{display:flex;gap:10px;flex:none}.release-actions button{padding:11px 18px;border:1px solid #685381;border-radius:8px;background:#30283d;color:#dfd1f1;font-size:12px;cursor:pointer}.release-actions .primary{background:#795bc3;border-color:#9b7ddf;color:white}.release-actions button:disabled{opacity:.45;cursor:not-allowed}.release-actions button:focus-visible,.close:focus-visible{outline:2px solid #c9aaff;outline-offset:3px}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:700px){.catalog-toolbar{align-items:flex-start;flex-direction:column}.result-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.search-catalog{padding:8px 12px 20px}.more-results{display:flex;flex-direction:column;align-items:center;gap:8px;margin-top:24px}.more-results button{padding:11px 30px;border:1px solid #8870c1;border-radius:8px;background:#6446a4;color:#f5edff;font-size:13px;cursor:pointer}.more-results button:disabled{opacity:.5;cursor:wait}.more-results p{font-size:11px;color:#9a91ab;margin:0}.release-dialog{width:calc(100vw - 24px);max-height:94vh;max-height:94dvh}.dialog-heading{padding:18px}.dialog-heading h2{font-size:20px}.release-layout{grid-template-columns:1fr;grid-template-rows:auto auto;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#786397 transparent;padding:18px;gap:20px}.release-main{overflow:visible;padding-right:0;scrollbar-gutter:auto}.release-cover :deep(.artwork){max-height:none}.release-cover{display:grid;grid-template-columns:140px 1fr;align-items:center;gap:18px}.release-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.release-actions{position:static;flex-direction:column;align-items:stretch;padding:18px}.release-actions>div{flex-wrap:wrap}.release-actions button{flex:1}.release-info h3{font-size:12px}}@media(prefers-reduced-motion:reduce){.result-card,.open-hint{transition:none}.result-card:hover,.result-card:focus-visible{transform:none}.spinner{animation:none}}
</style>

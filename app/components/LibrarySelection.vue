<script setup lang="ts">
interface SelectedPackage {
  rowId: string; id: string; title: string; size: number; type?: string; platform?: string
  titleId?: string; fileName?: string; iconUrl?: string; iconSize?: number; groupIconId?: string
}
const props = defineProps<{ items: SelectedPackage[] }>()
const emit = defineEmits<{ close: []; remove: [id: string]; clear: []; install: [] }>()
const { t, formatLocale } = useAppLocale()
const dialog = ref<HTMLElement>(), closeButton = ref<HTMLButtonElement>()
const brokenCovers = reactive(new Set<string>())
const totalSize = computed(() => props.items.reduce((sum, item) => sum + item.size, 0))
let previousFocus: HTMLElement | null = null, previousOverflow = ''
function cover(item: SelectedPackage) {
  if (brokenCovers.has(item.rowId)) return undefined
  return item.iconUrl || (item.groupIconId || item.iconSize ? `/api/packages/${item.groupIconId || item.id}?asset=icon` : undefined)
}
function bytes(value: number) {
  if (!value) return t('0 Б')
  const index = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** index).toLocaleString(formatLocale.value, { maximumFractionDigits: 1 })} ${t(['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'][index])}`
}
function trapFocus(event: KeyboardEvent) {
  const buttons = [...(dialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
  const first = buttons[0], last = buttons.at(-1)
  if (!first) return
  if (!dialog.value?.contains(document.activeElement) || event.shiftKey && document.activeElement === first) {
    event.preventDefault(); (event.shiftKey ? last : first)?.focus()
  } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'
  closeButton.value?.focus()
})
watch(() => props.items.length, async () => {
  await nextTick()
  const active = document.activeElement
  if (!dialog.value?.contains(active) || active instanceof HTMLButtonElement && active.disabled) closeButton.value?.focus()
})
onBeforeUnmount(() => {
  document.body.style.overflow = previousOverflow
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})
</script>

<template>
  <div class="selection-overlay" @click.self="emit('close')" @keydown.esc.stop.prevent="emit('close')" @keydown.tab="trapFocus">
    <section ref="dialog" class="selection-dialog" role="dialog" aria-modal="true" aria-labelledby="library-selection-title" aria-describedby="library-selection-help">
      <header>
        <div><h2 id="library-selection-title">{{ t('Выбранные') }}</h2><p aria-live="polite">{{ t('Выбрано файлов:') }} {{ items.length }} <span aria-hidden="true">·</span> {{ bytes(totalSize) }}</p></div>
        <button ref="closeButton" class="close-button" type="button" :aria-label="t('Закрыть')" @click="emit('close')">×</button>
      </header>
      <p id="library-selection-help" class="selection-help">{{ t('Выбор сохраняется между поисками и страницами') }}</p>
      <div class="selection-scroll">
        <table v-if="items.length">
          <thead><tr><th scope="col">{{ t('Игра') }}</th><th scope="col" class="size-column">{{ t('Размер') }}</th><th scope="col" class="action-column"><span class="visually-hidden">{{ t('Действия') }}</span></th></tr></thead>
          <tbody><tr v-for="item in items" :key="item.rowId">
            <td><div class="selected-game"><div class="selected-cover"><img v-if="cover(item)" :src="cover(item)" alt="" loading="lazy" decoding="async" @error="brokenCovers.add(item.rowId)"><span v-else aria-hidden="true">{{ item.title.charAt(0) }}</span></div><div class="selected-name"><strong :title="item.fileName">{{ item.title }}</strong><small><span v-if="item.platform && item.platform !== 'unknown'">{{ item.platform.toUpperCase() }}</span><span v-if="item.type">{{ t(item.type) }}</span><span v-if="item.titleId">{{ item.titleId }}</span></small></div></div></td>
            <td class="size-column">{{ bytes(item.size) }}</td>
            <td class="action-column"><button class="remove-button" type="button" :aria-label="`${t('Убрать из выбора')}: ${item.title}`" :title="t('Убрать из выбора')" @click="emit('remove', item.rowId)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg></button></td>
          </tr></tbody>
        </table>
        <div v-else class="selection-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg><strong>{{ t('Пока ничего не выбрано') }}</strong><p>{{ t('Отмечайте игры в библиотеке, чтобы собрать набор для установки.') }}</p></div>
      </div>
      <footer><button class="clear-button" type="button" :disabled="!items.length" @click="emit('clear')">{{ t('Снять выбор') }}</button><div><button type="button" @click="emit('close')">{{ t('Продолжить выбор') }}</button><button class="primary" type="button" :disabled="!items.length" @click="emit('install')">{{ t('Установить выбранное') }}</button></div></footer>
    </section>
  </div>
</template>

<style scoped>
.selection-overlay{position:fixed;inset:0;z-index:45;display:grid;place-items:center;padding:24px;background:#020b1ac4;backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px)}
.selection-dialog{display:flex;flex-direction:column;width:min(800px,100%);max-height:calc(100dvh - 48px);min-height:0;border:1px solid #78bbff55;border-radius:20px;overflow:hidden;background:linear-gradient(140deg,#183c61e8,#081a32f5);box-shadow:0 30px 90px #0009,inset 0 1px 0 #e8f5ff18;color:var(--pf-text,#f3f7ff);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px)}
header,footer{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px 24px}header{border-bottom:1px solid var(--pf-line,#94baf438)}h2{font-size:23px;margin:0 0 7px}header p{margin:0;font-size:12px;color:var(--pf-muted,#acbfdc)}header p span{margin:0 8px}.selection-help{padding:12px 24px;margin:0;color:var(--pf-muted,#acbfdc);font-size:12px;line-height:1.5}
.selection-scroll{overflow:auto;min-height:0;overscroll-behavior:contain;padding:0 24px}table{width:100%;border-collapse:collapse;table-layout:fixed}th{text-align:left;position:sticky;top:0;z-index:1;background:#102b48;color:#9ebbdc;font-weight:500;font-size:11px}th,td{padding:12px 10px;border-bottom:1px solid #83b0e323}td{font-size:12px}.size-column{width:112px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.action-column{width:50px;text-align:right}tbody tr:hover{background:#77bbff09}.selected-game{display:flex;align-items:center;gap:13px;min-width:0}.selected-cover{width:44px;height:54px;flex-shrink:0;border:1px solid #a6cfff2c;border-radius:8px;overflow:hidden;background:#123658;display:grid;place-items:center;color:#83d6ff}.selected-cover img{width:100%;height:100%;object-fit:cover}.selected-name{min-width:0}.selected-name strong{display:block;font-size:13px;font-weight:600;line-height:1.5;overflow-wrap:anywhere}.selected-name small{display:flex;flex-wrap:wrap;gap:5px 9px;margin-top:5px;color:#99b3d3;font-size:10px}
button{font:inherit;font-size:12px;min-height:40px;padding:10px 14px;border:1px solid #83b7ec40;border-radius:10px;background:#173b5f99;color:inherit;cursor:pointer}button:hover{border-color:#74caff9c;background:#20517ba6}button:disabled{opacity:.4;cursor:default}button:focus-visible{outline:2px solid #70d5ff;outline-offset:3px}.close-button,.remove-button{display:inline-grid;place-items:center;min-width:36px;min-height:36px;width:36px;height:36px;padding:0}.close-button{font-size:23px}.remove-button{color:#b7cce6}.remove-button:hover{color:#ffd2dc;background:#bb34532b;border-color:#f0809977}.primary{background:linear-gradient(110deg,#05aee9,#4d67f6 65%,#865cf1);border-color:#99daff88;box-shadow:0 0 18px #1a7bec24}.primary:hover{background:linear-gradient(110deg,#19bbf3,#657afc 65%,#946ff5)}
footer{border-top:1px solid var(--pf-line,#94baf438);background:#091e36aa;flex-wrap:wrap}footer>div{display:flex;flex-wrap:wrap;gap:10px}.clear-button{background:transparent;color:#b1c2d9}.selection-empty{min-height:200px;display:flex;align-items:center;justify-content:center;flex-direction:column;text-align:center;gap:14px;color:#8ccaff;padding:24px}.selection-empty strong{color:#deedff;font-size:16px}.selection-empty p{color:#a4bbd9;font-size:12px;line-height:1.6;margin:0;max-width:360px}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
@media(max-width:600px){.selection-overlay{padding:12px}.selection-dialog{max-height:calc(100dvh - 24px);border-radius:15px}header,footer{padding:16px;gap:12px}h2{font-size:20px}.selection-help{padding:10px 16px}.selection-scroll{padding:0 8px}th,td{padding:10px 6px}.size-column{width:80px}.action-column{width:40px}.selected-game{gap:8px}.selected-cover{width:34px;height:44px}.selected-name strong{font-size:12px}.selected-name small{gap:4px 6px;font-size:9px}footer>div{flex:1;justify-content:flex-end}footer .primary{flex:1}footer>div>button{padding:10px;font-size:11px}.clear-button{font-size:11px;padding:8px}}
@media(prefers-reduced-transparency:reduce){.selection-overlay{backdrop-filter:none;-webkit-backdrop-filter:none}.selection-dialog{background:#102b48;backdrop-filter:none;-webkit-backdrop-filter:none}}
</style>

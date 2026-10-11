<script setup lang="ts">
import { gameDetails, type GameDetailsSource } from '#shared/game-details'
const props = defineProps<{ title: string; cover?: string; items?: GameDetailsSource[]; total?: number; installation?: string }>()
const { t, formatLocale } = useAppLocale()
const trigger = ref<HTMLElement>(), panel = ref<HTMLElement>(), tab = ref('overview')
const details = computed(() => gameDetails(props.items || []))
const position = ref<Record<string, string>>({})
const panelId = useId()
const { activePreview, keyboardPreview } = useGamePreview()
const opened = computed(() => activePreview.value === panelId)
let hideTimer: ReturnType<typeof setTimeout> | undefined
let dismissed = false
let pointer: { x: number; y: number } | undefined
function cancelHide() { if (hideTimer) clearTimeout(hideTimer); hideTimer = undefined }
function locate() {
  const r = trigger.value?.getBoundingClientRect()
  if (!r) return
  const anchor = !keyboardPreview.value && pointer ? pointer : { x: r.left + Math.min(r.width, 200), y: r.top }
  const available = window.innerWidth - anchor.x - 26
  // Stay to the right of the pointer; only the viewport edge can constrain it.
  const width = Math.min(410, window.innerWidth - 24, available >= 280 ? available : 410)
  const height = Math.min(590, window.innerHeight - 24)
  const left = Math.max(12, Math.min(anchor.x + 14, window.innerWidth - width - 12))
  const top = Math.max(12, Math.min(anchor.y, window.innerHeight - height - 12))
  position.value = { left: `${left}px`, top: `${top}px`, width: `${width}px`, maxHeight: `${height}px` }
}
function show(event: Event) {
  if (keyboardPreview.value && ['mouseenter', 'pointermove'].includes(event.type)) return
  if (event instanceof MouseEvent) pointer = { x: event.clientX, y: event.clientY }
  cancelHide(); if (!details.value || dismissed) return; locate(); activePreview.value = panelId
}
function hideLater() {
  cancelHide()
  hideTimer = setTimeout(() => {
    if (keyboardPreview.value && trigger.value?.contains(document.activeElement) || panel.value?.contains(document.activeElement)) return
    close()
  }, 180)
}
function close() { if (opened.value) activePreview.value = ''; cancelHide() }
function dismiss() {
  const returnFocus = panel.value?.contains(document.activeElement)
  close(); dismissed = true
  if (returnFocus) trigger.value?.querySelector<HTMLButtonElement>('button')?.focus()
}
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !opened.value) return
  dismiss()
}
function leave() { dismissed = false; hideLater() }
function blur() { dismissed = false; hideLater() }
const bytes = (n: number) => `${(n / (n >= 1073741824 ? 1073741824 : 1048576)).toLocaleString(formatLocale.value, { maximumFractionDigits: 2 })} ${t(n >= 1073741824 ? 'ГБ' : 'МБ')}`
const signature = computed(() => ({ fake: 'Fake (FPKG)', retail: 'Retail', unknown: t('Подпись неизвестна') }[details.value?.signature || 'unknown']))
const rows = computed(() => details.value ? [
  ['Title ID', details.value.titleId], ['Content ID', details.value.contentId],
  [t('Версия'), details.value.version], [t('Исходная версия'), details.value.masterVersion],
  [t('Категория'), details.value.category], [t('Требуемая прошивка'), details.value.firmware],
  [t('Версия SDK'), details.value.sdk], [t('Файл'), details.value.fileName],
  [t(details.value.hasBase ? 'Размер базового пакета' : 'Размер пакета'), bytes(details.value.size)],
] : [])
watch(() => props.title, () => { close(); tab.value = 'overview' })
function scroll(event: Event) { if (!panel.value?.contains(event.target as Node)) close() }
// Scrolling the preview itself should not dismiss a long list of packages.
onMounted(() => { window.addEventListener('keydown', escape); window.addEventListener('resize', close); window.addEventListener('scroll', scroll, true) })
onBeforeUnmount(() => { close(); window.removeEventListener('keydown', escape); window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true) })
</script>

<template>
  <div ref="trigger" class="pf-game-preview" :aria-controls="opened ? panelId : undefined" @mouseenter="show" @pointermove="show" @mouseleave="leave" @focusin="show" @focusout="blur" @keydown="show">
    <slot />
    <Teleport to="body">
      <aside v-if="opened && details" :id="panelId" ref="panel" class="pf-game-details" :style="position" role="dialog" tabindex="0" @wheel.stop :aria-label="`${t('Сведения об игре')}: ${title}`" @mouseenter="cancelHide" @mouseleave="hideLater" @focusin="cancelHide" @focusout="hideLater">
        <button class="pf-preview-close" :aria-label="t('Закрыть')" @click="dismiss">×</button>
        <header class="pf-preview-header">
          <img v-if="cover" :src="cover" alt="" decoding="async"><div v-else class="pf-preview-placeholder">{{ title.charAt(0) }}</div>
          <div><strong>{{ title }}</strong><div class="pf-preview-tags"><span>{{ details.platform.toUpperCase() }}</span><span>{{ t(details.hasBase ? 'Игра' : 'Пакет') }}</span><span>{{ details.format.toUpperCase() }}</span><span>{{ signature }}</span></div>
            <p>{{ t('Размер пакета') }}: {{ bytes(details.size) }}</p><small>{{ installation || t('Статус установки неизвестен') }}</small>
          </div>
        </header>
        <nav class="pf-preview-tabs" :aria-label="t('Сведения об игре')"><button :aria-pressed="tab === 'overview'" @click="tab = 'overview'">{{ t('Обзор') }}</button><button :aria-pressed="tab === 'packages'" @click="tab = 'packages'">{{ t('Пакеты') }} · {{ total || items?.length }}</button></nav>
        <template v-if="tab === 'overview'">
          <p v-if="!details.hasBase" class="pf-preview-note">{{ t('Нет базовой игры. Сведения относятся к первому пакету.') }}</p>
          <dl><template v-for="[label, value] in rows" :key="label"><dt>{{ label }}</dt><dd>{{ value || '—' }}</dd></template></dl>
          <p class="pf-preview-note">{{ t('Требуемая прошивка указана в файле и не гарантирует запуск игры.') }}</p>
        </template>
        <div v-else class="pf-preview-packages"><article v-for="item in items" :key="item.id"><strong>{{ t(item.type) }} <span>{{ item.appVersion }}</span></strong><p>{{ item.fileName }}</p><small>{{ (item.format || '').toUpperCase() }} · {{ bytes(item.size) }}</small></article><p v-if="total && total > (items?.length || 0)" class="pf-preview-note">{{ t('Показаны пакеты текущей страницы') }}: {{ items?.length }} / {{ total }}</p></div>
      </aside>
    </Teleport>
  </div>
</template>

<style scoped>
.pf-game-preview{display:inline-flex;width:fit-content;max-width:100%;vertical-align:middle;align-items:center;gap:9px;min-width:0}.pf-game-details{position:fixed;z-index:100;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#68768b #222c38;background:#171c23;color:#e9edf3;border:1px solid #394553;border-radius:10px;padding:16px;box-shadow:0 12px 40px #0009;font:12px system-ui,sans-serif}.pf-preview-close{position:absolute;right:7px;top:5px;background:transparent;border:0;color:#a9b7c8;font-size:22px;cursor:pointer}.pf-preview-header{display:flex;gap:12px;margin:9px 0 16px}.pf-preview-header img,.pf-preview-placeholder{width:100px;height:125px;object-fit:cover;border-radius:7px;flex-shrink:0}.pf-preview-placeholder{display:grid;place-items:center;background:#293447;font-size:38px}.pf-preview-header strong{display:block;margin-right:10px;font-size:14px;line-height:1.3}.pf-preview-header p{margin:8px 0}.pf-preview-header small{color:#aebecd;line-height:1.4}.pf-preview-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}.pf-preview-tags span{padding:2px 5px;border-radius:3px;background:#293747;color:#b4d0ef;font-size:10px}.pf-preview-tabs{display:flex;gap:14px;border-bottom:1px solid #293541;margin-bottom:14px}.pf-preview-tabs button{padding:8px 0;background:transparent;border:0;border-bottom:2px solid transparent;color:#98a8bb;cursor:pointer;font:inherit}.pf-preview-tabs button[aria-pressed=true]{color:#e9edf3;border-bottom-color:#679ce4}.pf-game-details dl{display:grid;grid-template-columns:120px minmax(0,1fr);gap:9px;font-size:11px}.pf-game-details dt{color:#9cabbd}.pf-game-details dd{margin:0;overflow-wrap:anywhere;font-family:monospace}.pf-preview-note{color:#93a3b7;font-size:11px;line-height:1.5}.pf-preview-packages article{padding:10px 0;border-bottom:1px solid #293541}.pf-preview-packages p{overflow-wrap:anywhere;margin:6px 0;font:11px monospace}.pf-preview-packages small{color:#9cabbd}.pf-game-details button:focus-visible{outline:2px solid #98baff;outline-offset:3px}
</style>

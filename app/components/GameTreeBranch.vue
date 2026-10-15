<script setup lang="ts">
import type { GameDetailsSource } from '#shared/game-details';
import { contentFormat, contentPlatform } from '#shared/content-platform';
const { t } = useAppLocale();
const props = defineProps<{
  title: string;
  titleId: string;
  cover?: string;
  count: number;
  total?: number;
  open: boolean;
  packages?: GameDetailsSource[];
  installation?: string;
}>();
const formats = computed(() => [...new Set((props.packages || []).map(contentFormat))]);
const platform = computed(() =>
  props.packages?.length
    ? contentPlatform(props.packages[0]!)
    : /^PPSA/.test(props.titleId)
      ? 'ps5'
      : /^CUSA/.test(props.titleId)
        ? 'ps4'
        : 'unknown',
);
const firmwares = computed(() =>
  [...new Set((props.packages || []).map((item) => item.requiredFirmware).filter(Boolean))].sort(
    (a, b) => a!.localeCompare(b!, undefined, { numeric: true }),
  ),
);
const emit = defineEmits<{ toggle: [] }>();
</script>
<template>
  <article class="pf-game-branch">
    <div class="pf-game-head">
      <button
        class="pf-expand"
        :aria-expanded="open"
        :aria-label="t(`Пакеты: ${title}`)"
        @click="emit('toggle')"
      >
        <span :class="{ open }">›</span>
      </button>
      <div class="pf-game-cover">
        <img v-if="cover" :src="cover" alt="" loading="lazy" decoding="async" /><span v-else>{{
          title.charAt(0)
        }}</span>
      </div>
      <div class="pf-game-name-area">
        <div class="pf-game-title-line">
          <GameDetailsPopover
            :title="title"
            :cover="cover"
            :items="packages"
            :total="total"
            :installation="installation"
            ><button class="pf-game-name" @click="emit('toggle')">
              <strong>{{ title }}</strong>
            </button></GameDetailsPopover
          >
        </div>
        <div class="pf-game-tags">
          <ContentTags :platform="platform" :formats="formats" /><span
            v-for="fw in firmwares"
            :key="fw"
            class="pf-firmware-tag"
            :title="t('Требуемая прошивка из PARAM')"
            >FW {{ fw }}</span
          >
        </div>
        <slot name="summary" />
      </div>
      <div class="pf-group-actions"><slot name="actions" /></div>
    </div>
    <div v-if="open" class="pf-package-list"><slot /></div>
  </article>
</template>
<style scoped>
.pf-game-branch {
  border-bottom: 1px solid #29282e;
}
.pf-game-head {
  display: grid;
  grid-template-columns: 26px 32px minmax(180px, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 7px 12px;
  background: #1e1d22;
}
.pf-expand {
  width: 26px;
  height: 26px;
  padding: 0;
  color: #aaa3cf;
  border: 0;
  background: transparent;
  font-size: 22px;
}
.pf-expand span {
  display: inline-block;
  transform: rotate(0deg);
}
.pf-expand .open {
  transform: rotate(90deg);
}
.pf-game-cover {
  flex: 0 0 32px;
  width: 32px;
  height: 40px;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: #35343c;
  border-radius: 5px;
  color: #eeeafe;
  font:
    700 19px Georgia,
    serif;
}
.pf-game-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pf-game-name {
  min-width: 0;
  padding: 0;
  text-align: left;
  border: 0;
  color: inherit;
  background: transparent;
}
.pf-game-name strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.pf-firmware-tag {
  padding: 2px 5px;
  border-radius: 4px;
  color: #b4c9f5;
  background: #37517c38;
  font:
    10px 'DM Mono',
    monospace;
}
.pf-group-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  white-space: nowrap;
}
.pf-package-list {
  background: #19191c;
}
/* The library's notification typography is shared by every game tree. */
.pf-game-name-area :deep(.group-current),
.pf-game-name-area :deep(.group-pending),
.pf-game-name-area :deep(.group-skipped) {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  font:
    10px 'DM Mono',
    monospace;
}
.pf-game-name-area :deep(.group-current) {
  color: #b9aafa;
  font-weight: 700;
}
.pf-game-name-area :deep(.group-pending) {
  color: #a5a2ae;
}
.pf-game-name-area :deep(.group-skipped) {
  color: #e3bd77;
}
</style>

<style scoped>
.pf-game-name-area {
  min-width: 0;
}
.pf-game-title-line {
  min-width: 0;
}
.pf-game-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.pf-firmware-tag {
  flex-shrink: 0;
}
.pf-game-title-line :deep(.pf-game-preview) {
  max-width: 100%;
}
.pf-game-name {
  max-width: 100%;
}
.pf-game-tags :deep(.pf-content-tags) {
  flex-shrink: 0;
}
</style>

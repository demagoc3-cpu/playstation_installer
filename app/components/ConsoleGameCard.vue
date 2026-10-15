<script setup lang="ts">
const props = defineProps<{
  title: string;
  titleId: string;
  platform: 'ps4' | 'ps5';
  cover?: string;
  version?: string;
  format?: string;
  sizeBytes?: number;
  status?: string;
  selected?: boolean;
}>();
const emit = defineEmits<{ details: []; imageError: [] }>(),
  { t, formatLocale } = useAppLocale();
const failed = ref(false);
watch(
  () => props.cover,
  () => (failed.value = false),
);
const size = computed(() =>
  props.sizeBytes !== undefined
    ? `${(props.sizeBytes / 1024 ** 3).toLocaleString(formatLocale.value, { maximumFractionDigits: 2 })} ${t('ГБ')}`
    : '',
);
</script>
<template>
  <div class="pf-console-card" :class="{ 'is-selected': selected }">
    <button
      class="pf-console-cover"
      :aria-label="`${t('Сведения')}: ${title}`"
      :aria-expanded="selected"
      @click="emit('details')"
    >
      <img
        v-if="cover && !failed"
        :src="cover"
        alt=""
        loading="lazy"
        @error="
          failed = true;
          emit('imageError');
        "
      /><span v-else class="pf-console-monogram">{{ title.slice(0, 1) }}</span
      ><span class="pf-console-platform" :class="platform">{{ platform.toUpperCase() }}</span>
    </button>
    <div class="pf-console-card-body">
      <button class="pf-console-title" @click="emit('details')">{{ title }}</button>
      <div class="pf-console-tags">
        <span>{{ titleId }}</span
        ><span v-if="format" class="pf-console-format">{{ format }}</span
        ><span v-if="size">{{ size }}</span>
      </div>
      <small v-if="version">{{ version }}</small>
      <p class="pf-console-status">{{ status || t('Состояние запуска неизвестно') }}</p>
      <div class="pf-console-actions"><slot /></div>
    </div>
  </div>
</template>
<style scoped>
.pf-console-card {
  height: 100%;
  background: linear-gradient(150deg, #23202d, #19171f);
  border: 1px solid #3f354c;
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition:
    border-color 0.18s,
    box-shadow 0.18s;
}
.pf-console-card:hover,
.pf-console-card.is-selected {
  border-color: #a47fe2;
  box-shadow: 0 6px 24px #140e2360;
}
.pf-console-cover {
  display: block;
  position: relative;
  border: 0;
  padding: 0;
  background: #2e263d;
  aspect-ratio: 1;
  width: 100%;
  cursor: pointer;
}
.pf-console-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.pf-console-monogram {
  display: grid;
  place-items: center;
  height: 100%;
  font-size: 4rem;
  color: #c4a4f2;
  background: radial-gradient(ellipse at top right, #53407a, #201a2b);
}
.pf-console-platform {
  position: absolute;
  top: 10px;
  left: 10px;
  font-size: 11px;
  font-weight: 700;
  padding: 4px 7px;
  border-radius: 6px;
  background: #202d49e8;
  color: #96c2ff;
  border: 1px solid #6295d85c;
}
.pf-console-platform.ps5 {
  background: #3c2757ed;
  color: #d0a8ff;
  border-color: #a976e76b;
}
.pf-console-card-body {
  padding: 13px;
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 8px;
}
.pf-console-title {
  text-align: left;
  color: #f1edf7;
  font-size: 14px;
  line-height: 1.45;
  font-weight: 650;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 41px;
}
.pf-console-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  color: #aaa0b9;
  font-size: 11px;
}
.pf-console-format {
  padding: 2px 5px;
  background: #383048;
  border-radius: 4px;
  color: #d1b6ee;
}
.pf-console-card-body small {
  color: #a79cb6;
  font-size: 11px;
}
.pf-console-status {
  margin: 0;
  color: #aca1ba;
  font-size: 11px;
  line-height: 1.5;
  flex: 1;
}
.pf-console-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.pf-console-actions :deep(button) {
  font: inherit;
  font-size: 12px;
  padding: 8px 10px;
  border: 1px solid #594569;
  border-radius: 8px;
  background: #332a40;
  color: #ded1ec;
  cursor: pointer;
  flex: 1;
}
.pf-console-actions :deep(button.primary) {
  background: linear-gradient(125deg, #9970d8, #7861cb);
  border-color: #ad87e2;
  color: white;
}
.pf-console-actions :deep(button.danger) {
  border-color: #694151;
  color: #ecb2c5;
  background: #372330;
}
.pf-console-actions :deep(button:disabled) {
  opacity: 0.45;
  cursor: default;
}
.pf-console-card :is(button):focus-visible {
  outline: 2px solid #be9bef;
  outline-offset: -3px;
}
</style>

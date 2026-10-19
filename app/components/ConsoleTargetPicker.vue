<script setup lang="ts">
import type { ConsoleProfiles } from '#shared/types/consoles';
const props = defineProps<{ profiles: ConsoleProfiles; pending?: boolean }>();
const emit = defineEmits<{ select: [id: string] }>();
const { t } = useAppLocale();
const current = computed(() =>
  props.profiles.consoles.find((item) => item.id === props.profiles.activeId),
);
</script>
<template>
  <div class="console-target">
    <label
      >{{ t('Управлять приставкой') }}
      <select
        :value="profiles.activeId || ''"
        :disabled="pending || !profiles.consoles.length"
        @change="emit('select', ($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!current" disabled value="">{{ t('Выберите приставку') }}</option>
        <option v-for="profile in profiles.consoles" :key="profile.id" :value="profile.id">
          {{ profile.name }} · {{ profile.platform.toUpperCase() }} · {{ profile.ip }}
        </option>
      </select>
    </label>
    <span v-if="current"
      >{{ current.model || current.platform.toUpperCase() }} ·
      {{ t(current.online ? 'В сети' : current.restMode ? 'В режиме покоя' : 'Нет связи') }}</span
    >
    <small>{{ t('Выбор общий для разделов «На консоли» и «Сохранения».') }}</small>
  </div>
</template>
<style scoped>
.console-target {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  padding: 14px 16px;
  margin-bottom: 24px;
  border: 1px solid #454052;
  border-radius: 10px;
  background: #201e26;
}
.console-target label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}
.console-target select {
  max-width: 100%;
  padding: 9px 12px;
  border: 1px solid #645575;
  border-radius: 7px;
  background: #29262f;
  color: #eee8f5;
}
.console-target span {
  font-size: 12px;
  color: #b9abc9;
}
.console-target small {
  flex-basis: 100%;
  color: #aaa3b4;
}
@media (max-width: 760px) {
  .console-target label {
    align-items: stretch;
    flex-direction: column;
    min-width: 0;
    width: 100%;
  }
}
</style>

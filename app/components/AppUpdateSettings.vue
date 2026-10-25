<script setup lang="ts">
interface UpdateState {
  installed: string | null;
  latest?: { version: string; url: string; publishedAt: string };
  available: boolean;
  checkedAt?: number;
  error?: string;
  autoCheck: boolean;
}
const { t, formatLocale } = useAppLocale();
const state = ref<UpdateState | null>(null),
  busy = ref(false),
  message = ref('');
onMounted(async () => {
  try {
    state.value = await $fetch<UpdateState>('/api/app-updates');
  } catch {
    message.value = 'Не удалось прочитать настройки обновлений';
  }
});
async function post(body: Record<string, unknown>, done: string, failed: string) {
  busy.value = true;
  message.value = '';
  try {
    state.value = await $fetch<UpdateState>('/api/app-updates', { method: 'POST', body });
    message.value = done;
  } catch {
    message.value = failed;
  } finally {
    busy.value = false;
  }
}
function save(event: Event) {
  const input = event.target as HTMLInputElement;
  void post(
    { autoCheck: input.checked },
    'Настройки обновлений сохранены',
    'Не удалось сохранить настройки обновлений',
  ).then(() => {
    input.checked = state.value?.autoCheck ?? input.checked;
  });
}
const checkNow = () => post({ action: 'check' }, '', 'Не удалось проверить обновления');
function openRelease(url: string) {
  window.open(url, '_blank', 'noopener');
}
const time = (value?: number) => (value ? new Date(value).toLocaleString(formatLocale.value) : '');
</script>
<template>
  <section class="settings-card glass-surface app-update-settings">
    <h2>{{ t('Обновления') }}</h2>
    <label
      ><input
        type="checkbox"
        :checked="state?.autoCheck ?? true"
        :disabled="!state || busy"
        @change="save"
      /><span>{{ t('Проверять обновления автоматически') }}</span></label
    >
    <p>
      {{
        t(
          'PackageFlow раз в 6 часов проверяет последний релиз на GitHub и показывает уведомление в колокольчике. Обновление само не скачивается и не устанавливается.',
        )
      }}
    </p>
    <p v-if="state">
      {{ t('Установлена версия') }}: {{ state.installed || t('неизвестна') }}
      <template v-if="state.latest">
        · {{ t('последняя на GitHub') }}: {{ state.latest.version }}</template
      >
      <template v-if="state.checkedAt">
        · {{ t('проверено') }} {{ time(state.checkedAt) }}</template
      >
    </p>
    <p v-if="state?.available" class="update-available">
      {{ t('Доступна новая версия PackageFlow') }} {{ state.latest?.version }}
    </p>
    <p v-else-if="state?.error" class="update-error">{{ t(state.error) }}</p>
    <div class="update-actions">
      <button class="secondary" :disabled="busy" @click="checkNow">
        {{ t(busy ? 'Проверяем…' : 'Проверить сейчас') }}</button
      ><button
        v-if="state?.available && state.latest"
        class="primary"
        @click="openRelease(state.latest.url)"
      >
        {{ t('Открыть релиз') }}
      </button>
    </div>
    <p v-if="message" role="status">{{ t(message) }}</p>
  </section>
</template>
<style scoped>
label {
  display: flex;
  align-items: center;
  gap: 12px;
}
.update-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.update-available {
  color: #8dddff;
}
.update-error {
  color: #ffadbd;
}
</style>

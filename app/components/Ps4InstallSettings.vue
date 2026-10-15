<script setup lang="ts">
const { t } = useAppLocale();
const enabled = ref(false),
  loaded = ref(false),
  busy = ref(false),
  message = ref('');
onMounted(async () => {
  try {
    const settings = await $fetch<{ verifyPkgBeforeSend: boolean }>('/api/ps4/install-settings');
    enabled.value = settings.verifyPkgBeforeSend;
    loaded.value = true;
  } catch {
    message.value = 'Не удалось прочитать настройки установки PS4';
  }
});
async function save(event: Event) {
  const value = (event.target as HTMLInputElement).checked;
  busy.value = true;
  message.value = '';
  try {
    const settings = await $fetch<{ verifyPkgBeforeSend: boolean }>('/api/ps4/install-settings', {
      method: 'POST',
      body: { verifyPkgBeforeSend: value },
    });
    enabled.value = settings.verifyPkgBeforeSend;
    message.value = 'Настройки установки PS4 сохранены';
  } catch {
    message.value = 'Не удалось сохранить настройки установки PS4';
  } finally {
    (event.target as HTMLInputElement).checked = enabled.value;
    busy.value = false;
  }
}
</script>
<template>
  <section class="settings-card glass-surface ps4-install-settings">
    <h2>{{ t('Установка PKG на PS4') }}</h2>
    <label
      ><input
        type="checkbox"
        :checked="enabled"
        :disabled="!loaded || busy"
        @change="save"
      /><span>{{ t('Проверять PKG перед отправкой') }}</span></label
    >
    <p>
      {{
        t(
          'Дополнительная проверка требований PARAM и SDK. По умолчанию выключена; не меняет установку PS5. PyLoader не требует нашей службы: место и итог установки проверяет приставка.',
        )
      }}
    </p>
    <p v-if="message" role="status">{{ t(message) }}</p>
  </section>
</template>
<style scoped>
label {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  font-size: 14px;
}
input {
  width: 18px;
  height: 18px;
  accent-color: #25c8ff;
}
p {
  max-width: 850px;
  line-height: 1.6;
}
</style>

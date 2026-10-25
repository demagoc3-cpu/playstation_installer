<script setup lang="ts">
import type { PresetSummary } from '#shared/types/presets';
const { t } = useAppLocale();
const props = defineProps<{ preset?: { id: string; name: string; description?: string } }>();
const emit = defineEmits<{ close: []; saved: [preset: PresetSummary] }>();
const name = ref(props.preset?.name || ''),
  description = ref(props.preset?.description || ''),
  busy = ref(false),
  message = ref(''),
  nameInput = ref<HTMLInputElement>();
async function save() {
  busy.value = true;
  try {
    const result = await $fetch<PresetSummary>('/api/presets', {
      method: 'POST',
      body: {
        action: props.preset ? 'rename' : 'create',
        id: props.preset?.id,
        name: name.value,
        description: description.value,
      },
    });
    emit('saved', result);
    emit('close');
  } catch (e: any) {
    message.value = e?.data?.message || 'Не удалось сохранить пресет';
  } finally {
    busy.value = false;
  }
}
onMounted(() => nameInput.value?.focus());
</script>
<template>
  <Teleport to="body"
    ><div
      class="preset-modal"
      @click.self="!busy && emit('close')"
      @keydown.esc="!busy && emit('close')"
    >
      <form
        class="preset-dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="t(preset ? 'Редактировать пресет' : 'Создать пресет')"
        @submit.prevent="save"
      >
        <header>
          <h2>{{ t(preset ? 'Редактировать пресет' : 'Создать пресет') }}</h2>
          <button
            class="pf-close"
            type="button"
            :disabled="busy"
            :aria-label="t('Закрыть')"
            @click="emit('close')"
          >
            ×
          </button>
        </header>
        <label
          >{{ t('Название пресета')
          }}<input
            ref="nameInput"
            v-model="name"
            maxlength="120"
            required
            :placeholder="t('Например, Гонки')" /></label
        ><label
          >{{ t('Описание')
          }}<textarea
            v-model="description"
            maxlength="2000"
            rows="4"
            :placeholder="t('Какие игры входят в эту подборку')"
          />
        </label>
        <p v-if="message" role="alert">{{ t(message) }}</p>
        <footer>
          <button type="button" :disabled="busy" @click="emit('close')">{{ t('Отмена') }}</button
          ><button class="primary" :disabled="busy || !name.trim()">
            {{ t(busy ? 'Сохраняем…' : 'Сохранить') }}
          </button>
        </footer>
      </form>
    </div></Teleport
  >
</template>
<style scoped>
.preset-modal {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: grid;
  place-items: center;
  padding: 24px;
  background: #020813ba;
}
.preset-dialog {
  width: 480px;
  max-width: 100%;
  max-height: 90vh;
  overflow: auto;
  background: rgb(14 29 51 / 97%);
  color: #e6efff;
  border: 1px solid var(--pf-line);
  border-radius: 16px;
  padding: 24px;
  display: grid;
  gap: 18px;
}
header,
footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
h2 {
  margin: 0;
  font-size: 20px;
}
label {
  display: grid;
  gap: 8px;
  font-size: 12px;
  color: #a6bee1;
}
input,
textarea {
  width: 100%;
  background: #07172b99;
  border: 1px solid var(--pf-line);
  border-radius: 9px;
  padding: 10px;
  color: #e6efff;
  font: inherit;
}
textarea {
  resize: vertical;
}
button {
  border: 1px solid var(--pf-line);
  border-radius: 9px;
  padding: 9px 14px;
  background: linear-gradient(145deg, #29426475, #142b4b9e);
  color: #e6efff;
  cursor: pointer;
  font-size: 12px;
}
footer {
  justify-content: flex-end;
}
/* Teleported outside the shell: the shared primary style does not reach here. */
button.primary {
  color: #fff;
  background: linear-gradient(115deg, #159dce, #7561ed);
  border-color: #93caff6e;
}
p {
  font-size: 12px;
  color: #ffadbd;
}
</style>

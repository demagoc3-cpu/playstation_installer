<script setup lang="ts">
/* Notifications in the header. For now one kind: a newer PackageFlow release.
 * A notice only; the update itself is installed from the release page. */
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
  open = ref(false),
  seen = ref('');
const root = ref<HTMLElement | null>(null);
const unread = computed(
  () => !!state.value?.available && state.value.latest?.version !== seen.value,
);
let timer: ReturnType<typeof setInterval> | undefined;
async function load() {
  try {
    state.value = await $fetch<UpdateState>('/api/app-updates');
  } catch {
    /* The bell stays quiet when the server cannot answer. */
  }
}
function toggle() {
  open.value = !open.value;
  if (open.value && state.value?.available && state.value.latest) {
    seen.value = state.value.latest.version;
    try {
      localStorage.setItem('packageflow-seen-update', seen.value);
    } catch {
      /* Shown as unread again next time. */
    }
  }
}
function outside(event: MouseEvent) {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}
function openRelease() {
  if (state.value?.latest) window.open(state.value.latest.url, '_blank', 'noopener');
}
const date = (value: string) =>
  value ? new Date(value).toLocaleDateString(formatLocale.value) : '';
onMounted(() => {
  try {
    seen.value = localStorage.getItem('packageflow-seen-update') || '';
  } catch {
    /* No saved state. */
  }
  void load();
  timer = setInterval(
    () => {
      if (document.visibilityState === 'visible') void load();
    },
    10 * 60 * 1000,
  );
  document.addEventListener('click', outside);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  document.removeEventListener('click', outside);
});
</script>
<template>
  <div ref="root" class="notify">
    <button
      type="button"
      class="notify-bell"
      :class="{ unread }"
      :aria-label="t(unread ? 'Уведомления: есть новые' : 'Уведомления')"
      :aria-expanded="open"
      :title="t('Уведомления')"
      @click.stop="toggle"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none">
        <path
          d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z M10 20a2 2 0 0 0 4 0"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
      </svg>
      <i v-if="unread" class="notify-dot" />
    </button>
    <section v-if="open" class="notify-panel" role="dialog" :aria-label="t('Уведомления')">
      <h3>{{ t('Уведомления') }}</h3>
      <article v-if="state?.available && state.latest" class="notify-item">
        <strong>{{ t('Доступна новая версия PackageFlow') }} {{ state.latest.version }}</strong>
        <span
          >{{ t('Установлена') }} {{ state.installed
          }}<template v-if="state.latest.publishedAt">
            · {{ t('выпущена') }} {{ date(state.latest.publishedAt) }}</template
          ></span
        >
        <button type="button" class="primary" @click="openRelease">
          {{ t('Открыть релиз') }}
        </button>
      </article>
      <p v-else-if="state && !state.installed" class="notify-empty">
        {{ t('Версия этой установки неизвестна, проверка обновлений недоступна.') }}
      </p>
      <p v-else-if="state?.error" class="notify-empty">
        {{ t('Не удалось проверить обновления:') }} {{ t(state.error) }}
      </p>
      <p v-else class="notify-empty">
        {{ t('Новых уведомлений нет.') }}
        <template v-if="state && !state.autoCheck">
          {{ t('Автоматическая проверка обновлений выключена в настройках.') }}</template
        >
      </p>
    </section>
  </div>
</template>
<style scoped>
.notify {
  position: relative;
}
.notify-bell {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  min-height: 34px;
  padding: 0;
  border: 1px solid var(--pf-line);
  border-radius: 9px;
  background: linear-gradient(145deg, #29426475, #142b4b9e);
  color: #e6efff;
  cursor: pointer;
}
.notify-bell:hover {
  background: #28517c99;
}
.notify-bell.unread {
  border-color: #53cfff99;
  color: #8dddff;
}
.notify-dot {
  position: absolute;
  top: 5px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ff6b8b;
  box-shadow: 0 0 0 2px #0b2949;
}
.notify-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 90;
  width: 320px;
  max-width: 90vw;
  padding: 14px;
  border: 1px solid #8ca7d14d;
  border-radius: 12px;
  background: rgb(14 29 51 / 97%);
  backdrop-filter: blur(18px);
  box-shadow: 0 12px 32px #000a;
  color: #e6efff;
  text-align: left;
}
.notify-panel h3 {
  margin: 0 0 10px;
  font-size: 14px;
}
.notify-item {
  display: grid;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--pf-line);
  border-radius: 9px;
  background: #0b294980;
  font-size: 12px;
}
.notify-item span {
  color: #a6bee1;
  font-size: 11px;
}
.notify-item button {
  justify-self: start;
  padding: 6px 12px;
  border-radius: 9px;
  border: 1px solid #93caff6e;
  background: linear-gradient(115deg, #159dce, #7561ed);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
}
.notify-empty {
  margin: 0;
  color: #a6bee1;
  font-size: 12px;
}
</style>

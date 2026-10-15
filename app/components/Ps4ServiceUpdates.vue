<script setup lang="ts">
import type { Ps4SystemSnapshot } from '../../shared/types/ps4-system';

const props = defineProps<{ ip: string; name: string }>();
const { t } = useAppLocale();
const current = ref('');
const message = ref('');
let generation = 0;
let controller: AbortController | undefined;

async function refresh() {
  controller?.abort();
  controller = new AbortController();
  const request = ++generation;
  message.value = '';
  try {
    const result = await $fetch<Ps4SystemSnapshot>('/api/ps4/system-info', {
      query: { ip: props.ip },
      signal: controller.signal,
    });
    if (request !== generation) return;
    current.value = result.pkgVersion || '';
    if (!result.ready)
      message.value =
        result.reason ||
        'Не удалось получить данные. Проверьте IP консоли и запуск PackageFlowService.';
  } catch {
    if (request === generation)
      message.value =
        'Не удалось получить данные. Проверьте IP консоли и запуск PackageFlowService.';
  }
}
watch(
  () => props.ip,
  () => {
    current.value = '';
    void refresh();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  controller?.abort();
});
</script>

<template>
  <div class="ps4-service-updates">
    <p class="device">{{ name }} · PS4 {{ ip }}</p>
    <p class="hint">
      {{
        t(
          'Начиная с PKG 2.03 интерфейс PackageFlow закрывается автоматически при обновлении. Фоновая служба остаётся доступной до замены.',
        )
      }}
    </p>
    <ServiceUpdates :key="ip" :ip="ip" :current="current" @changed="refresh" />
    <p v-if="message" role="alert">{{ t(message) }}</p>
  </div>
</template>

<style scoped>
.ps4-service-updates {
  margin-top: 20px;
  max-width: 1000px;
}
.device {
  font-size: 13px;
  color: #d8caed;
}
.hint {
  font-size: 12px;
  line-height: 1.7;
  color: #aaa3b7;
}
</style>

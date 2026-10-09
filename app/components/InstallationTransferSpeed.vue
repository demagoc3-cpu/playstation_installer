<script setup lang="ts">
import { installationTaskSpeed, type InstallationTask } from '#shared/types/tasks'
const props = defineProps<{ task: InstallationTask }>()
const { t, formatLocale } = useAppLocale()
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => clearInterval(timer))
const speed = computed(() => installationTaskSpeed(props.task, now.value))
const number = (value: number) => value.toLocaleString(formatLocale.value, { maximumFractionDigits: 1 })
</script>
<template><small v-if="speed !== undefined" class="transfer-speed" :title="t('Скорость передачи по байтам, подтверждённым PS5')">{{ number(speed / 1048576) }} {{ t('МиБ/с') }} · {{ number(speed * 8 / 1000000) }} {{ t('Мбит/с') }}</small></template>
<style scoped>.transfer-speed{color:#c4b9ff;font:10px 'DM Mono',monospace;white-space:nowrap;font-variant-numeric:tabular-nums}</style>

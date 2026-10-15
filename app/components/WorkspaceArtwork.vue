<script setup lang="ts">
const props = defineProps<{ cover?: string }>(),
  failed = ref(false);
watch(
  () => props.cover,
  () => (failed.value = false),
);
</script>
<template>
  <div v-if="cover && !failed" class="workspace-artwork" aria-hidden="true">
    <img :src="cover" alt="" @error="failed = true" />
  </div>
</template>

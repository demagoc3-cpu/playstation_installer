<script setup lang="ts">
const props = defineProps<{ cover?: string; title: string }>()
const failed = ref(false)
watch(() => props.cover, () => { failed.value = false })
</script>

<template>
  <div class="artwork" :class="{ 'has-cover': cover && !failed }">
    <img v-if="cover && !failed" :src="cover" :alt="title" loading="lazy" referrerpolicy="no-referrer" @error="failed = true">
    <div v-else class="placeholder" aria-hidden="true">
      <div class="halo" />
      <svg viewBox="0 0 120 100" fill="none"><path d="M36 30h48c11 0 17 10 19 21l7 24c3 13-9 19-18 10L79 72H41L28 85C19 94 7 88 10 75l7-24c2-11 8-21 19-21Z" stroke="currentColor" stroke-width="3"/><path d="M32 45v20m-10-10h20" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><circle cx="84" cy="47" r="4" fill="currentColor"/><circle cx="93" cy="57" r="4" fill="currentColor"/><path d="M51 24h18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>
      <span>PackageFlow</span>
    </div>
  </div>
</template>

<style scoped>
.artwork{position:relative;aspect-ratio:3/4;overflow:hidden;border-radius:12px;background:#171724}.artwork img{width:100%;height:100%;display:block;object-fit:cover}.placeholder{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:26px;color:#b4a1fa;background:linear-gradient(155deg,#24213c,#121520 68%)}.placeholder::after{content:"";position:absolute;inset:0;background:linear-gradient(#ffffff04 1px,transparent 1px),linear-gradient(90deg,#ffffff04 1px,transparent 1px);background-size:26px 26px}.halo{position:absolute;width:130px;height:130px;top:26%;border-radius:50%;background:#7255d52c;box-shadow:0 0 65px #7855ff3b}.placeholder svg{width:100px;position:relative;z-index:1}.placeholder span{position:relative;z-index:1;font-size:12px;letter-spacing:.1em;color:#7e7896}
</style>

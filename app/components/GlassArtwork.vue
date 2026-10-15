<script setup lang="ts">
const props=defineProps<{title:string;cover?:string;platform?:string}>()
const failed=ref(false)
watch(()=>props.cover,()=>failed.value=false)
</script>
<template><span class="glass-artwork"><img v-if="cover&&!failed" :src="cover" alt="" loading="lazy" @error="failed=true"><span v-else class="glass-artwork-fallback" aria-hidden="true">{{title.slice(0,1).toUpperCase()}}</span></span></template>

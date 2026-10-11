<script setup lang="ts">
defineProps<{ platform?: string; formats?: string[] }>()
const label = (value: string) => value === 'folder' ? 'Folder' : value.toUpperCase()
</script>
<template><span class="pf-content-tags"><span v-if="platform && platform !== 'unknown'" class="pf-tag" :class="`platform-${platform}`">{{ platform.toUpperCase() }}</span><span v-for="format in formats?.filter(value => value !== 'unknown')" :key="format" class="pf-tag" :class="`format-${format}`">{{ label(format) }}</span></span></template>
<style scoped>
.pf-content-tags{display:inline-flex;align-items:center;flex-wrap:wrap;gap:5px}.pf-tag{display:inline-block;padding:3px 6px;border:1px solid #5b63704d;border-radius:5px;font:700 9px system-ui,sans-serif;line-height:1;white-space:nowrap;letter-spacing:.2px;background:#303747;color:#cbd1dd}.platform-ps4{background:#286ca82b;color:#8cc9ff;border-color:#438dbe55}.platform-ps5{background:#7853be2b;color:#c4a5ff;border-color:#9271cb55}.format-pkg{background:#2b826b26;color:#8ce3c0;border-color:#449b8055}.format-folder{background:#b3833129;color:#f2cd83;border-color:#b38a4555}.format-ufs2{background:#57882929;color:#bddf86;border-color:#739f4f55}.format-exfat{background:#258b9529;color:#8bdae4;border-color:#459eaa55}.format-pfs{background:#9a446929;color:#f0a9c9;border-color:#ae688855}.format-ffpfsc{background:#555fb129;color:#b7c1ff;border-color:#7d83b655}
</style>

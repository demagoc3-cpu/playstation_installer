<script setup lang="ts">
const { t, locale } = useAppLocale()

const repository = 'demagoc3-cpu/playstation_installer'
const github = `https://github.com/${repository}`
const theme = 'style=flat&labelColor=29272f&color=7967d3'
const badges = computed(() => [
  { id: 'stars', label: '★ Звёзды', title: 'Звёзды PackageFlow на GitHub', href: `${github}/stargazers`, image: `https://img.shields.io/github/stars/${repository}?${theme}&label=${encodeURIComponent(locale.value === 'ru' ? 'Звёзды' : 'Stars')}` },
  { id: 'forks', label: 'Форки', title: 'Форки PackageFlow на GitHub', href: `${github}/forks`, image: `https://img.shields.io/github/forks/${repository}?${theme}&label=${encodeURIComponent(locale.value === 'ru' ? 'Форки' : 'Forks')}` },
  { id: 'version', label: 'Теги', title: 'Последний тег WEB и все версии на GitHub', href: `${github}/tags`, image: `https://img.shields.io/github/v/tag/${repository}?${theme}&sort=semver&filter=v*&label=WEB` },
])
const loaded = reactive<Record<string, boolean>>({})
const failed = reactive<Record<string, boolean>>({})
watch(locale, () => { for (const id of Object.keys(loaded)) delete loaded[id]; for (const id of Object.keys(failed)) delete failed[id] })
</script>

<template>
  <nav class="github-stats" :aria-label="t(&quot;Проект на GitHub&quot;)">
    <a class="github-project" :href="github" target="_blank" rel="noopener noreferrer" :title="t(&quot;Открыть PackageFlow на GitHub&quot;)">
      <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.62 1.22 3.26.93.1-.73.4-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15a10.8 10.8 0 0 1 5.64 0c2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.69.11 2.98.72.79 1.16 1.8 1.16 3.02 0 4.32-2.64 5.28-5.15 5.56.4.35.76 1.03.76 2.08v3.1c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z" /></svg>
      <span>GitHub</span>
    </a>
    <a v-for="badge in badges" :key="badge.id" class="github-badge" :href="badge.href" :title="t(badge.title)" :aria-label="t(badge.title)" target="_blank" rel="noopener noreferrer">
      <img v-if="!failed[badge.id]" v-show="loaded[badge.id]" :src="badge.image" :alt="t(badge.title)" height="20" referrerpolicy="no-referrer" @load="loaded[badge.id] = true" @error="failed[badge.id] = true">
      <span v-if="!loaded[badge.id] || failed[badge.id]" class="github-fallback">{{ t(badge.label) }}</span>
    </a>
  </nav>
</template>

<style scoped>
.github-stats { display: flex; align-items: center; gap: 7px; flex-shrink: 0; }
.github-stats a { display: inline-flex; align-items: center; text-decoration: none; border-radius: 4px; }
.github-stats a:focus-visible { outline: 2px solid #b7a9ff; outline-offset: 4px; }
.github-project { gap: 6px; margin-right: 3px; color: #c7c0da; font-size: 11px; font-weight: 800; }
.github-project:hover { color: #eee9ff; }
.github-badge { min-height: 20px; overflow: hidden; }
.github-badge:hover { filter: brightness(1.2); }
.github-badge img { display: block; height: 20px; }
.github-fallback { padding: 3px 7px; background: #29272f; color: #c7c0da; font-size: 10px; }
@media (max-width: 1100px) { .github-stats { gap: 5px; }.github-project span { display: none; } }
</style>

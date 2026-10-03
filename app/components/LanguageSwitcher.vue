<script setup lang="ts">
const { t, locale, setLocale } = useAppLocale()
</script>

<template>
  <div class="language-switcher" role="group" :aria-label="t('Язык интерфейса')">
    <button type="button" lang="ru" title="Русский" :aria-pressed="locale === 'ru'" @click="setLocale('ru')">RU</button>
    <button type="button" lang="en" title="English" :aria-pressed="locale === 'en'" @click="setLocale('en')">EN</button>
  </div>
</template>

<style scoped>
.language-switcher { display: inline-flex; flex-shrink: 0; gap: 2px; padding: 3px; border: 1px solid #3b3945; background: #222127; border-radius: 7px; }
button { padding: 5px 7px; border: 0; border-radius: 4px; background: transparent; color: #aba6bc; font-size: 10px; font-weight: 800; }
button[aria-pressed="true"] { background: #7967d3; color: #fff; }
button:hover { color: #fff; }
button:focus-visible { outline: 2px solid #c2b6ff; outline-offset: 2px; }
</style>

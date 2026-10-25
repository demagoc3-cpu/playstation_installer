<script setup lang="ts">
const { t } = useAppLocale();

const repository = 'demagoc3-cpu/playstation_installer';
const github = `https://github.com/${repository}`;
</script>

<template>
  <nav class="github-stats" :aria-label="t('Проект и сообщество PackageFlow')">
    <NotificationBell />
    <a
      class="github-project"
      :href="github"
      target="_blank"
      rel="noopener noreferrer"
      :title="t('Открыть PackageFlow на GitHub')"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
        <path
          d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.62 1.22 3.26.93.1-.73.4-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15a10.8 10.8 0 0 1 5.64 0c2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.69.11 2.98.72.79 1.16 1.8 1.16 3.02 0 4.32-2.64 5.28-5.15 5.56.4.35.76 1.03.76 2.08v3.1c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z"
        />
      </svg>
      <span>GitHub</span>
    </a>
    <a
      class="community-link"
      href="https://discord.gg/Xj6EPJyAq"
      target="_blank"
      rel="noopener noreferrer"
      :title="t('Присоединиться к Discord')"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
        <path
          d="M20.3 4.4a19.8 19.8 0 0 0-4.9-1.5l-.6 1.2a18.2 18.2 0 0 0-5.6 0l-.6-1.2a19.8 19.8 0 0 0-4.9 1.5C.6 9 .1 13.5.4 17.9a19.7 19.7 0 0 0 6 3l1.3-2.1-1.9-.9.5-.4a14.1 14.1 0 0 0 11.4 0l.5.4-1.9.9 1.3 2.1a19.7 19.7 0 0 0 6-3c.4-5.1-.7-9.6-3.3-13.5ZM8.2 15.2c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 1 2 2.2-.9 2.2-2 2.2Zm7.6 0c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 1 2 2.2-.9 2.2-2 2.2Z"
        />
      </svg>
      <span>Discord</span>
    </a>
    <a
      class="community-link forum-link"
      href="https://4pda.to/forum/index.php?showtopic=1127073"
      target="_blank"
      rel="noopener noreferrer"
      :title="t('Тема PackageFlow на 4PDA')"
      aria-label="4PDA"
    >
      <svg
        class="forum-logo"
        aria-hidden="true"
        viewBox="0 0 204 64"
        width="55"
        height="18"
        fill="currentColor"
      >
        <path class="forum-logo-four" d="M0 4h24L0 34Zm34 14v20H16ZM0 53h34v11H0Z" />
        <path
          fill-rule="evenodd"
          d="M49 4h27c19 0 29 9 29 23S94 50 77 50H67v14H49Zm18 15v16h9c7 0 11-3 11-8s-4-8-11-8Z"
        />
        <path
          fill-rule="evenodd"
          d="M100 4h25c22 0 34 11 34 30s-12 30-34 30h-25Zm18 15v30h7c10 0 16-5 16-15s-6-15-16-15Z"
        />
        <path fill-rule="evenodd" d="M158 4h24l22 60h-19l-4-12h-23l-4 12h-19Zm5 34h13l-6-19Z" />
      </svg>
    </a>
  </nav>
</template>

<style scoped>
.github-stats {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
}
.github-stats a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
  white-space: nowrap;
}
.github-stats a:focus-visible {
  outline: 2px solid #64d6ff;
  outline-offset: 3px;
}
.github-stats svg {
  flex: none;
}
.forum-logo {
  display: block;
  color: #c4dfff;
}
.forum-logo-four {
  fill: var(--pf-cyan, #37c9fb);
}
@media (max-width: 1100px) {
  .github-stats {
    gap: 5px;
  }
  .github-project span {
    display: none;
  }
}
</style>

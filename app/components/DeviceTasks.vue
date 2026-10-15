<script setup lang="ts">
import {
  TASK_CATEGORIES,
  installationTaskStateLabel,
  type InstallationTasksPage,
  type InstallationTask,
  type TaskCategory,
} from '#shared/types/tasks';
import type { ConsoleProfiles, DeviceActivity } from '#shared/types/consoles';
const props = defineProps<{
  profiles: ConsoleProfiles;
  activity: DeviceActivity[];
  visible: boolean;
  torrents: Array<{ hash: string; name: string; state: string; progress: number }>;
}>();
const emit = defineEmits<{
  changed: [];
  torrent: [hash: string, action: 'pause' | 'resume' | 'delete'];
}>();
const { t } = useAppLocale();
const query = ref(''),
  filter = ref('all'),
  onlyTasks = ref(false),
  message = ref(''),
  pending = ref(false);
const torrentCategories = ref<TaskCategory[]>([...TASK_CATEGORIES]),
  hiddenTorrents = ref<Record<string, string>>({});
const categoryLabels = {
  active: 'Активные',
  queued: 'В очереди',
  completed: 'Завершённые',
  failed: 'Ошибки и пропуски',
};
function torrentCategory(item: { state: string; progress: number }): TaskCategory {
  return /error|missingFiles|unknown/i.test(item.state)
    ? 'failed'
    : item.progress >= 1
      ? 'completed'
      : /paused|stopped|queued/i.test(item.state)
        ? 'queued'
        : 'active';
}
const visibleTorrents = computed(() =>
  props.torrents.filter(
    (item) => hiddenTorrents.value[item.hash] !== `${item.state}:${item.progress}`,
  ),
);
const filteredTorrents = computed(() =>
  visibleTorrents.value
    .filter((item) => torrentCategories.value.includes(torrentCategory(item)))
    .sort(
      (a, b) => Number(torrentCategory(b) === 'active') - Number(torrentCategory(a) === 'active'),
    ),
);
async function refreshTorrentsVisibility() {
  try {
    hiddenTorrents.value = (
      await $fetch<{ hiddenTorrents: Record<string, string> }>('/api/consoles/torrent-tasks')
    ).hiddenTorrents;
  } catch {}
}
async function clearTorrents() {
  try {
    await $fetch('/api/consoles/torrent-tasks', {
      method: 'POST',
      body: { torrents: props.torrents },
    });
    await refreshTorrentsVisibility();
  } catch {
    message.value = 'Не удалось очистить историю загрузок';
  }
}
function torrentDelete(hash: string) {
  if (window.confirm(t('Убрать torrent-задание? Скачанные файлы останутся на диске.')))
    emit('torrent', hash, 'delete');
}
watch(
  () => props.visible,
  (value) => {
    if (value) void refreshTorrentsVisibility();
  },
);
onMounted(refreshTorrentsVisibility);
const opened = reactive<Record<string, boolean>>({});
const category = ref<TaskCategory | 'all'>('all'),
  snapshots = reactive<Record<string, InstallationTasksPage>>({}),
  recentTasks = reactive<Record<string, InstallationTask[]>>({});
let recentGeneration = 0;
async function refreshRecent() {
  const generation = ++recentGeneration;
  if (!props.visible) return;
  await Promise.allSettled(
    props.profiles.consoles.map(async (profile) => {
      const page = await $fetch<InstallationTasksPage>('/api/consoles/tasks', {
        query: {
          consoleId: profile.id,
          page: 1,
          categories: 'completed',
          view: 'table',
          history: false,
        },
      });
      if (generation === recentGeneration && props.visible)
        recentTasks[profile.id] = page.items.filter((task) => task.category === 'completed');
    }),
  );
}
watch(
  () => props.visible,
  (visible) => {
    if (visible) void refreshRecent();
    else recentGeneration++;
  },
  { immediate: true },
);
onBeforeUnmount(() => recentGeneration++);
const totals = computed(() =>
  props.activity.reduce(
    (a, row) => {
      for (const key of TASK_CATEGORIES) a[key] += row.counts[key] || 0;
      return a;
    },
    { active: 0, queued: 0, completed: 0, failed: 0 },
  ),
);
const recent = computed(() =>
  Object.entries(recentTasks)
    .filter(([id]) => props.profiles.consoles.some((profile) => profile.id === id))
    .flatMap(([consoleId, items]) => items.map((task) => ({ ...task, consoleId })))
    .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt))
    .slice(0, 5),
);
function reveal(id: string) {
  opened[id] = true;
  nextTick(() =>
    document
      .getElementById('device-queue-' + id)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  );
}
function updateSnapshot(id: string, page: InstallationTasksPage) {
  snapshots[id] = page;
  const finished = page.items.filter((task) => task.category === 'completed');
  if (finished.length || page.counts.completed === 0) recentTasks[id] = finished;
}

const activityFor = (id: string) => props.activity.find((item) => item.consoleId === id);
const shown = computed(() =>
  props.profiles.consoles
    .filter(
      (item) =>
        (filter.value === 'all' || filter.value === item.platform) &&
        `${item.name} ${item.ip}`.toLowerCase().includes(query.value.toLowerCase()) &&
        (!onlyTasks.value ||
          Object.values(activityFor(item.id)?.counts || {}).some((value) => value > 0)),
    )
    .sort((a, b) => score(b.id) - score(a.id) || a.name.localeCompare(b.name)),
);
function score(id: string) {
  const counts = activityFor(id)?.counts;
  return counts?.active || activityFor(id)?.activePackageIds.length ? 2 : counts?.queued ? 1 : 0;
}
function isOpen(id: string) {
  return opened[id] ?? score(id) > 0;
}
async function clearAll() {
  if (pending.value) return;
  pending.value = true;
  message.value = '';
  const results = await Promise.allSettled(
    props.profiles.consoles.map((profile) =>
      $fetch('/api/consoles/tasks', {
        method: 'POST',
        body: { consoleId: profile.id, action: 'clear' },
      }),
    ),
  );
  const errors = results.filter((result) => result.status === 'rejected').length;
  message.value = errors
    ? `Не удалось очистить историю ${errors} устройств. Остальные списки очищены`
    : 'Завершённые задания и ошибки убраны из всех списков';
  await clearTorrents();
  await refreshRecent();
  pending.value = false;
  emit('changed');
}
async function cancelAll(id: string, resolve = false) {
  const activity = activityFor(id);
  if (!activity?.queueId || pending.value) return;
  if (
    !resolve &&
    !window.confirm(
      t('Отменить очередь только этого устройства? Остальные приставки продолжат установку.'),
    )
  )
    return;
  pending.value = true;
  try {
    const result = await $fetch<{ message?: string }>('/api/consoles/tasks', {
      method: 'POST',
      body: { consoleId: id, queueId: activity.queueId, action: resolve ? 'resolve' : 'cancel' },
    });
    message.value = result.message || 'Очередь изменена';
    emit('changed');
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось изменить очередь';
  } finally {
    pending.value = false;
  }
}
</script>
<template>
  <section class="device-tasks">
    <WorkspaceArtwork
      :cover="
        Object.values(snapshots)
          .flatMap((page) => page.active)
          .find((task) => task.groupIconId)?.groupIconId
          ? `/api/packages/${
              Object.values(snapshots)
                .flatMap((page) => page.active)
                .find((task) => task.groupIconId)!.groupIconId
            }?asset=icon`
          : recent[0]?.groupIconId
            ? `/api/packages/${recent[0].groupIconId}?asset=icon`
            : undefined
      "
    />
    <header>
      <div>
        <h1>{{ t('Задания') }}</h1>
        <p>{{ t('У каждой приставки своя очередь. Активные устройства всегда сверху.') }}</p>
      </div>
      <button :disabled="pending" @click="clearAll">
        {{ t('Очистить завершённые и ошибки') }}
      </button>
    </header>
    <div class="filters">
      <input v-model="query" :placeholder="t('Найти устройство')" /><select v-model="filter">
        <option value="all">{{ t('Все') }}</option>
        <option value="ps4">PS4</option>
        <option value="ps5">PS5</option></select
      ><label><input v-model="onlyTasks" type="checkbox" /> {{ t('Только с заданиями') }}</label>
    </div>
    <p v-if="message" class="pf-notice" role="status">{{ t(message) }}</p>
    <div class="task-dashboard">
      <div class="task-dashboard-main">
        <div class="glass-tabs task-category-tabs">
          <button
            :class="{ active: category === 'all' }"
            :aria-pressed="category === 'all'"
            @click="category = 'all'"
          >
            {{ t('Все') }}</button
          ><button
            v-for="key in TASK_CATEGORIES"
            :key="key"
            :class="{ active: category === key }"
            :aria-pressed="category === key"
            @click="category = key"
          >
            {{ t(categoryLabels[key]) }} <span>{{ totals[key] }}</span>
          </button>
        </div>
        <div class="devices-list">
          <article
            v-for="profile in shown"
            :key="profile.id"
            class="device-group"
            :id="'device-queue-' + profile.id"
          >
            <button
              class="device-heading"
              :aria-expanded="isOpen(profile.id)"
              @click="opened[profile.id] = !isOpen(profile.id)"
            >
              <span class="arrow">{{ isOpen(profile.id) ? '⌄' : '›' }}</span
              ><strong>{{ profile.name }}</strong
              ><span>{{ profile.platform.toUpperCase() }} · {{ profile.ip }}</span
              ><span class="glass-status" :class="{ online: profile.online }"
                ><i />{{ t(profile.online ? 'В сети' : 'Нет связи') }}</span
              ><small
                >{{ t('Активные:') }} {{ activityFor(profile.id)?.counts.active || 0 }} ·
                {{ t('В очереди:') }} {{ activityFor(profile.id)?.counts.queued || 0 }} ·
                {{ t('Завершённые:') }} {{ activityFor(profile.id)?.counts.completed || 0 }} ·
                {{ t('Ошибки и пропуски:') }}
                {{ activityFor(profile.id)?.counts.failed || 0 }}</small
              >
            </button>
            <div v-if="isOpen(profile.id)" class="device-details">
              <InstallationTasks
                :console-id="profile.id"
                :platform="profile.platform"
                :ip="profile.ip"
                :visible="visible"
                :category="category"
                :torrents="[]"
                :queue-status="activityFor(profile.id)?.status || 'idle'"
                :cancelling="pending"
                @snapshot="updateSnapshot(profile.id, $event)"
                @changed="emit('changed')"
                @stop="cancelAll(profile.id)"
                @resolve="cancelAll(profile.id, true)"
              />
            </div>
          </article>
          <p v-if="!shown.length" class="empty">{{ t('Нет устройств в выбранном фильтре.') }}</p>
          <section v-if="torrents.length" class="torrent-tasks">
            <header>
              <h2>qBittorrent</h2>
              <button @click="clearTorrents">{{ t('Очистить') }}</button>
            </header>
            <div class="filters">
              <label v-for="category in TASK_CATEGORIES" :key="category"
                ><input v-model="torrentCategories" type="checkbox" :value="category" />
                {{ t(categoryLabels[category]) }}
                {{
                  visibleTorrents.filter((item) => torrentCategory(item) === category).length
                }}</label
              >
            </div>
            <article v-for="item in filteredTorrents" :key="item.hash">
              <strong>{{ item.name }}</strong
              ><span>{{ Math.round(item.progress * 100) }}% · {{ item.state }}</span
              ><button
                v-if="item.progress < 1"
                @click="
                  emit(
                    'torrent',
                    item.hash,
                    /paused|stopped/i.test(item.state) ? 'resume' : 'pause',
                  )
                "
              >
                {{ t(/paused|stopped/i.test(item.state) ? 'Продолжить' : 'Пауза') }}</button
              ><button @click="torrentDelete(item.hash)">{{ t('Убрать задачу') }}</button>
            </article>
          </section>
        </div>
      </div>
      <aside class="task-dashboard-aside">
        <section class="queue-overview glass-surface">
          <h2>{{ t('Очереди устройств') }}</h2>
          <div class="queue-metrics">
            <div>
              <strong>{{ totals.active }}</strong
              ><span>{{ t('Активные') }}</span>
            </div>
            <div>
              <strong>{{ totals.queued }}</strong
              ><span>{{ t('В очереди') }}</span>
            </div>
          </div>
          <button
            v-for="profile in profiles.consoles"
            :key="profile.id"
            class="queue-device"
            @click="reveal(profile.id)"
          >
            <span
              ><strong>{{ profile.name }}</strong
              ><small>{{ profile.platform.toUpperCase() }} · {{ profile.ip }}</small></span
            ><i class="queue-dot" :class="{ online: profile.online }" /><small
              >{{ activityFor(profile.id)?.counts.active || 0 }} {{ t('Активные') }} ·
              {{ activityFor(profile.id)?.counts.queued || 0 }} {{ t('В очереди') }}</small
            >
          </button>
        </section>
        <section class="recent-completions glass-surface">
          <h2>{{ t('Последние завершения') }}</h2>
          <button
            v-for="task in recent"
            :key="task.id + task.consoleId"
            class="recent-task"
            @click="
              category = 'completed';
              reveal(task.consoleId);
            "
          >
            <GlassArtwork
              :title="task.title"
              :cover="task.groupIconId ? `/api/packages/${task.groupIconId}?asset=icon` : undefined"
            /><span
              ><strong>{{ task.title }}</strong
              ><small
                >{{ t(installationTaskStateLabel(task)) }} ·
                {{ (task.consolePlatform || task.platform)?.toUpperCase() }}</small
              ></span
            >
          </button>
          <p v-if="!recent.length">{{ t('Завершённых заданий пока нет.') }}</p>
        </section>
      </aside>
    </div>
  </section>
</template>
<style scoped>
.device-tasks {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
header,
.filters {
  display: flex;
  align-items: center;
  gap: 12px;
}
header {
  justify-content: space-between;
}
h1 {
  margin: 0;
  font-size: 24px;
}
p {
  margin: 6px 0;
  color: #acbfdc;
  font-size: 12px;
}
.filters > input {
  width: 300px;
  max-width: 45%;
}
.filters label {
  font-size: 12px;
}
.devices-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  scrollbar-color: #3070b6 #07172b;
}
.device-group {
  border: 1px solid var(--pf-line);
  background: #071c3580;
  border-radius: 10px;
  margin-bottom: 12px;
  overflow: hidden;
}
.device-heading {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 14px;
  text-align: left;
  border: 0;
  border-radius: 0;
  padding: 16px;
  background: #0b294980;
}
.device-heading strong {
  font-size: 15px;
}
.device-heading span:not(.arrow) {
  color: #a6bee1;
  font-size: 11px;
}
.device-heading small {
  margin-left: auto;
  color: #a6bee1;
  font-size: 11px;
}
.device-heading i {
  font-style: normal;
  color: #777;
}
.device-heading .online {
  color: #8fd0a6;
}
.arrow {
  color: #8dddff;
  font-size: 22px;
}
.device-details {
  height: min(68vh, 720px);
  min-height: 300px;
  padding: 16px;
  border-top: 1px solid var(--pf-line);
}
.device-details :deep(.task-title h1) {
  font-size: 17px;
}
.device-details :deep(.task-title p) {
  display: none;
}
.torrent-tasks {
  padding: 12px;
}
.torrent-tasks h2 {
  font-size: 17px;
}
.torrent-tasks article {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid #5897e730;
  font-size: 12px;
}
.torrent-tasks strong {
  flex: 1;
}
button,
input:not([type='checkbox']),
select {
  padding: 9px 12px;
  background: linear-gradient(145deg, #29426475, #142b4b9e);
  border: 1px solid var(--pf-line);
  border-radius: 8px;
  color: #e6efff;
  font-size: 12px;
}
button {
  cursor: pointer;
}
button:disabled {
  opacity: 0.4;
}
input {
  accent-color: #37c9fb;
}
@media (max-width: 900px) {
  .device-heading {
    flex-wrap: wrap;
  }
  .device-heading small {
    margin-left: 0;
    width: 100%;
  }
}
</style>

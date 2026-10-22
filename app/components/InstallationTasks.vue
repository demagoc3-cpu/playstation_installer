<script setup lang="ts">
import {
  installationTaskGroupKey,
  TASK_CATEGORIES,
  type TaskCategory,
  type InstallationTask,
  type InstallationTasksPage,
} from '#shared/types/tasks';
const { t, formatLocale } = useAppLocale();
interface Torrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
}
const props = defineProps<{
  visible: boolean;
  consoleId?: string;
  platform?: 'ps4' | 'ps5';
  ip: string;
  category?: TaskCategory | 'all';
  torrents: Torrent[];
  queueStatus: string;
  cancelling: boolean;
  maintenance?: { id: string; title: string; state: string; message: string } | null;
  /** Device list: active card, the next three, the rest behind a link. */
  compact?: boolean;
}>();
const emit = defineEmits<{
  changed: [];
  snapshot: [value: InstallationTasksPage];
  torrent: [hash: string, action: 'pause' | 'resume' | 'delete'];
  stop: [];
  resolve: [];
  full: [value: boolean];
}>();
const categories = ref<TaskCategory[]>([...TASK_CATEGORIES]);
const labels = {
  active: 'Активные',
  queued: 'В очереди',
  completed: 'Завершённые',
  failed: 'Ошибки и пропуски',
};
const data = ref<InstallationTasksPage>({
  active: [],
  items: [],
  counts: { active: 0, queued: 0, completed: 0, failed: 0 },
  page: 1,
  pages: 1,
  total: 0,
  unit: 'games',
});
const view = ref<'tree' | 'table'>('tree');
const fullList = ref(false);
const compactView = computed(
  () => props.compact && !fullList.value && (props.category ?? 'all') === 'all',
);
watch(compactView, (value) => emit('full', !value), { immediate: true });
const nextQueued = computed(() =>
  data.value.items.filter((task) => task.category === 'queued').slice(0, 3),
);
const gigabytes = (bytes: number) =>
  (bytes / 1024 ** 3).toLocaleString(formatLocale.value, { maximumFractionDigits: 1 });
function openFull(finished = false) {
  if (finished) categories.value = ['completed', 'failed'];
  fullList.value = true;
}
function closeFull() {
  categories.value = [...TASK_CATEGORIES];
  fullList.value = false;
}
const showHistory = ref(false);
const treeExpanded = reactive<Record<string, boolean>>({});
const clearedMaintenance = ref('');
async function clearFinished() {
  if (pending.value) return;
  pending.value = 'clear';
  message.value = '';
  try {
    await $fetch(props.consoleId ? '/api/consoles/tasks' : '/api/ps4/installation/clear', {
      method: 'POST',
      body: {
        action: 'clear',
        consoleId: props.consoleId,
        ip: props.ip,
        torrents: props.torrents.filter((item) =>
          ['completed', 'failed'].includes(torrentCategory(item)),
        ),
      },
    });
    if (maintenance.value && ['completed', 'failed'].includes(maintenance.value.state)) {
      clearedMaintenance.value = maintenance.value.id;
      try {
        localStorage.setItem('packageflow-cleared-maintenance', clearedMaintenance.value);
      } catch {}
    }
    page.value = 1;
    await refresh();
    message.value = 'Завершённые задания и ошибки убраны из списка';
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось очистить задания';
  } finally {
    pending.value = '';
  }
}
const visibleTorrents = computed(() =>
  props.torrents.filter(
    (item) =>
      !['completed', 'failed'].includes(torrentCategory(item)) ||
      data.value.hiddenTorrents?.[item.hash] !== `${item.state}:${item.progress}`,
  ),
);
const page = ref(1),
  message = ref(''),
  pending = ref('');
let timer: ReturnType<typeof setInterval> | undefined,
  controller: AbortController | undefined,
  generation = 0;
async function refresh() {
  if (!props.visible) return;
  controller?.abort();
  controller = new AbortController();
  const request = ++generation;
  try {
    const result = await $fetch<InstallationTasksPage>(
      props.consoleId ? '/api/consoles/tasks' : '/api/ps4/installation/tasks',
      {
        query: {
          consoleId: props.consoleId,
          ip: props.ip,
          page: page.value,
          categories: categories.value.join(','),
          view: view.value,
          history: showHistory.value,
        },
        signal: controller.signal,
      },
    );
    if (request !== generation) return;
    data.value = result;
    page.value = result.page;
    emit('snapshot', result);
  } catch (error: any) {
    if (request === generation && !controller?.signal.aborted)
      message.value = error?.data?.message || 'Не удалось обновить задания';
  }
}
watch(
  () => props.category,
  (value) => {
    if (value) {
      categories.value = value === 'all' ? [...TASK_CATEGORIES] : [value];
    }
  },
  { immediate: true },
);
async function pauseQueue() {
  if (props.platform !== 'ps5' || !props.consoleId || !data.value.queueId || pending.value) return;
  pending.value = 'pause';
  message.value = '';
  try {
    await $fetch('/api/consoles/tasks', {
      method: 'POST',
      body: { action: 'pause', consoleId: props.consoleId, queueId: data.value.queueId },
    });
    emit('changed');
    await refresh();
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось приостановить очередь';
  } finally {
    pending.value = '';
  }
}
function selectView(value: 'tree' | 'table') {
  if (view.value === value) return;
  view.value = value;
  page.value = 1;
  try {
    localStorage.setItem('packageflow-tasks-view', value);
  } catch {
    /* Session choice still applies. */
  }
  void refresh();
}
function setAll(checked: boolean) {
  categories.value = checked ? [...TASK_CATEGORIES] : [];
}
watch(
  categories,
  () => {
    page.value = 1;
    void refresh();
  },
  { deep: true },
);
watch(showHistory, () => {
  page.value = 1;
  void refresh();
});
watch(
  () => props.ip,
  () => {
    controller?.abort();
    generation++;
    data.value = { ...data.value, items: [], active: [] };
    page.value = 1;
    void refresh();
  },
);
watch(
  () => props.visible,
  (visible) => {
    if (visible) void refresh();
    else {
      controller?.abort();
      generation++;
    }
  },
);
onMounted(() => {
  try {
    clearedMaintenance.value = localStorage.getItem('packageflow-cleared-maintenance') || '';
    if (localStorage.getItem('packageflow-tasks-view') === 'table') view.value = 'table';
  } catch {
    /* The default tree remains available. */
  }
  void refresh();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && !pending.value) void refresh();
  }, 2000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  controller?.abort();
  generation++;
});
async function confirmInstalled(task: InstallationTask) {
  if (pending.value || !props.consoleId || !task.canConfirm) return;
  pending.value = task.id;
  message.value = '';
  try {
    await $fetch('/api/consoles/tasks', {
      method: 'POST',
      body: {
        action: 'confirm-installed',
        consoleId: props.consoleId,
        queueId: task.queueId,
        packageId: task.packageId,
        installed: true,
      },
    });
    emit('changed');
    await refresh();
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось подтвердить установку';
  } finally {
    pending.value = '';
  }
}
async function stopWaiting(task: InstallationTask) {
  if (pending.value || !props.consoleId || !task.canStopWaiting) return;
  if (
    !window.confirm(
      t(
        'Снять ожидание результата? Очередь WEB продолжит работу. Результат установки на PS5 останется неподтверждённым.',
      ),
    )
  )
    return;
  pending.value = task.id;
  message.value = '';
  try {
    await $fetch('/api/consoles/tasks', {
      method: 'POST',
      body: {
        action: 'stop-waiting',
        consoleId: props.consoleId,
        queueId: task.queueId,
        packageId: task.packageId,
      },
    });
    emit('changed');
    await refresh();
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось снять ожидание';
  } finally {
    pending.value = '';
  }
}
async function cancel(task: InstallationTask) {
  if (pending.value) return;
  if (
    task.category === 'active' &&
    !window.confirm(t('Отменить только этот пакет? Остальные задания останутся в очереди.'))
  )
    return;
  pending.value = task.id;
  message.value = '';
  try {
    const result = await $fetch<{ message?: string }>(
      props.consoleId ? '/api/consoles/tasks' : '/api/ps4/installation/item-cancel',
      {
        method: 'POST',
        body: {
          action: 'cancel',
          consoleId: props.consoleId,
          queueId: task.queueId,
          packageIds: [task.packageId],
          packageId: task.packageId,
          ip: task.psIp,
        },
      },
    );
    message.value = result.message || '';
    emit('changed');
    await refresh();
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось отменить задание';
  } finally {
    pending.value = '';
  }
}
async function cancelBranch(items: InstallationTask[]) {
  const targets = items.filter((task) => task.canCancel);
  if (
    !targets.length ||
    pending.value ||
    !window.confirm(t('Отменить задания этой ветки? Остальные игры продолжат установку.'))
  )
    return;
  pending.value = `cancel-branch:${targets[0]!.id}`;
  message.value = '';
  const destination = { consoleId: props.consoleId, ip: props.ip };
  try {
    for (const queueId of [...new Set(targets.map((task) => task.queueId))]) {
      const selected = targets.filter((task) => task.queueId === queueId);
      await $fetch(
        destination.consoleId ? '/api/consoles/tasks' : '/api/ps4/installation/branch-cancel',
        {
          method: 'POST',
          body: {
            action: 'cancel',
            ...destination,
            queueId,
            branches: [
              ...new Set(
                selected.map(
                  (task) =>
                    `${task.platform || props.platform || 'ps4'}:${task.titleId || task.packageId}`,
                ),
              ),
            ],
            gameId: selected[0]!.titleId || selected[0]!.packageId,
          },
        },
      );
    }
    message.value = 'Отмена заданий ветки запрошена';
    emit('changed');
    await refresh();
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось отменить ветку';
    emit('changed');
    await refresh();
  } finally {
    pending.value = '';
  }
}
async function cancelAll() {
  if (!props.consoleId) {
    emit('stop');
    return;
  }
  if (
    !data.value.queueId ||
    pending.value ||
    !window.confirm(
      t('Отменить очередь только этого устройства? Остальные приставки продолжат установку.'),
    )
  )
    return;
  pending.value = 'cancel-all';
  message.value = '';
  try {
    const result = await $fetch<{ message?: string }>('/api/consoles/tasks', {
      method: 'POST',
      body: { action: 'cancel', consoleId: props.consoleId, queueId: data.value.queueId },
    });
    message.value = result.message || 'Отмена очереди запрошена';
    emit('changed');
    await refresh();
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось отменить очередь';
  } finally {
    pending.value = '';
  }
}
async function resumeQueue(queueId: string) {
  if (!props.consoleId || pending.value) return;
  pending.value = 'resume';
  message.value = '';
  try {
    await $fetch('/api/consoles/tasks', {
      method: 'POST',
      body: { action: 'resume', consoleId: props.consoleId, queueId },
    });
    emit('changed');
    await refresh();
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось продолжить очередь';
  } finally {
    pending.value = '';
  }
}
const canCancelAll = computed(
  () =>
    data.value.canCancelAll ??
    (props.queueStatus === 'running' ||
      (props.queueStatus === 'failed' && data.value.counts.queued > 0)),
);
async function removeTasks(items: InstallationTask[], branch = false) {
  const targets = items.filter((task) => task.canCancel || task.canDismiss);
  if (!targets.length || pending.value) return;
  if (
    branch &&
    !window.confirm(
      t(
        'Убрать всю ветку из заданий? Неотправленные пакеты отменятся, установленные игры останутся на приставке.',
      ),
    )
  )
    return;
  pending.value = `remove:${targets[0]!.id}`;
  message.value = '';
  try {
    const queues = [...new Set(targets.map((task) => task.queueId))];
    const replies = await Promise.allSettled(
      queues.map((queueId) =>
        $fetch<{ message?: string }>(
          props.consoleId ? '/api/consoles/tasks' : '/api/ps4/installation/remove',
          {
            method: 'POST',
            body: {
              action: 'remove',
              consoleId: props.consoleId,
              ip: props.ip,
              queueId,
              ...(branch
                ? {
                    branches: [
                      ...new Set(
                        targets
                          .filter((task) => task.queueId === queueId)
                          .map(
                            (task) =>
                              `${task.platform || props.platform || 'ps4'}:${task.titleId || task.packageId}`,
                          ),
                      ),
                    ],
                  }
                : {
                    packageIds: targets
                      .filter((task) => task.queueId === queueId)
                      .map((task) => task.packageId),
                  }),
            },
          },
        ),
      ),
    );
    const error = replies.find((result) => result.status === 'rejected');
    message.value =
      error?.status === 'rejected'
        ? error.reason?.data?.message || 'Не удалось убрать часть заданий'
        : replies
            .filter((result) => result.status === 'fulfilled')
            .map((result) => result.value.message)
            .filter(Boolean)
            .join(' ');
    emit('changed');
    await refresh();
  } finally {
    pending.value = '';
  }
}
async function stopReinstall() {
  const flow = maintenance.value;
  if (
    !flow ||
    pending.value ||
    !window.confirm(
      t(
        'Остановить переустановку? Уже отправленное удаление нельзя отменить; следующие команды не отправятся.',
      ),
    )
  )
    return;
  pending.value = 'stop-reinstall';
  try {
    const result = await $fetch<{ message?: string }>(
      props.consoleId ? '/api/consoles/tasks' : '/api/ps4/installation/remove',
      {
        method: 'POST',
        body: {
          action: 'stop-reinstall',
          consoleId: props.consoleId,
          ip: props.ip,
          queueId: flow.id,
        },
      },
    );
    message.value = result.message || '';
    emit('changed');
    await refresh();
  } catch (error: any) {
    message.value = error?.data?.message || 'Не удалось остановить переустановку';
  } finally {
    pending.value = '';
  }
}
function torrentCategory(item: Torrent): TaskCategory {
  if (/error|missingFiles|unknown/i.test(item.state)) return 'failed';
  if (item.progress >= 1) return 'completed';
  return /paused|stopped|queued/i.test(item.state) ? 'queued' : 'active';
}
const taskGroups = computed(() => {
  const groups = new Map<
    string,
    { key: string; title: string; titleId: string; icon?: string; items: InstallationTask[] }
  >();
  for (const task of data.value.items) {
    const key = installationTaskGroupKey(task);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: task.groupTitle,
        titleId: task.titleId,
        icon: task.groupIconId,
        items: [],
      };
      groups.set(key, group);
    }
    group.items.push(task);
  }
  return [...groups.values()];
});
function treeOpen(group: { key: string; items: InstallationTask[] }) {
  return (
    treeExpanded[group.key] ??
    group.items.some((task) => ['active', 'queued', 'failed'].includes(task.category))
  );
}
const maintenance = computed(() => data.value.maintenance || props.maintenance);
const showMaintenance = computed(
  () =>
    maintenance.value &&
    clearedMaintenance.value !== maintenance.value.id &&
    (!['completed', 'failed'].includes(maintenance.value.state) ||
      categories.value.includes(maintenance.value.state === 'failed' ? 'failed' : 'completed')),
);
const activeTorrents = computed(() =>
  visibleTorrents.value.filter((item) => torrentCategory(item) === 'active'),
);
const otherTorrents = computed(() =>
  visibleTorrents.value.filter(
    (item) =>
      torrentCategory(item) !== 'active' && categories.value.includes(torrentCategory(item)),
  ),
);
const torrentCounts = computed(
  () =>
    Object.fromEntries(
      TASK_CATEGORIES.map((category) => [
        category,
        visibleTorrents.value.filter((item) => torrentCategory(item) === category).length,
      ]),
    ) as Record<TaskCategory, number>,
);
function torrentAction(item: Torrent, action: 'pause' | 'resume' | 'delete') {
  if (
    action === 'delete' &&
    !window.confirm(t('Убрать torrent-задание? Скачанные файлы останутся на диске.'))
  )
    return;
  emit('torrent', item.hash, action);
}
function go(value: number) {
  page.value = value;
  void refresh().then(() => {
    const list = document.querySelector('.task-list');
    if (list) list.scrollTop = 0;
  });
}
</script>
<template>
  <section class="tasks-workspace">
    <div class="task-title">
      <div>
        <h1>{{ t('Задания') }}</h1>
        <p>
          {{
            t('Установки на PlayStation и загрузки qBittorrent. Активные задания всегда сверху.')
          }}
        </p>
      </div>
      <div class="task-controls">
        <button
          v-for="queueId in data.resumableQueues || []"
          :key="queueId"
          :disabled="!!pending"
          @click="resumeQueue(queueId)"
        >
          {{ t('Продолжить остановленную очередь') }}</button
        ><button v-if="canCancelAll" :disabled="cancelling || !!pending" @click="cancelAll">
          {{ t('Отменить всю очередь') }}</button
        ><button
          v-if="queueStatus === 'cancelling'"
          :disabled="cancelling"
          @click="emit('resolve')"
        >
          {{ t('Снять ожидание') }}</button
        ><button v-if="compact && fullList" @click="closeFull">{{ t('Свернуть список') }}</button
        ><button :disabled="!!pending" @click="clearFinished">{{ t('Очистить') }}</button
        ><button @click="refresh">{{ t('Обновить') }}</button>
      </div>
    </div>
    <p v-if="message" class="task-message pf-notice" role="status">{{ t(message) }}</p>
    <div v-if="showMaintenance" class="maintenance-line" role="status">
      <strong>{{ t('Переустановка:') }} {{ maintenance?.title }}</strong
      ><span>{{ t(maintenance?.message || '') }}</span
      ><button v-if="data.maintenance?.canStop" :disabled="!!pending" @click="stopReinstall">
        {{ t('Остановить переустановку') }}
      </button>
    </div>
    <section
      v-if="(categories.includes('active') && data.active.length) || activeTorrents.length"
      class="active-jobs"
      :aria-label="t('Активные задания')"
    >
      <ActiveInstallationCard
        v-for="task in categories.includes('active') ? data.active : []"
        :key="task.id"
        :task="task"
        :busy="!!pending"
        :can-pause="
          platform === 'ps5' &&
          task.transport === 'service' &&
          queueStatus === 'running' &&
          task.state === 'sending'
        "
        @pause="pauseQueue"
        @cancel="cancel"
        @confirm="confirmInstalled"
        @stop-waiting="stopWaiting"
        @remove="removeTasks([$event])"
      />
      <article v-for="item in activeTorrents" :key="item.hash" class="torrent-job active">
        <div>
          <strong>{{ item.name }}</strong
          ><span>qBittorrent · {{ Math.round(item.progress * 100) }}%</span>
        </div>
        <progress :value="item.progress" max="1" /><button @click="torrentAction(item, 'pause')">
          {{ t('Остановить') }}</button
        ><button @click="torrentAction(item, 'delete')">{{ t('Убрать задачу') }}</button>
      </article>
    </section>
    <section v-if="compactView" class="compact-queue" :aria-label="t('Следующие в очереди')">
      <p v-for="task in nextQueued" :key="task.id" class="compact-queue-row">
        <span>{{ task.title }}</span
        ><small>{{ gigabytes(task.size) }} {{ t('ГБ') }}</small>
      </p>
      <button
        v-if="data.counts.queued > nextQueued.length"
        class="compact-queue-more"
        @click="openFull()"
      >
        {{ t('Ещё в очереди:') }} {{ data.counts.queued - nextQueued.length }} ›</button
      ><button
        v-if="data.counts.completed + data.counts.failed"
        class="compact-queue-more muted"
        @click="openFull(true)"
      >
        {{ t('Завершено:') }} {{ data.counts.completed }} · {{ t('ошибки и пропуски:') }}
        {{ data.counts.failed }} ›
      </button>
      <p
        v-if="
          !data.active.length && !nextQueued.length && !data.counts.completed && !data.counts.failed
        "
        class="task-empty"
      >
        {{ t('Заданий нет.') }}
      </p>
    </section>
    <div v-if="!compactView" class="task-filters">
      <label><input v-model="showHistory" type="checkbox" /> {{ t('История попыток') }}</label>
      <div class="task-views" :aria-label="t('Вид заданий')">
        <button :aria-pressed="view === 'tree'" @click="selectView('tree')">
          {{ t('Дерево') }}</button
        ><button :aria-pressed="view === 'table'" @click="selectView('table')">
          {{ t('Таблица') }}
        </button>
      </div>
      <label
        ><input
          type="checkbox"
          :checked="categories.length === TASK_CATEGORIES.length"
          :indeterminate="categories.length > 0 && categories.length < TASK_CATEGORIES.length"
          @change="setAll(($event.target as HTMLInputElement).checked)"
        />
        {{ t('Все') }}</label
      ><label v-for="category in TASK_CATEGORIES" :key="category"
        ><input v-model="categories" :value="category" type="checkbox" /> {{ t(labels[category]) }}
        <small>{{ data.counts[category] + torrentCounts[category] }}</small></label
      >
    </div>
    <div v-if="!compactView" class="task-list" tabindex="0" :aria-label="t('Список заданий')">
      <template v-if="view === 'tree'">
        <GameTreeBranch
          v-for="group in taskGroups"
          :key="group.key"
          :title="group.title"
          :title-id="group.titleId"
          :cover="group.icon ? `/api/packages/${group.icon}?asset=icon` : undefined"
          :count="group.items.length"
          :open="treeOpen(group)"
          @toggle="treeExpanded[group.key] = !treeOpen(group)"
          ><template #actions
            ><button
              v-if="group.items.some((task) => task.canCancel)"
              :disabled="!!pending"
              @click="cancelBranch(group.items)"
            >
              {{ t('Отменить ветку') }}</button
            ><button
              v-if="group.items.some((task) => task.canCancel || task.canDismiss)"
              :disabled="!!pending"
              @click="removeTasks(group.items, true)"
            >
              {{ t('Убрать всю ветку') }}
            </button></template
          ><InstallationTaskRow
            v-for="task in group.items"
            :key="task.id"
            :task="task"
            :busy="!!pending"
            @cancel="cancel"
            @confirm="confirmInstalled"
            @stop-waiting="stopWaiting"
            @remove="removeTasks([$event])"
        /></GameTreeBranch>
      </template>
      <InstallationTaskTable
        v-else-if="data.items.length"
        :tasks="data.items"
        :busy="!!pending"
        @cancel="cancel"
        @confirm="confirmInstalled"
        @stop-waiting="stopWaiting"
        @remove="removeTasks([$event])"
      />
      <article v-for="item in otherTorrents" :key="item.hash" class="torrent-job">
        <div>
          <strong>{{ item.name }}</strong
          ><span
            >qBittorrent · {{ t(labels[torrentCategory(item)]) }} ·
            {{ Math.round(item.progress * 100) }}%</span
          >
        </div>
        <button v-if="/paused|stopped/i.test(item.state)" @click="torrentAction(item, 'resume')">
          {{ t('Продолжить') }}</button
        ><button @click="torrentAction(item, 'delete')">{{ t('Убрать задачу') }}</button>
      </article>
      <p v-if="!data.items.length && !otherTorrents.length" class="task-empty">
        {{ t('В выбранных категориях заданий нет.') }}
      </p>
    </div>
    <footer v-if="!compactView">
      <span
        >{{ t('Снимите галочку, чтобы убрать пакет из очереди') }} ·
        {{
          t(
            showHistory
              ? 'Показаны все попытки. Сохраняются 10 предыдущих очередей.'
              : 'Показана последняя попытка для каждого пакета. Предыдущие доступны в истории.',
          )
        }}</span
      >
      <div v-if="data.pages > 1">
        <button :disabled="page <= 1" @click="go(page - 1)">‹</button
        ><span
          >{{ page }} / {{ data.pages }} · {{ data.total }}
          {{ t(data.unit === 'games' ? 'игр' : 'заданий') }}</span
        ><button :disabled="page >= data.pages" @click="go(page + 1)">›</button>
      </div>
    </footer>
  </section>
</template>
<style scoped>
.compact-queue {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.compact-queue-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 0;
  padding: 8px 12px;
  border-bottom: 1px solid #5897e730;
  font-size: 12px;
}
.compact-queue-row span {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.compact-queue-row small {
  flex: none;
  color: #a6bee1;
}
.compact-queue-more {
  align-self: flex-start;
  margin-top: 6px;
  padding: 6px 12px;
  border: 0;
  background: none;
  color: #8dddff;
  font-size: 12px;
  cursor: pointer;
}
.compact-queue-more.muted {
  margin-top: 0;
  color: #a6bee1;
}
.maintenance-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
  padding: 9px 14px;
  border: 1px solid var(--pf-line);
  border-radius: 9px;
  background: #0b294980;
  font-size: 11px;
}
.maintenance-line span {
  color: #89dfff;
}
.task-views {
  display: flex;
  gap: 3px;
  padding-right: 8px;
  border-right: 1px solid var(--pf-line);
}
.task-views button {
  padding: 5px 9px;
}
.task-views button[aria-pressed='true'] {
  background: #1672a566;
  border-color: #64d6ff80;
  color: white;
}
.task-game {
  border: 1px solid var(--pf-line);
  border-radius: 12px;
  overflow: hidden;
}
.task-game-heading {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  border: 0;
  border-radius: 0;
  padding: 10px 14px;
  background: #17406a66;
}
.tree-arrow {
  width: 16px;
  font-size: 20px;
  color: #8dddff;
}
.tree-cover {
  width: 32px;
  height: 40px;
  flex: 0 0 32px;
  display: grid;
  place-items: center;
  background: linear-gradient(145deg, #23517b, #162c50);
  border-radius: 5px;
  overflow: hidden;
  font-size: 18px;
}
.tree-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tree-title {
  flex: 1;
  min-width: 0;
}
.tree-title strong {
  display: block;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.tree-title span {
  display: block;
  margin-top: 5px;
  font-size: 10px;
  color: #a6bee1;
}
.task-game-heading small {
  color: #a8dfff;
}
.task-game-packages {
  display: grid;
  gap: 6px;
  padding: 8px;
  background: #081f3990;
}
.task-game-packages :deep(.job-row) {
  padding: 10px 12px;
}
.task-game-packages :deep(.job-name p) {
  margin-top: 3px;
}
.task-child {
  margin-left: 32px;
  position: relative;
}
.task-child::before {
  content: '';
  position: absolute;
  left: -23px;
  top: -8px;
  width: 15px;
  height: 40px;
  border-left: 1px solid #5897e74d;
  border-bottom: 1px solid #5897e74d;
  border-radius: 0 0 0 5px;
}
.tasks-workspace {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  gap: 12px;
}
.task-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 15px;
}
.task-title h1 {
  margin: 0;
  font-size: 24px;
}
.task-title p {
  margin: 5px 0 0;
  color: #acbfdc;
  font-size: 12px;
}
.task-message {
  margin: 0;
  padding: 8px 12px !important;
}
.task-controls {
  display: flex;
  gap: 8px;
}
.active-jobs :deep(.job-row) {
  padding: 9px 12px;
}
.active-jobs :deep(.job-name) {
  line-height: 1.3;
}
.active-jobs :deep(.job-name span) {
  margin: 2px 0;
}
.active-jobs :deep(.job-name p) {
  margin-top: 3px;
}
.active-jobs {
  display: grid;
  gap: 8px;
  max-height: 34vh;
  overflow: auto;
  flex-shrink: 0;
}
.task-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--pf-line);
  border-radius: 12px;
  background: #0b294980;
}
.task-filters label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.task-filters small {
  color: #a6bee1;
}
input {
  accent-color: #37c9fb;
}
.task-list {
  display: grid;
  grid-auto-rows: max-content;
  align-content: start;
  gap: 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-color: #3070b6 #07172b;
  padding-right: 6px;
}
.torrent-job {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px 16px;
  border: 1px solid var(--pf-line);
  background: #071c3580;
  border-radius: 12px;
}
.torrent-job.active {
  border-color: #64d6ff66;
}
.torrent-job div {
  flex: 1;
  min-width: 0;
}
.torrent-job strong {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.torrent-job span {
  display: block;
  font:
    10px 'DM Mono',
    monospace;
  color: #a6bee1;
  margin-top: 5px;
}
progress {
  width: 120px;
  accent-color: #37c9fb;
}
button {
  border: 1px solid var(--pf-line);
  border-radius: 8px;
  padding: 8px 12px;
  background: linear-gradient(145deg, #29426475, #142b4b9e);
  color: #e6efff;
  cursor: pointer;
  font-size: 11px;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
.task-empty {
  font-size: 11px;
  color: #acbfdc;
  padding: 15px;
}
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  color: #a6bee1;
  font-size: 10px;
}
footer div {
  display: flex;
  align-items: center;
  gap: 12px;
}
</style>

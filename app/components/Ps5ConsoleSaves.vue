<script setup lang="ts">
import { browserRequestId } from '#shared/browser-request-id';
const props = defineProps<{ consoleId: string; focusTitleId?: string }>();
const request = useConsoleRequest(),
  { t, formatLocale } = useAppLocale();
const entries = ref<any[]>([]),
  copies = ref<any[]>([]),
  jobs = ref<any[]>([]),
  busy = ref(false),
  starting = ref(false),
  error = ref(''),
  query = ref(props.focusTitleId || ''),
  uncertain = ref(''),
  copiesError = ref(''),
  loaded = ref(false),
  kind = ref('all'),
  user = ref('');
const restoreJobs = ref<any[]>([]),
  restoreCap = ref(false),
  restoreError = ref(''),
  restoreDialog = ref<any>(),
  restoreTyped = ref(''),
  restoreAccepted = ref(false),
  restoring = ref(false);
let restoreTimer: ReturnType<typeof setTimeout> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false;
const users = computed(() => [...new Set(entries.value.map((row) => row.userId))].sort());
const filtered = computed(() =>
  entries.value.filter(
    (row) =>
      (kind.value === 'all' || row.kind === kind.value) &&
      (!user.value || row.userId === user.value) &&
      `${row.title} ${row.titleId} ${row.userId}`
        .toLowerCase()
        .includes(query.value.trim().toLowerCase()),
  ),
);
const saveTab = ref('console'),
  selectedSave = ref(''),
  selectedCopy = ref('');
const keyOf = (row: any) => `${row.userId}:${row.titleId}:${row.kind}`;
const selectedRow = computed(() => filtered.value.find((row) => keyOf(row) === selectedSave.value));
const filteredCopies = computed(() =>
  copies.value.filter(
    (copy) =>
      (kind.value === 'all' || copy.kind === kind.value) &&
      (!user.value || copy.userId === user.value) &&
      `${copy.titleId} ${entries.value.find((row) => row.titleId === copy.titleId)?.title || ''} ${copy.userId}`
        .toLowerCase()
        .includes(query.value.trim().toLowerCase()),
  ),
);
const detailRow = computed(() =>
  saveTab.value === 'console'
    ? selectedRow.value
    : filteredCopies.value.find((copy) => copy.id === selectedCopy.value),
);
const detailCopies = computed(() =>
  detailRow.value
    ? copies.value
        .filter((copy) => keyOf(copy) === keyOf(detailRow.value))
        .slice()
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    : [],
);
const detailCopy = computed(() =>
  saveTab.value === 'copies' ? detailRow.value : detailCopies.value[0],
);
const detailTitle = computed(
  () =>
    entries.value.find((row) => row.titleId === detailRow.value?.titleId)?.title ||
    detailRow.value?.titleId ||
    '',
);
const saveCover = (row: any) =>
  row?.cover || entries.value.find((entry) => entry.titleId === row?.titleId)?.cover;
watch(filtered, (rows) => {
  if (!rows.some((row) => keyOf(row) === selectedSave.value))
    selectedSave.value = rows[0] ? keyOf(rows[0]) : '';
});
watch(filteredCopies, (rows) => {
  if (!rows.some((row) => row.id === selectedCopy.value)) selectedCopy.value = rows[0]?.id || '';
});
const nativeCount = computed(() => entries.value.filter((row) => row.kind === 'native').length);
const hasFilters = computed(() => !!query.value || kind.value !== 'all' || !!user.value);
function resetFilters() {
  query.value = '';
  kind.value = 'all';
  user.value = '';
}
watch(
  () => props.focusTitleId,
  (value) => {
    resetFilters();
    query.value = value || '';
  },
);
function message(e: any) {
  return (
    e?.data?.message || e?.data?.statusMessage || e?.message || t('Не удалось загрузить сохранения')
  );
}
const restorationPending = computed(() =>
  restoreJobs.value.some((j) => !['confirmed', 'rolled-back', 'failed'].includes(j.state)),
);
const running = computed(
  () => jobs.value.some((job) => job.state === 'running') || restorationPending.value,
);
const bytes = (n: number) =>
  `${(n / 1048576).toLocaleString(formatLocale.value, { maximumFractionDigits: 1 })} ${t('МБ')}`;
function later() {
  if (!disposed && running.value) timer = setTimeout(() => refreshCopies().catch(() => {}), 2000);
}
async function refreshCopies() {
  if (timer) clearTimeout(timer);
  copiesError.value = '';
  try {
    const v = await request<any>('/api/ps5/management/backups', {
      method: 'POST',
      body: { consoleId: props.consoleId },
    });
    copies.value = v.backups;
    jobs.value = v.jobs;
    if (jobs.value.some((job) => job.id === uncertain.value)) uncertain.value = '';
  } catch (e: any) {
    if (!disposed) copiesError.value = message(e);
    throw e;
  } finally {
    later();
  }
}
async function loadSaves() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  loaded.value = false;
  entries.value = [];
  try {
    const [v, games] = await Promise.all([
      request<any>('/api/ps5/management/saves', {
        method: 'POST',
        body: { consoleId: props.consoleId },
      }),
      request<any>('/api/ps5/management/games', {
        method: 'POST',
        body: { consoleId: props.consoleId },
      }).catch(() => undefined),
    ]);
    if (disposed) return;
    entries.value = v.entries.map((row: any) => {
      const game = games?.entries?.find((game: any) => game.titleId === row.titleId);
      return { ...row, title: game?.title || row.title, cover: game?.cover };
    });
    loaded.value = true;
  } catch (e: any) {
    if (!disposed) error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function load() {
  await Promise.allSettled([
    loadSaves(),
    refreshCopies(),
    loadRestoreCapabilities(),
    refreshRestores(),
  ]);
}
async function backup(row: any) {
  if (starting.value || running.value || uncertain.value) return;
  starting.value = true;
  error.value = '';
  let requestId = '';
  try {
    requestId = browserRequestId();
    const job = await request<any>('/api/ps5/management/backup', {
      method: 'POST',
      body: {
        consoleId: props.consoleId,
        requestId,
        target: { userId: row.userId, titleId: row.titleId, kind: row.kind },
      },
      retry: 0,
    });
    jobs.value.unshift(job);
    later();
  } catch (e: any) {
    error.value = e?.data?.message || e.message;
    if (!requestId) return;
    uncertain.value = requestId;
    try {
      const job = await request<any>('/api/ps5/management/job', {
        method: 'POST',
        body: { consoleId: props.consoleId, requestId },
      });
      jobs.value.unshift(job);
      uncertain.value = '';
      later();
    } catch {
      /* Do not replay an uncertain accepted command. Refresh reads its persisted result. */
    }
  } finally {
    starting.value = false;
  }
}
async function download(id: string) {
  error.value = '';
  try {
    const blob = await request<Blob>('/api/ps5/management/archive', {
      method: 'POST',
      body: { consoleId: props.consoleId, id },
      responseType: 'blob',
    });
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = `PackageFlow-PS5-${id}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e: any) {
    error.value = e?.data?.message || e.message;
  }
}
async function loadRestoreCapabilities() {
  try {
    const v = await request<any>('/api/ps5/management/status', {
      method: 'POST',
      body: { consoleId: props.consoleId },
    });
    if (!disposed) restoreCap.value = v.ready === true && v.savesRestore === true;
  } catch {
    restoreCap.value = false;
  }
}
async function refreshRestores() {
  clearTimeout(restoreTimer);
  try {
    const v = await request<any>('/api/ps5/management/restores', {
      method: 'POST',
      body: { consoleId: props.consoleId },
    });
    if (!disposed) restoreJobs.value = v.jobs || [];
    for (const job of restoreJobs.value) {
      if (['checking', 'uploading', 'applying', 'uncertain'].includes(job.state)) {
        const next = await request<any>('/api/ps5/management/restore-job', {
          method: 'POST',
          body: { consoleId: props.consoleId, requestId: job.id },
        });
        if (!disposed) Object.assign(job, next);
      }
    }
  } catch (e) {
    if (!disposed) restoreError.value = message(e);
  }
  if (
    !disposed &&
    restoreJobs.value.some((j) =>
      ['checking', 'uploading', 'applying', 'uncertain'].includes(j.state),
    )
  )
    restoreTimer = setTimeout(refreshRestores, 2500);
}
function askRestore(copy: any) {
  restoreDialog.value = { copy };
  restoreTyped.value = '';
  restoreAccepted.value = false;
  restoreError.value = '';
}
function askFinish(job: any, action: string) {
  restoreDialog.value = { job, action };
  restoreTyped.value = '';
  restoreAccepted.value = false;
  restoreError.value = '';
}
async function submitRestore() {
  const target = restoreDialog.value;
  if (!target || restoring.value) return;
  const titleId = target.copy?.titleId || target.job?.target?.titleId;
  if (restoreTyped.value !== titleId || (target.action === 'finalize' && !restoreAccepted.value))
    return;
  restoring.value = true;
  restoreError.value = '';
  let requestId = target.job?.id || '';
  try {
    requestId ||= browserRequestId();
    const value = await request<any>(
      target.copy ? '/api/ps5/management/restore' : '/api/ps5/management/restore-finish',
      {
        method: 'POST',
        body: {
          consoleId: props.consoleId,
          requestId,
          backupId: target.copy?.id,
          action: target.action,
          confirmTitleId: restoreTyped.value,
        },
        retry: 0,
      },
    );
    if (!disposed) {
      restoreDialog.value = undefined;
      const old = restoreJobs.value.find((j) => j.id === value.id);
      if (old) Object.assign(old, value);
      else restoreJobs.value.unshift(value);
      await refreshRestores();
      if (['confirmed', 'rolled-back'].includes(value.state)) await loadSaves();
    }
  } catch (e) {
    if (!disposed) {
      restoreError.value = message(e);
      restoreDialog.value = undefined;
      if (!requestId) return;
      try {
        const value = await request<any>('/api/ps5/management/restore-job', {
          method: 'POST',
          body: { consoleId: props.consoleId, requestId },
        });
        const old = restoreJobs.value.find((j) => j.id === value.id);
        if (old) Object.assign(old, value);
        else restoreJobs.value.unshift(value);
      } catch {
        /* Read receipt; never replay restore. */
      }
      await refreshRestores();
    }
  } finally {
    restoring.value = false;
  }
}
const restoreLabels: Record<string, string> = {
  checking: 'Проверяем копию',
  uploading: 'Передаём копию на PS5',
  applying: 'Применяем копию',
  pending: 'Копия применена — проверьте прогресс в игре',
  uncertain: 'Результат уточняется по журналу PS5',
  confirmed: 'Восстановление подтверждено пользователем',
  'rolled-back': 'Возвращено прежнее сохранение',
  failed: 'Копия не применена',
};
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
  clearTimeout(restoreTimer);
});
</script>
<template>
  <div class="pf-ps5-saves glass-save-page">
    <header class="glass-page-heading">
      <div>
        <h1>{{ t('Сохранения') }}</h1>
        <p>{{ t('Резервное копирование и управление сохранениями') }} · PS5</p>
      </div>
      <button :disabled="busy" @click="load">{{ t(busy ? 'Загрузка…' : 'Обновить') }}</button>
    </header>
    <slot name="target" />
    <div class="save-toolbar">
      <div class="glass-tabs" :aria-label="t('Раздел сохранений')">
        <button
          :class="{ active: saveTab === 'console' }"
          :aria-pressed="saveTab === 'console'"
          @click="saveTab = 'console'"
        >
          {{ t('На консоли') }} <span>{{ entries.length }}</span></button
        ><button
          :class="{ active: saveTab === 'copies' }"
          :aria-pressed="saveTab === 'copies'"
          @click="saveTab = 'copies'"
        >
          {{ t('Резервные копии') }} <span>{{ copies.length }}</span>
        </button>
      </div>
      <details class="save-help">
        <summary>{{ t('О сохранениях') }}</summary>
        <p>
          {{
            t(
              'Сохранения PS5 и игр PS4 на выбранной PS5, для всех пользователей. Игра может быть удалена — её сохранение остаётся в списке.',
            )
          }}
        </p>
        <p>
          {{
            t(
              'Резервная копия исходных контейнеров и метаданных на компьютер с WEB. Перед копированием закройте игру.',
            )
          }}
        </p>
        <p>
          {{
            t(
              'Копия привязана к этой приставке, пользователю и игре. Восстановление заменяет существующие слоты; перенос на другую PS5 или профиль не поддерживается.',
            )
          }}
        </p>
      </details>
    </div>
    <div class="pf-controls">
      <input
        v-model="query"
        type="search"
        :aria-label="t('Поиск сохранений')"
        :placeholder="t('Название, Title ID или пользователь')"
      /><select v-model="kind" :aria-label="t('Платформа сохранения')">
        <option value="all">{{ t('Все платформы') }}</option>
        <option value="native">PS5</option>
        <option value="legacy">PS4</option></select
      ><select v-model="user" :aria-label="t('Пользователь сохранения')">
        <option value="">{{ t('Все пользователи') }}</option>
        <option v-for="id in users" :key="id" :value="id">{{ id }}</option></select
      ><button v-if="hasFilters" @click="resetFilters">{{ t('Сбросить фильтры') }}</button>
    </div>
    <p v-if="error" class="glass-notice error" role="alert">{{ t(error) }}</p>
    <p v-if="restoreError" class="glass-notice error" role="alert">{{ t(restoreError) }}</p>
    <p v-if="copiesError" class="glass-notice error" role="alert">
      {{ t('Не удалось загрузить резервные копии') }}: {{ t(copiesError) }}
    </p>
    <p v-if="uncertain" class="glass-notice" role="status">
      {{
        t(
          'Ответ команды не получен. Обновите список для проверки результата; команда повторно не отправляется.',
        )
      }}
    </p>
    <div class="save-layout">
      <div class="glass-table-wrap glass-surface">
        <table
          class="glass-table save-table"
          :class="{ 'is-empty': saveTab === 'console' ? !filtered.length : !filteredCopies.length }"
        >
          <thead>
            <tr>
              <th></th>
              <th>{{ t('Игра') }}</th>
              <th>{{ t('Профиль') }}</th>
              <th>{{ t(saveTab === 'copies' ? 'Дата копии' : 'Платформа') }}</th>
              <th>{{ t(saveTab === 'copies' ? 'Размер' : 'Копии') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-if="saveTab === 'console'"
              ><tr
                v-for="row in filtered"
                :key="keyOf(row)"
                :class="{ selected: selectedSave === keyOf(row) }"
              >
                <td>
                  <input
                    v-model="selectedSave"
                    type="radio"
                    :value="keyOf(row)"
                    :aria-label="`${t('Выбрать')}: ${row.title} · ${row.userId}`"
                  />
                </td>
                <td>
                  <button class="save-title" @click="selectedSave = keyOf(row)">
                    <GlassArtwork :title="row.title" :cover="saveCover(row)" /><span
                      ><strong>{{ row.title }}</strong
                      ><small>{{ row.titleId }}</small></span
                    >
                  </button>
                </td>
                <td>{{ row.userId }}</td>
                <td><ContentTags :platform="row.kind === 'native' ? 'ps5' : 'ps4'" /></td>
                <td>{{ copies.filter((copy) => keyOf(copy) === keyOf(row)).length }}</td>
              </tr></template
            >
            <template v-else
              ><tr
                v-for="copy in filteredCopies"
                :key="copy.id"
                :class="{ selected: selectedCopy === copy.id }"
              >
                <td>
                  <input
                    v-model="selectedCopy"
                    type="radio"
                    :value="copy.id"
                    :aria-label="`${t('Выбрать копию')}: ${copy.titleId} · ${copy.userId}`"
                  />
                </td>
                <td>
                  <button class="save-title" @click="selectedCopy = copy.id">
                    <GlassArtwork
                      :title="
                        entries.find((row) => row.titleId === copy.titleId)?.title || copy.titleId
                      "
                      :cover="saveCover(copy)"
                    /><span
                      ><strong>{{
                        entries.find((row) => row.titleId === copy.titleId)?.title || copy.titleId
                      }}</strong
                      ><small>{{ copy.titleId }}</small></span
                    >
                  </button>
                </td>
                <td>{{ copy.userId }}</td>
                <td>{{ new Date(copy.createdAt).toLocaleString(formatLocale) }}</td>
                <td>{{ bytes(copy.bytes) }}</td>
              </tr></template
            >
            <tr v-if="saveTab === 'console' ? !filtered.length : !filteredCopies.length">
              <td colspan="5" class="glass-empty">
                <span class="empty-symbol" aria-hidden="true">▤</span
                ><strong>{{
                  t(
                    busy
                      ? 'Читаем сохранения с выбранной PS5…'
                      : !loaded && saveTab === 'console'
                        ? 'Список сохранений недоступен'
                        : hasFilters
                          ? 'Сохранения не подходят под выбранные фильтры.'
                          : saveTab === 'copies'
                            ? 'Резервных копий пока нет'
                            : 'Сохранения не найдены.',
                  )
                }}</strong
                ><button v-if="hasFilters" @click="resetFilters">
                  {{ t('Показать все сохранения') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <aside class="save-inspector glass-surface">
        <template v-if="detailRow"
          ><div class="inspector-title">
            <GlassArtwork :title="detailTitle" :cover="saveCover(detailRow)" />
            <div>
              <h2>{{ detailTitle }}</h2>
              <ContentTags :platform="detailRow.kind === 'native' ? 'ps5' : 'ps4'" />
            </div>
          </div>
          <dl>
            <dt>Title ID</dt>
            <dd>{{ detailRow.titleId }}</dd>
            <dt>{{ t('Профиль') }}</dt>
            <dd>{{ detailRow.userId }}</dd>
            <dt>{{ t('Резервные копии') }}</dt>
            <dd>{{ detailCopies.length }}</dd>
            <template v-if="detailCopy"
              ><dt>{{ t('Дата копии') }}</dt>
              <dd>{{ new Date(detailCopy.createdAt).toLocaleString(formatLocale) }}</dd>
              <dt>{{ t('Размер копии') }}</dt>
              <dd>{{ bytes(detailCopy.bytes) }}</dd>
              <dt>{{ t('Файлов') }}</dt>
              <dd>{{ detailCopy.files }}</dd></template
            >
          </dl>
          <div class="inspector-actions">
            <button
              v-if="saveTab === 'console'"
              class="primary"
              :disabled="busy || starting || running || !!uncertain"
              @click="backup(detailRow)"
            >
              ↑ {{ t(starting ? 'Копирование' : 'Создать копию') }}</button
            ><button
              :disabled="!detailCopy || !restoreCap || running || starting || restoring"
              @click="detailCopy && askRestore(detailCopy)"
            >
              ↶ {{ t('Восстановить') }}</button
            ><button :disabled="!detailCopy" @click="detailCopy && download(detailCopy.id)">
              ↓ {{ t('Скачать ZIP') }}
            </button>
          </div>
          <p v-if="!restoreCap" class="workspace-footnote">
            {{
              t(
                'Для восстановления требуется обновлённый ELF с подтверждённой поддержкой на этой PS5.',
              )
            }}
          </p>
          <p v-else class="workspace-footnote">
            {{ t('Перед копированием и восстановлением закройте игру.') }}
          </p>
          <label
            v-if="saveTab === 'console' && detailCopies.length > 1"
            class="inspector-copy-picker"
            >{{ t('Все копии')
            }}<select
              @change="
                selectedCopy = ($event.target as HTMLSelectElement).value;
                saveTab = 'copies';
              "
            >
              <option disabled selected>{{ t('Выберите копию') }}</option>
              <option v-for="copy in detailCopies" :key="copy.id" :value="copy.id">
                {{ new Date(copy.createdAt).toLocaleString(formatLocale) }} ·
                {{ bytes(copy.bytes) }}
              </option>
            </select></label
          ></template
        >
        <div v-else class="glass-empty">
          <span class="empty-symbol" aria-hidden="true">▤</span
          ><strong>{{ t('Выберите сохранение') }}</strong
          ><span>{{ t('Здесь появятся сведения и доступные действия.') }}</span>
        </div>
      </aside>
    </div>
    <small v-if="loaded" class="workspace-footnote"
      >{{ t('Показано') }} {{ filtered.length }} / {{ entries.length }} · PS5: {{ nativeCount }} ·
      PS4: {{ entries.length - nativeCount }}</small
    >
    <section v-if="restoreJobs.length">
      <h2>{{ t('Восстановление сохранений') }}</h2>
      <article v-for="job in restoreJobs" :key="job.id">
        <div>
          <strong>{{ job.target.titleId }} · {{ job.target.userId }}</strong>
          <p>{{ t(restoreLabels[job.state] || job.state) }}</p>
          <p v-if="['checking', 'uploading', 'applying'].includes(job.state)">
            {{ bytes(job.state === 'checking' ? job.checked : job.bytes) }} / {{ bytes(job.total) }}
          </p>
          <progress
            v-if="['checking', 'uploading'].includes(job.state)"
            :value="job.state === 'checking' ? job.checked : job.bytes"
            :max="job.total || 1"
          /><small v-if="job.message">{{ t(job.message) }}</small>
          <p v-if="job.state === 'pending'">
            {{
              t(
                'Запустите игру и проверьте сохранённый прогресс. Затем закройте её и подтвердите результат или верните прежние файлы. До этого исходные файлы сохраняются для отката.',
              )
            }}
          </p>
        </div>
        <div class="restore-actions">
          <template v-if="['pending', 'uncertain'].includes(job.state)"
            ><button :disabled="restoring" @click="askFinish(job, 'rollback')">
              {{ t('Откатить') }}</button
            ><button
              :disabled="restoring || job.state !== 'pending'"
              @click="askFinish(job, 'finalize')"
            >
              {{ t('Прогресс проверен') }}</button
            ><button @click="refreshRestores">{{ t('Проверить результат') }}</button></template
          >
        </div>
      </article>
    </section>
    <section v-if="jobs.length">
      <h2>{{ t('Задания копирования') }}</h2>
      <article v-for="job in jobs" :key="job.id">
        <div>
          <strong>{{ job.target.titleId }} · {{ job.target.userId }}</strong>
          <p>
            {{
              t(
                job.state === 'complete'
                  ? 'Копия проверена'
                  : job.state === 'failed'
                    ? 'Ошибка копирования'
                    : 'Копирование',
              )
            }}
            · {{ bytes(job.bytes) }} / {{ bytes(job.total) }}
          </p>
          <progress v-if="job.state === 'running'" :value="job.bytes" :max="job.total || 1" /><small
            v-if="job.message"
            >{{ t(job.message) }}</small
          >
        </div>
      </article>
    </section>
    <div
      v-if="restoreDialog"
      class="restore-backdrop"
      @click.self="!restoring && (restoreDialog = undefined)"
    >
      <section
        class="restore-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-restore-heading"
      >
        <h2 id="save-restore-heading">
          {{
            t(
              restoreDialog.copy
                ? 'Восстановить сохранение'
                : restoreDialog.action === 'rollback'
                  ? 'Вернуть прежнее сохранение'
                  : 'Подтвердить восстановление',
            )
          }}
        </h2>
        <p>
          {{ restoreDialog.copy?.titleId || restoreDialog.job.target.titleId }} ·
          {{ restoreDialog.copy?.userId || restoreDialog.job.target.userId }}
        </p>
        <p v-if="restoreDialog.copy">
          {{
            t(
              'Закройте игру. Текущие файлы будут заменены копией; прежние останутся на PS5 до подтверждения или отката.',
            )
          }}
        </p>
        <p v-else-if="restoreDialog.action === 'rollback'">
          {{
            t(
              'Закройте игру. Вернутся файлы, которые были до восстановления; новый прогресс после восстановления будет потерян.',
            )
          }}
        </p>
        <p v-else>
          {{
            t(
              'Закройте игру. После подтверждения прежние файлы для отката будут удалены. Резервная копия в WEB остаётся.',
            )
          }}
        </p>
        <label v-if="restoreDialog.action === 'finalize'"
          ><input v-model="restoreAccepted" type="checkbox" />{{
            t('Игра загрузила нужный сохранённый прогресс')
          }}</label
        ><label
          >{{ t('Введите Title ID для подтверждения')
          }}<input v-model="restoreTyped" autocomplete="off" spellcheck="false"
        /></label>
        <div class="restore-actions">
          <button :disabled="restoring" @click="restoreDialog = undefined">{{ t('Отмена') }}</button
          ><button
            :disabled="
              restoring ||
              restoreTyped !== (restoreDialog.copy?.titleId || restoreDialog.job.target.titleId) ||
              (restoreDialog.action === 'finalize' && !restoreAccepted)
            "
            @click="submitRestore"
          >
            {{ t(restoring ? 'Отправляем…' : 'Подтвердить') }}
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
<style scoped>
.pf-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 16px 0;
}
.pf-save-game {
  margin: 18px 0;
  border: 1px solid #34323e;
  border-radius: 12px;
  overflow: hidden;
}
.pf-save-game h2 {
  font-size: 1rem;
  margin: 0;
  padding: 14px;
  background: #24212d;
}
.pf-save-game h2 small {
  margin-left: 8px;
  font-size: 0.8rem;
  font-weight: 400;
}
.pf-save-game article:last-child {
  border-bottom: 0;
}
.pf-controls input {
  flex: 1;
  min-width: 0;
}
.pf-ps5-saves article {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-bottom: 1px solid #34323e;
}
.pf-ps5-saves article > div {
  flex: 1;
  min-width: 0;
}
.pf-ps5-saves p,
.pf-ps5-saves small {
  color: #aaa5b9;
  overflow-wrap: anywhere;
}
.pf-ps5-saves article p {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.pf-ps5-saves progress {
  width: 100%;
  accent-color: #9472d8;
}
.pf-ps5-saves input,
.pf-ps5-saves select,
.pf-ps5-saves button {
  font: inherit;
  color: #eee9f6;
  background: #282430;
  border: 1px solid #494050;
  border-radius: 8px;
  padding: 9px 12px;
}
.pf-ps5-saves input {
  background: #18151e;
}
.pf-ps5-saves button {
  cursor: pointer;
}
.pf-ps5-saves button:hover:not(:disabled) {
  background: #403151;
  border-color: #9472d8;
}
.pf-ps5-saves button:disabled {
  opacity: 0.5;
  cursor: default;
}
.pf-ps5-saves :is(input, select, button):focus-visible {
  outline: 2px solid #b495ed;
  outline-offset: 2px;
}
.pf-ps5-saves [role='alert'] {
  color: #f1a5b8;
}
@media (max-width: 680px) {
  .pf-controls input {
    flex-basis: 100%;
  }
  .pf-ps5-saves article {
    flex-wrap: wrap;
  }
  .pf-save-game h2 small {
    display: block;
    margin: 6px 0 0;
  }
}
.restore-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.restore-backdrop {
  position: fixed;
  inset: 0;
  background: #000b;
  z-index: 30;
  display: grid;
  place-items: center;
  padding: 20px;
}
.restore-dialog {
  width: min(100%, 570px);
  max-height: 85vh;
  overflow: auto;
  background: #251e2e;
  border: 1px solid #75548e;
  border-radius: 16px;
  padding: 25px;
}
.restore-dialog label {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 16px 0;
  color: #cdbadd;
}
.restore-dialog label:has(input[type='checkbox']) {
  flex-direction: row;
  align-items: center;
}
</style>

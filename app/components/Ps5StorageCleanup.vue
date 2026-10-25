<script setup lang="ts">
/* Leftovers the PS5 service created itself. The service decides what is
 * removable and checks every item again before deleting it; this page lists,
 * asks for confirmation and shows the receipt. Games and saves are never listed. */
interface Item {
  id: string;
  kind: string;
  bytes: number;
  modifiedAt: number;
  titleId: string;
  title?: string;
  removable: boolean;
  reason: string;
}
interface Result {
  requestId: string;
  state: 'completed' | 'unconfirmed';
  freedBytes: number | null;
  freeBytesAfter?: number;
  items: { id: string; state: string; reason: string; freedBytes: number | null }[];
}
interface Inventory {
  supported: boolean;
  complete?: boolean;
  freeBytes?: number;
  items?: Item[];
  pending?: boolean;
  last?: Result;
}
const props = defineProps<{ consoleId: string }>();
const { t, formatLocale } = useAppLocale();
const data = ref<Inventory | null>(null),
  busy = ref(false),
  running = ref(false),
  error = ref(''),
  done = ref<Result | null>(null),
  selected = ref<string[]>([]);
const kinds: Record<string, string> = {
  'transfer-partial': 'Недокачанная передача',
  'staged-folder': 'Неопубликованная папка Folder',
  'staged-image': 'Неопубликованный образ',
  'installer-leftover': 'Остаток после установки',
  'orphan-registration': 'Игра без файлов (недоустановленная)',
};
const reasons: Record<string, string> = {
  stale_owned: 'Можно удалить',
  recently_modified: 'Изменялось меньше 2 минут назад',
  operation_active: 'Служба сейчас выполняет операцию',
  intent_present: 'Уже передано на установку или публикацию',
  file_busy: 'Файл занят',
  ownership_unproven: 'Не доказано, что файл создан PackageFlow',
  unsafe_entry: 'Небезопасная структура файлов',
  unsafe_checkpoint: 'Небезопасная структура файлов',
  unsafe_or_incomplete_tree: 'Небезопасная или неполная структура файлов',
  completion_unconfirmed: 'Установка не подтверждена',
  installer_not_complete: 'Установщик ещё не закончил',
  install_outcome_unknown: 'Результат установки неизвестен',
  registration_or_source_present: 'Игра зарегистрирована или её файлы на месте',
  registration_unavailable: 'Сведения о регистрации недоступны',
  registration_ownership_unproven: 'Не доказано, что регистрацию создал PackageFlow',
  source_changed: 'Файлы изменились. Обновите список',
  metadata_changed: 'Файлы изменились. Обновите список',
  ownership_changed: 'Файлы изменились. Обновите список',
  publication_started: 'Публикация уже начата',
  metadata_unavailable: 'Состояние не прочитано',
  intent_unavailable: 'Состояние не прочитано',
  cleanup_state_unavailable: 'Состояние не прочитано',
  cleanup_already_attempted: 'Очистка уже выполнялась, результат неизвестен',
  queue_active: 'Передача текущей очереди. Удалится после её завершения или отмены',
  removed: 'Удалено',
  title_confirmation_required: 'Нужно подтверждение Title ID',
  scan_unavailable: 'PS5 не смогла проверить элемент',
  removal_refused: 'PS5 отказалась удалять',
  partial_failure: 'Удалено не полностью',
  stale_or_missing: 'Уже нет или изменилось',
  outcome_unknown: 'Результат неизвестен',
};
const gib = (bytes: number) =>
  bytes < 1024 ** 3
    ? `${Math.ceil(bytes / 1024 ** 2).toLocaleString(formatLocale.value)} ${t('МБ')}`
    : `${(bytes / 1024 ** 3).toLocaleString(formatLocale.value, { maximumFractionDigits: 2 })} ${t('ГБ')}`;
const age = (seconds: number) => {
  const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
  return minutes < 60
    ? `${minutes} ${t('мин')}`
    : minutes < 2880
      ? `${Math.round(minutes / 60)} ${t('ч')}`
      : `${Math.round(minutes / 1440)} ${t('дн.')}`;
};
// An orphan registration can only be confirmed by its Title ID.
const selectable = (item: Item) =>
  item.removable && (item.kind !== 'orphan-registration' || !!item.titleId);
const items = computed(() => data.value?.items || []);
const chosen = computed(() => items.value.filter((item) => selected.value.includes(item.id)));
const freeable = computed(() =>
  items.value.filter(selectable).reduce((sum, item) => sum + item.bytes, 0),
);
async function load() {
  busy.value = true;
  error.value = '';
  try {
    data.value = await $fetch<Inventory>('/api/ps5/management/cleanup', {
      method: 'POST',
      body: { consoleId: props.consoleId },
    });
    const ids = new Set(items.value.filter(selectable).map((item) => item.id));
    selected.value = selected.value.filter((id) => ids.has(id));
  } catch (e: any) {
    error.value = e?.data?.message || 'Не удалось прочитать список с PS5';
  } finally {
    busy.value = false;
  }
}
function toggle(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((value) => value !== id)
    : [...selected.value, id];
}
function selectAll() {
  selected.value = items.value.filter(selectable).map((item) => item.id);
}
async function run() {
  const picked = chosen.value;
  if (!picked.length || running.value) return;
  const orphans = picked.filter((item) => item.kind === 'orphan-registration');
  const message =
    `${t('Удалить выбранное с PS5?')} ${picked.length} · ${gib(picked.reduce((s, i) => s + i.bytes, 0))}.\n` +
    t('Установленные игры и сохранения не затрагиваются.') +
    (orphans.length
      ? `\n\n${t('Будет снята регистрация игр без файлов:')}\n` +
        orphans.map((item) => `${item.titleId} ${item.title || ''}`.trim()).join('\n')
      : '');
  if (!window.confirm(message)) return;
  running.value = true;
  error.value = '';
  done.value = null;
  const merged: Result = {
    requestId: '',
    state: 'completed',
    freedBytes: 0,
    items: [],
  };
  try {
    // The service takes at most 16 items per request.
    for (let offset = 0; offset < picked.length; offset += 16) {
      const batch = picked.slice(offset, offset + 16);
      const titles = [
        ...new Set(
          batch.filter((item) => item.kind === 'orphan-registration').map((i) => i.titleId),
        ),
      ];
      const answer = await $fetch<{ pending: boolean; last?: Result }>(
        '/api/ps5/management/cleanup-run',
        {
          method: 'POST',
          body: { consoleId: props.consoleId, ids: batch.map((i) => i.id), confirmTitles: titles },
        },
      );
      if (answer.pending || !answer.last) {
        merged.state = 'unconfirmed';
        break;
      }
      merged.items.push(...answer.last.items);
      if (answer.last.state === 'unconfirmed') merged.state = 'unconfirmed';
      merged.freedBytes =
        merged.freedBytes === null || answer.last.freedBytes === null
          ? null
          : merged.freedBytes + answer.last.freedBytes;
      if (answer.last.freeBytesAfter !== undefined)
        merged.freeBytesAfter = answer.last.freeBytesAfter;
    }
    done.value = merged;
    selected.value = [];
  } catch (e: any) {
    error.value = e?.data?.message || 'Очистка не выполнена';
  } finally {
    running.value = false;
    await load();
  }
}
const titleOf = (id: string) => {
  const item = items.value.find((entry) => entry.id === id);
  return item ? item.title || item.titleId || t(kinds[item.kind] || item.kind) : id.slice(0, 8);
};
onMounted(load);
</script>
<template>
  <section class="storage-cleanup">
    <p v-if="busy && !data" role="status">{{ t('Ищем остатки на PS5…') }}</p>
    <p v-else-if="data && !data.supported" class="notice">
      {{
        t(
          'Очистка доступна со службой PS5 030j и новее. Обновите службу: «Устройства» → «Сервис ▾» → «Проверить обновления».',
        )
      }}
    </p>
    <template v-else-if="data">
      <div class="cleanup-summary">
        <span v-if="data.freeBytes !== undefined"
          >{{ t('Свободно на PS5:') }} <b>{{ gib(data.freeBytes) }}</b></span
        ><span
          >{{ t('Можно освободить:') }} <b>{{ gib(freeable) }}</b></span
        ><button :disabled="busy || running" @click="load">
          {{ t(busy ? 'Проверяем…' : 'Обновить') }}
        </button>
      </div>
      <p class="cleanup-hint">
        {{
          t(
            'Здесь только то, что оставила сама служба PackageFlow: недокачанные передачи, неопубликованные Folder и образы, остатки после установки и игры без файлов. Установленные игры и сохранения сюда не попадают.',
          )
        }}
      </p>
      <p v-if="!data.complete" class="notice">
        {{
          t(
            'Список неполный: часть старых файлов PS5 не смогла проверить. Их нельзя удалить отсюда, это защищает ваши игры.',
          )
        }}
      </p>
      <p v-if="data.pending" class="notice warning">
        {{
          t(
            'Результат прежней очистки ещё не подтверждён PS5. Повторно она не отправляется; обновите список позже.',
          )
        }}
      </p>
      <p v-if="error" class="error" role="alert">{{ t(error) }}</p>
      <section v-if="done" class="notice" role="status">
        <strong>{{
          t(done.state === 'completed' ? 'Очистка завершена' : 'Результат очистки не подтверждён')
        }}</strong>
        <span v-if="done.freedBytes !== null">
          · {{ t('освобождено') }} {{ gib(done.freedBytes) }}</span
        >
        <ul v-if="done.items.some((item) => item.state !== 'removed')">
          <li
            v-for="item in done.items.filter((entry) => entry.state !== 'removed')"
            :key="item.id"
          >
            {{ titleOf(item.id) }}: {{ t(reasons[item.reason] || item.reason || item.state) }}
          </li>
        </ul>
      </section>
      <p v-if="!items.length" class="cleanup-empty">{{ t('Мусора не найдено.') }}</p>
      <template v-else>
        <div class="cleanup-actions">
          <button :disabled="running || !items.some(selectable)" @click="selectAll">
            {{ t('Выбрать всё доступное') }}</button
          ><button class="danger" :disabled="running || !chosen.length" @click="run">
            {{ t(running ? 'Удаляем…' : 'Удалить выбранное') }}
            <template v-if="chosen.length"
              >({{ chosen.length }} · {{ gib(chosen.reduce((s, i) => s + i.bytes, 0)) }})</template
            >
          </button>
        </div>
        <table class="cleanup-table">
          <thead>
            <tr>
              <th />
              <th>{{ t('Что') }}</th>
              <th>{{ t('Игра') }}</th>
              <th class="num">{{ t('Размер') }}</th>
              <th>{{ t('Изменено') }}</th>
              <th>{{ t('Состояние') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="item.id" :class="{ blocked: !selectable(item) }">
              <td>
                <input
                  type="checkbox"
                  :disabled="!selectable(item) || running"
                  :checked="selected.includes(item.id)"
                  :aria-label="t('Выбрать')"
                  @change="toggle(item.id)"
                />
              </td>
              <td>{{ t(kinds[item.kind] || item.kind) }}</td>
              <td>
                {{ item.title || item.titleId || '—'
                }}<small v-if="item.title && item.titleId"> {{ item.titleId }}</small>
              </td>
              <td class="num">{{ gib(item.bytes) }}</td>
              <td>{{ age(item.modifiedAt) }}</td>
              <td>
                {{
                  t(
                    item.kind === 'orphan-registration' && item.removable && !item.titleId
                      ? 'Title ID неизвестен'
                      : reasons[item.reason] || item.reason,
                  )
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </template>
    </template>
    <p v-else-if="error" class="error" role="alert">{{ t(error) }}</p>
  </section>
</template>
<style scoped>
.storage-cleanup {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cleanup-summary,
.cleanup-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 18px;
  font-size: 13px;
}
.cleanup-summary button {
  margin-left: auto;
}
.cleanup-hint {
  margin: 0;
  color: #a6bee1;
  font-size: 12px;
}
.cleanup-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.cleanup-table th,
.cleanup-table td {
  padding: 8px 10px;
  border-bottom: 1px solid #5897e730;
  text-align: left;
}
.cleanup-table th {
  color: #a6bee1;
  font-weight: 500;
}
.cleanup-table .num {
  text-align: right;
  white-space: nowrap;
}
.cleanup-table small {
  color: #a6bee1;
}
.cleanup-table tr.blocked td {
  color: #8ea3c4;
}
.cleanup-empty {
  color: #a6bee1;
}
.danger {
  background: #6620404a;
  color: #ff9bb2;
  border: 1px solid #ba59756b;
}
</style>

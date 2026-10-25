import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createError } from 'h3';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { getConsoleProfile, ps5OperationRequest, ps5ServiceRequest } from './console-profiles';
import { ps5TransferRecord } from './ps5-installation-queue';
import { logEvent } from './event-log';

/* Leftovers the PS5 service itself created (service 030j+, storage-cleanup v1):
 * partial transfers, unpublished Folder/image staging, installer leftovers and
 * own registrations without files. The service decides what is removable and
 * rescans every selected item before deleting it; WEB only lists, asks and
 * reconciles. A request is recorded here before it is sent, and an unknown
 * outcome is only ever read back by its requestId, never sent again. */

const KINDS = [
  'transfer-partial',
  'staged-folder',
  'staged-image',
  'installer-leftover',
  'orphan-registration',
] as const;
export type Ps5CleanupKind = (typeof KINDS)[number];
export interface Ps5CleanupItem {
  id: string;
  kind: Ps5CleanupKind;
  bytes: number;
  modifiedAt: number;
  titleId: string;
  title?: string;
  removable: boolean;
  reason: string;
}
export interface Ps5CleanupResult {
  requestId: string;
  state: 'completed' | 'unconfirmed';
  freedBytes: number | null;
  freeBytesAfter?: number;
  items: { id: string; state: string; reason: string; freedBytes: number | null }[];
  finishedAt: number;
}
interface Journal {
  pending?: { requestId: string; ids: string[]; confirmTitles: string[]; startedAt: number };
  last?: Ps5CleanupResult;
}

const hex = (value: unknown, length: number) =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const titleIdPattern = /^(CUSA|PPSA)\d{5}$/;
const journalPath = (id: string) => dataPath('consoles', id, 'ps5-storage-cleanup.json');
function readJournal(id: string): Journal {
  if (!existsSync(journalPath(id))) return {};
  try {
    return JSON.parse(readFileSync(journalPath(id), 'utf8'));
  } catch {
    // A damaged journal must not hide an unknown request: refuse new work.
    throw createError({
      statusCode: 500,
      message: 'Журнал очистки PS5 повреждён. Новая очистка не начата',
    });
  }
}
const writeJournal = (id: string, journal: Journal) => writeDurableJson(journalPath(id), journal);

function profileFor(consoleId: unknown) {
  const p = getConsoleProfile(consoleId);
  if (p.platform !== 'ps5') throw createError({ statusCode: 400, message: 'Выберите PS5' });
  return p;
}

function parseItem(raw: any): Ps5CleanupItem | undefined {
  if (
    !raw ||
    !hex(raw.id, 64) ||
    !KINDS.includes(raw.kind) ||
    !Number.isSafeInteger(raw.bytes) ||
    raw.bytes < 0 ||
    !Number.isSafeInteger(raw.modifiedAt) ||
    typeof raw.removable !== 'boolean' ||
    typeof raw.reason !== 'string' ||
    !/^[a-z_]{1,48}$/.test(raw.reason)
  )
    return;
  return {
    id: raw.id,
    kind: raw.kind,
    bytes: raw.bytes,
    modifiedAt: raw.modifiedAt,
    titleId: typeof raw.titleId === 'string' && titleIdPattern.test(raw.titleId) ? raw.titleId : '',
    removable: raw.removable,
    reason: raw.reason,
    ...(hex(raw.transferId, 32) ? { transferId: raw.transferId } : {}),
  } as Ps5CleanupItem & { transferId?: string };
}

function parseResult(body: any, requestId: string): Ps5CleanupResult | undefined {
  if (
    body?.schemaVersion !== 1 ||
    body.requestId !== requestId ||
    !Array.isArray(body.items) ||
    !['completed', 'unconfirmed'].includes(body.state)
  )
    return;
  return {
    requestId,
    state: body.state,
    freedBytes: Number.isSafeInteger(body.freedBytes) ? body.freedBytes : null,
    ...(body.freeBytesKnown === true && Number.isSafeInteger(body.freeBytesAfter)
      ? { freeBytesAfter: body.freeBytesAfter }
      : {}),
    items: body.items
      .filter((item: any) => hex(item?.id, 64))
      .map((item: any) => ({
        id: item.id,
        state: ['removed', 'refused', 'not_found', 'unconfirmed'].includes(item.state)
          ? item.state
          : 'unconfirmed',
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 48) : '',
        freedBytes: Number.isSafeInteger(item.freedBytes) ? item.freedBytes : null,
      })),
    finishedAt: Date.now(),
  };
}

/** Read back the receipt of a request whose answer was lost. Never resends it. */
async function reconcile(consoleId: string, journal: Journal) {
  const pending = journal.pending;
  if (!pending) return journal;
  let answer;
  try {
    answer = await ps5OperationRequest(consoleId, '/api/v1/storage/cleanup', {
      'X-PackageFlow-Request-Id': pending.requestId,
    });
  } catch {
    return journal; // Still unknown; try again later.
  }
  if (answer.status === 200) {
    const result = parseResult(answer.body, pending.requestId);
    if (!result) return journal;
    journal = { last: result };
  } else if (answer.status === 404) {
    // The service recorded no intent: nothing was started. A new selection is
    // rescanned, and the service never repeats an item it has already claimed.
    journal = {
      last: {
        requestId: pending.requestId,
        state: 'unconfirmed',
        freedBytes: null,
        items: [],
        finishedAt: Date.now(),
      },
    };
  } else return journal;
  writeJournal(consoleId, journal);
  return journal;
}

export async function ps5CleanupInventory(consoleId: unknown) {
  const p = profileFor(consoleId);
  const capabilities = await ps5ServiceRequest(p.ip, '/api/v1/capabilities').catch(() => null);
  if (capabilities?.status !== 200 || capabilities.body?.capabilities?.storageCleanup !== true)
    return { supported: false as const };
  const journal = await reconcile(p.id, readJournal(p.id));
  const answer = await ps5OperationRequest(p.id, '/api/v1/storage/cleanup');
  if (
    answer.status !== 200 ||
    answer.body?.schemaVersion !== 1 ||
    !Array.isArray(answer.body.items)
  )
    throw createError({ statusCode: 502, message: 'PS5 не вернула список для очистки' });
  const items = (answer.body.items as unknown[])
    .map(parseItem)
    .filter((item): item is Ps5CleanupItem & { transferId?: string } => !!item)
    .map(({ transferId, ...item }: Ps5CleanupItem & { transferId?: string }) => {
      const record = transferId ? ps5TransferRecord(p.id, transferId) : undefined;
      return {
        ...item,
        titleId: item.titleId || record?.titleId || '',
        ...(record?.title ? { title: record.title } : {}),
        // A transfer the current queue may still resume stays until the queue ends.
        ...(record?.open ? { removable: false, reason: 'queue_active' } : {}),
      };
    });
  return {
    supported: true as const,
    complete: answer.body.complete === true,
    ...(answer.body.freeBytesKnown === true && Number.isSafeInteger(answer.body.freeBytes)
      ? { freeBytes: answer.body.freeBytes as number }
      : {}),
    items,
    pending: !!journal.pending,
    last: journal.last,
  };
}

export async function ps5CleanupRun(consoleId: unknown, ids: unknown, confirmTitles: unknown) {
  const p = profileFor(consoleId);
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 16 ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => hex(id, 64))
  )
    throw createError({ statusCode: 400, message: 'Выберите от 1 до 16 элементов' });
  const titles = Array.isArray(confirmTitles) ? confirmTitles : [];
  if (
    titles.length > 16 ||
    new Set(titles).size !== titles.length ||
    !titles.every((title) => typeof title === 'string' && titleIdPattern.test(title))
  )
    throw createError({ statusCode: 400, message: 'Неверное подтверждение Title ID' });
  let journal = await reconcile(p.id, readJournal(p.id));
  if (journal.pending)
    throw createError({
      statusCode: 409,
      message: 'Результат прежней очистки ещё не подтверждён PS5. Повторите позже',
    });
  const requestId = randomBytes(16).toString('hex');
  journal = {
    ...journal,
    pending: { requestId, ids, confirmTitles: titles, startedAt: Date.now() },
  };
  writeJournal(p.id, journal); // Recorded before anything is sent.
  let answer;
  try {
    answer = await ps5OperationRequest(
      p.id,
      '/api/v1/storage/cleanup',
      {},
      new TextEncoder().encode(
        JSON.stringify({ requestId, ids, ...(titles.length ? { confirmTitles: titles } : {}) }),
      ),
      undefined,
      undefined,
      { method: 'POST' },
    );
  } catch {
    journal = await reconcile(p.id, journal);
    return { pending: !!journal.pending, last: journal.last };
  }
  const result = answer.status === 200 ? parseResult(answer.body, requestId) : undefined;
  if (!result) {
    if (answer.status >= 400 && answer.status < 500 && answer.status !== 409) {
      // Refused before any intent (malformed or unauthorized): nothing started.
      writeJournal(p.id, { last: journal.last });
      throw createError({
        statusCode: 409,
        message: `PS5 отклонила очистку (${answer.status})`,
      });
    }
    journal = await reconcile(p.id, journal);
    return { pending: !!journal.pending, last: journal.last };
  }
  writeJournal(p.id, { last: result });
  logEvent(
    'info',
    `PS5 ${p.ip}: очистка — удалено ${result.items.filter((i) => i.state === 'removed').length} из ${ids.length}`,
  );
  return { pending: false, last: result };
}

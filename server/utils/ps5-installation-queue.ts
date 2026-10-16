import { assertNoConsoleSpeedTest } from './console-speed-lock';
import { ps5PkgQueueSupported } from '../../shared/device-eligibility';
import { existsSync, readFileSync } from 'node:fs';
import { createError } from 'h3';
import { dataPath } from './data-path';
import { latestInstallationAttempts } from '../../shared/latest-installation-attempts';
import { assertNoPs5ServiceUpdate } from './ps5-service-updates';
import { assertNoPs5Bootstrap } from './ps5-bootstrap-journal';
import { writeDurableJson } from './durable-json';
import { getConsoleProfile, getConsoleProfiles, probeConsoleProfile } from './console-profiles';
import { getLibraryPackages, getPackage, markPackageInstalled } from './package-library';
import {
  contentBranchKey,
  contentForConsole,
  contentFormat,
  contentPlatform,
} from '../../shared/content-platform';
import {
  installationTaskCategory,
  TASK_CATEGORIES,
  type InstallationTask,
  type InstallationTasksPage,
} from '../../shared/types/tasks';
import {
  Ps5QueueRunner,
  ps5BlankQueue,
  ps5CanCancel,
  Ps5QueueFailure,
  type Ps5Item,
} from './ps5-queue-core';
import { isPs5ImageFormat } from './ps5-image-driver';
import { ps5QueueDriver } from './ps5-queue-driver';
import { assessPs5SourceFirmware } from './ps5-installation-firmware';
import type { LibraryInstallationSelection } from './library-installation';
import type { Ps5SpaceItem } from '../../shared/ps5-installation-space';
const runners = new Map<string, Ps5QueueRunner>();
const path = (id: string) => dataPath(`consoles/${id}/ps5-installation-queue.json`);
function validItems(value: unknown): value is Ps5Item[] {
  return (
    Array.isArray(value) &&
    value.length <= 10000 &&
    value.every(
      (item) =>
        item &&
        typeof item.packageId === 'string' &&
        /^[a-zA-Z0-9_.-]{1,128}$/.test(item.packageId) &&
        /^[0-9a-f]{32}$/.test(item.transferId || '') &&
        [
          'pending',
          'sending',
          'verifying',
          'installing',
          'waiting',
          'installed',
          'failed',
          'skipped',
          'cancelled',
          'unconfirmed',
        ].includes(item.state) &&
        ['ps4', 'ps5'].includes(item.platform) &&
        ['pkg', 'folder', 'ufs2', 'exfat', 'pfs', 'ffpfsc', 'unknown'].includes(item.format) &&
        (item.alreadyPresent === undefined || typeof item.alreadyPresent === 'boolean') &&
        (item.overwriteApproved === undefined || typeof item.overwriteApproved === 'boolean') &&
        (item.imagePublishedAt === undefined ||
          (Number.isSafeInteger(item.imagePublishedAt) && item.imagePublishedAt > 0)) &&
        (item.folderPublishedAt === undefined ||
          (Number.isSafeInteger(item.folderPublishedAt) && item.folderPublishedAt > 0)) &&
        (item.observationStoppedAt === undefined ||
          (Number.isSafeInteger(item.observationStoppedAt) &&
            item.observationStoppedAt > 0 &&
            item.installDispatched === true &&
            item.state === 'failed')) &&
        (item.progressPhase === undefined ||
          ['source-check', 'transfer', 'device-check'].includes(item.progressPhase)) &&
        (item.bytesChecked === undefined ||
          (Number.isSafeInteger(item.bytesChecked) &&
            item.bytesChecked >= 0 &&
            item.bytesChecked <= item.size)) &&
        (item.confirmation === undefined ||
          (['user', 'service-registration', 'service-existing', 'recorded-existing'].includes(
            item.confirmation,
          ) &&
            Number.isSafeInteger(item.confirmedAt) &&
            item.confirmedAt > 0 &&
            item.state === 'installed')) &&
        typeof item.branch === 'string' &&
        typeof item.title === 'string' &&
        typeof item.fileName === 'string' &&
        typeof item.detail === 'string' &&
        Number.isSafeInteger(item.size) &&
        item.size > 0 &&
        Number.isSafeInteger(item.bytesSent) &&
        item.bytesSent >= 0 &&
        item.bytesSent <= item.size &&
        Number.isInteger(item.order) &&
        item.order >= 0,
    )
  );
}
function runner(id: string) {
  const profile = getConsoleProfile(id);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id))
    throw createError({ statusCode: 400, message: 'Неверный профиль PS5' });
  if (profile.platform !== 'ps5')
    throw createError({ statusCode: 400, message: 'Выберите профиль PS5' });
  let value = runners.get(profile.id);
  if (!value) {
    let queue = ps5BlankQueue(profile.id, profile.ip);
    if (existsSync(path(profile.id))) {
      try {
        queue = JSON.parse(readFileSync(path(profile.id), 'utf8'));
        if (
          queue.version !== 1 ||
          queue.consoleId !== profile.id ||
          queue.psIp !== profile.ip ||
          !validItems(queue.items) ||
          !Array.isArray(queue.history) ||
          queue.history.length > 10 ||
          !queue.history.every(validItems) ||
          !['idle', 'paused', 'running', 'completed', 'failed', 'cancelled'].includes(queue.status)
        )
          throw new Error('Invalid queue');
      } catch {
        throw createError({
          statusCode: 500,
          message: 'Не удалось прочитать очередь PS5. Сохранённый файл не изменён',
        });
      }
    }
    value = new Ps5QueueRunner(
      queue,
      (q) => writeDurableJson(path(profile.id), q),
      ps5QueueDriver(profile.id),
      2000,
      (item) => {
        markPackageInstalled(item.packageId, true, profile.ip);
      },
    );
    runners.set(profile.id, value);
  }
  return value;
}
export function getPs5Queue(id: string) {
  const { history: _, ...snapshot } = runner(id).queue,
    q = structuredClone(snapshot);
  return {
    ...q,
    items: q.items.map((item) => {
      const { hash: _, sourceStamp: __, transferId: ___, ...publicItem } = item;
      return publicItem;
    }),
  };
}
/** Internal preflight reads the captured queue/plan, not its redacted API view.
 * Never expose transfer IDs simply to calculate space. Unknown/legacy plans
 * retain the conservative estimate; progress alone is not offset credit. */
export function getPs5PendingSpaceItems(id: string): Ps5SpaceItem[] {
  return runner(id)
    .queue.items.filter(
      (item) => !['installed', 'failed', 'skipped', 'cancelled'].includes(item.state),
    )
    .map((item) => {
      let legacyFolder = true;
      if (item.format === 'folder') {
        try {
          const plan = JSON.parse(
            readFileSync(dataPath(`consoles/${id}/${item.transferId}.folder-plan.json`), 'utf8'),
          );
          legacyFolder = !(
            plan.version === 2 &&
            plan.id === item.transferId &&
            plan.total === item.size &&
            plan.title === item.titleId
          );
        } catch {
          legacyFolder = item.state !== 'pending';
        }
      }
      return { size: item.size, format: item.format, legacyFolder };
    });
}
export function getPs5SetupAttempt(id: string, queueId: string, packageId: string) {
  const q = runner(id).queue;
  const item = [q.items, ...q.history]
    .flat()
    .find(
      (item) =>
        (item.queueId || (q.items.includes(item) ? q.id : undefined)) === queueId &&
        item.packageId === packageId,
    );
  return item
    ? { state: item.state, confirmation: item.confirmation, alreadyPresent: item.alreadyPresent }
    : undefined;
}
export function ps5TaskPackageId(id: string, queueId: string, taskId: string) {
  const q = runner(id).queue,
    item = q.items.find((item) => item.transferId === taskId || item.packageId === taskId);
  if (q.id !== queueId || !item)
    throw createError({ statusCode: 409, message: 'Задание больше не существует в этой очереди' });
  return item.packageId;
}
export async function startPs5Queue(input: {
  consoleId: string;
  packageIds?: unknown;
  librarySelection?: LibraryInstallationSelection;
  queueId?: string;
  newQueueId?: string;
  overwritePackageIds?: string[];
  appSourceRepair?: { packageId: string; sourceIdentity: string };
}) {
  assertNoPs5ServiceUpdate(input.consoleId);
  assertNoPs5Bootstrap(input.consoleId);
  const profile = getConsoleProfile(input.consoleId);
  if (profile.platform !== 'ps5') throw createError({ statusCode: 400, message: 'Выберите PS5' });
  const snapshot = (await probeConsoleProfile(profile.id)).consoles.find(
    (p) => p.id === profile.id,
  )!;
  if (!snapshot.online || !snapshot.paired)
    throw createError({ statusCode: 409, message: 'Подключите и сопрягите сервис PS5' });
  const library = getLibraryPackages(profile.ip),
    current = runner(profile.id);
  let ids = input.packageIds;
  if (input.librarySelection) {
    const selection = input.librarySelection;
    if (
      !['all', 'dlc'].includes(selection.scope) ||
      (selection.titleId !== undefined &&
        (typeof selection.titleId !== 'string' || !selection.titleId.trim()))
    )
      throw createError({ statusCode: 400, message: 'Неверный выбор библиотеки' });
    const excluded = new Set(
      current.queue.status === 'running'
        ? current.queue.items
            .filter((item) => item.state !== 'cancelled')
            .map((item) => item.packageId)
        : [],
    );
    ids = library
      .filter(
        (item) =>
          contentForConsole(item, 'ps5') &&
          !item.installedAt &&
          !excluded.has(item.id) &&
          (!selection.platform ||
            selection.platform === 'all' ||
            contentPlatform(item) === selection.platform) &&
          (selection.scope !== 'dlc' || item.type === 'DLC') &&
          (!selection.titleId || selection.titleId === item.titleId),
      )
      .map((item) => item.id);
  }
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 10000 ||
    ids.some((id) => typeof id !== 'string')
  )
    throw createError({ statusCode: 400, message: 'Выберите пакеты для установки' });
  const items = [...new Set(ids as string[])].map((id) => getPackage(id));
  const overwrite = input.overwritePackageIds || [];
  if (
    !Array.isArray(overwrite) ||
    overwrite.some(
      (id) =>
        typeof id !== 'string' ||
        !items.some((item) => item.id === id && contentFormat(item) === 'pkg'),
    )
  )
    throw createError({
      statusCode: 400,
      message: 'Повторная установка разрешается только для выбранных PKG',
    });
  const repair = input.appSourceRepair;
  if (repair) {
    // Internal desktop recovery, never a general image overwrite option.
    const item = items[0]!;
    if (
      items.length !== 1 ||
      repair.packageId !== item.id ||
      item.titleId !== 'PPSA95001' ||
      item.contentId !== 'IV0000-PPSA95001_00-PACKAGEFLOWUI001' ||
      !isPs5ImageFormat(contentFormat(item)) ||
      !/^[a-f0-9]{64}$/.test(repair.sourceIdentity)
    )
      throw createError({
        statusCode: 409,
        message: 'Неверный источник восстановления PackageFlow',
      });
    const { ps5ConsoleGameInfo } = await import('./ps5-console-games');
    const current = await ps5ConsoleGameInfo(profile.id, item.titleId);
    if (
      current.sourceIdentity !== repair.sourceIdentity ||
      current.contentId !== item.contentId ||
      current.installed !== true ||
      current.sourceAvailable !== false
    )
      throw createError({
        statusCode: 409,
        message: 'Состояние PackageFlow изменилось. Обновите проверку приложения',
      });
  }
  // Validate the WHOLE batch before persisting or transferring any bytes.
  for (const item of items) {
    const platform = contentPlatform(item),
      format = contentFormat(item);
    if (
      !contentForConsole(item, 'ps5') ||
      ((!snapshot.capabilities.formats.includes(format) ||
        !(platform === 'ps4'
          ? snapshot.capabilities.installPs4
          : snapshot.capabilities.installPs5)) &&
        !ps5PkgQueueSupported(snapshot, item)) ||
      !['pkg', 'folder', 'ufs2', 'exfat', 'pfs', 'ffpfsc'].includes(format) ||
      ((format === 'folder' || isPs5ImageFormat(format)) &&
        (platform !== 'ps5' || item.installOrder !== 0))
    )
      throw createError({
        statusCode: 409,
        message: `Сервис PS5 ещё не подтвердил установку ${platform.toUpperCase()} / ${format.toUpperCase()}. Очередь не отправлена`,
      });
    if (platform === 'ps5') {
      const firmware = await assessPs5SourceFirmware(snapshot.firmware, item);
      if (firmware.state !== 'compatible')
        throw createError({
          statusCode: 409,
          message: `«${item.title}»: ${firmware.detail}. Набор не отправлен`,
        });
    }
  }
  assertNoConsoleSpeedTest(profile.id);
  try {
    current.enqueue(
      items.map((item) => ({
        packageId: item.id,
        title: item.title,
        fileName: item.fileName,
        size: item.size,
        type: item.type,
        titleId: item.titleId,
        branch: contentBranchKey(item),
        order: item.installOrder,
        platform: contentPlatform(item),
        format: contentFormat(item),
        appVersion: item.appVersion,
        contentId: item.contentId,
        overwriteApproved: overwrite.includes(item.id) || repair?.packageId === item.id,
      })),
      input.queueId,
      input.newQueueId,
    );
    return getPs5Queue(profile.id);
  } catch (error) {
    if (error instanceof Ps5QueueFailure)
      throw createError({ statusCode: 409, message: error.message });
    throw error;
  }
}
export function cancelPs5Queue(
  id: string,
  queueId: string,
  packageIds?: string[],
  branches?: string[],
) {
  try {
    runner(id).cancel(queueId, packageIds, branches);
    return getPs5Queue(id);
  } catch (error) {
    if (error instanceof Ps5QueueFailure)
      throw createError({ statusCode: 409, message: error.message });
    throw error;
  }
}
export function confirmPs5Installation(id: string, queueId: string, packageId: string) {
  try {
    runner(id).confirmInstalled(queueId, packageId);
    return getPs5Queue(id);
  } catch (error) {
    if (error instanceof Ps5QueueFailure)
      throw createError({ statusCode: 409, message: error.message });
    throw error;
  }
}
export function clearPs5Tasks(id: string) {
  runner(id).clear();
  return getPs5Queue(id);
}
export function stopPs5Waiting(id: string, queueId: string, packageId: string) {
  try {
    runner(id).stopWaiting(queueId, packageId);
    return getPs5Queue(id);
  } catch (error) {
    if (error instanceof Ps5QueueFailure)
      throw createError({ statusCode: 409, message: error.message });
    throw error;
  }
}
export function removePs5Tasks(
  id: string,
  queueId: string,
  packageIds?: string[],
  branches?: string[],
) {
  const r = runner(id),
    q = r.queue;
  const targets = [q.items, ...q.history].flatMap((items, index) =>
    items.filter(
      (item) =>
        (item.queueId || (index === 0 ? q.id : `history-${index}`)) === queueId &&
        (packageIds?.includes(item.packageId) || branches?.includes(item.branch)),
    ),
  );
  if (!targets.length)
    throw createError({ statusCode: 409, message: 'Выбранные задания больше не найдены' });
  const unfinished = targets.filter(
    (item) => !['installed', 'failed', 'skipped', 'cancelled'].includes(item.state),
  );
  if (unfinished.length) {
    if (queueId !== q.id || unfinished.some((item) => !ps5CanCancel(item)))
      throw createError({
        statusCode: 409,
        message: 'Установка уже принята PS5. Дождитесь результата; задание не скрыто.',
      });
    cancelPs5Queue(
      id,
      queueId,
      unfinished.map((item) => item.packageId),
    );
  }
  r.clear((item) => targets.includes(item));
  return {
    message: targets.some((item) => !item.hidden)
      ? 'Отмена запрошена. Задание останется видно до подтверждения.'
      : 'Выбранные задания убраны из списка. Установленные игры сохранены.',
  };
}
export function getPs5TaskCounts(id: string) {
  const q = runner(id).queue,
    counts: InstallationTasksPage['counts'] = { active: 0, queued: 0, completed: 0, failed: 0 };
  const visible = latestInstallationAttempts(
    [q.items, ...q.history]
      .flat()
      .map((item) => ({ ...item, psIp: q.psIp, createdAt: item.createdAt || q.createdAt })),
  ).filter((item) => !item.hidden);
  for (const item of visible) counts[installationTaskCategory(item.state)]++;
  return counts;
}
export function getPs5Tasks(
  id: string,
  query: { categories?: unknown; page?: unknown; view?: unknown; history?: unknown } = {},
): InstallationTasksPage {
  const r = runner(id),
    q = r.queue,
    library = getLibraryPackages(q.psIp);
  const groups = new Map<string, (typeof library)[number]>();
  for (const pkg of library) {
    const key = contentBranchKey(pkg);
    if (!groups.has(key) || pkg.installOrder === 0) groups.set(key, pkg);
  }
  const tasks: InstallationTask[] = [];
  const hiddenTasks = new Set<string>();
  for (const [index, entries] of [q.items, ...q.history].entries())
    for (const item of entries) {
      if (item.hidden) hiddenTasks.add(item.transferId);
      const base = groups.get(item.branch);
      const {
        hash: _,
        sourceStamp: __,
        transferId: ___,
        installDispatched: ____,
        ...metadata
      } = item;
      tasks.push({
        ...metadata,
        ...r.transferTelemetry(item),
        id: item.transferId,
        queueId: item.queueId || (index === 0 ? q.id || '' : `history-${index}`),
        psIp: q.psIp,
        canConfirm:
          !item.observationStoppedAt &&
          item.installDispatched === true &&
          !!item.serviceJobId &&
          item.bytesSent === item.size &&
          ['installing', 'unconfirmed', 'failed'].includes(item.state),
        canStopWaiting:
          item.state === 'unconfirmed' &&
          item.installDispatched === true &&
          (item.queueId || q.id) === q.id,
        canDismiss: ['installed', 'failed', 'skipped', 'cancelled'].includes(item.state),
        consolePlatform: 'ps5',
        category: installationTaskCategory(item.state),
        groupTitle: base?.title || item.title,
        groupIconId: base?.iconSize ? base.id : undefined,
        createdAt: item.createdAt || q.createdAt,
        transport: 'service',
        canCancel: index === 0 && ['running', 'paused'].includes(q.status) && ps5CanCancel(item),
        cancelRequested: !!item.cancelRequested,
      });
    }
  const visibleTasks = latestInstallationAttempts(tasks, query.history).filter(
    (task) => !hiddenTasks.has(task.id),
  );
  const counts = Object.fromEntries(
    TASK_CATEGORIES.map((c) => [c, visibleTasks.filter((t) => t.category === c).length]),
  ) as InstallationTasksPage['counts'];
  const active = visibleTasks.filter(
    (t) => t.queueId === q.id && (t.category === 'active' || t.state === 'unconfirmed'),
  );
  const categories =
    typeof query.categories === 'string' ? query.categories.split(',') : TASK_CATEGORIES;
  const tree = query.view === 'tree',
    filtered = visibleTasks.filter(
      (t) => categories.includes(t.category) && (tree || !active.some((a) => a.id === t.id)),
    );
  const branches = new Map<string, InstallationTask[]>();
  for (const task of filtered) {
    const key = contentBranchKey(task);
    const entries = branches.get(key) || [];
    entries.push(task);
    branches.set(key, entries);
  }
  const total = tree ? branches.size : filtered.length,
    pages = Math.max(1, Math.ceil(total / 50)),
    page = Math.min(pages, Math.max(1, Math.floor(Number(query.page) || 1)));
  return {
    active,
    items: tree
      ? [...branches.values()].slice((page - 1) * 50, page * 50).flat()
      : filtered.slice((page - 1) * 50, page * 50),
    counts,
    page,
    pages,
    total,
    unit: tree ? 'games' : 'tasks',
    resumableQueues: q.status === 'paused' && q.id ? [q.id] : [],
    queueId: q.id,
    queueStatus: q.status,
    canCancelAll: ['running', 'paused'].includes(q.status) && q.items.some(ps5CanCancel),
  };
}
export function resumePs5Queues() {
  for (const profile of getConsoleProfiles().consoles.filter((p) => p.platform === 'ps5')) {
    try {
      runner(profile.id).wake();
    } catch (error) {
      console.error(
        'PS5 queue recovery unavailable:',
        error instanceof Error ? error.message : 'unknown',
      );
    }
  }
}

export async function pausePs5Queue(id: string, queueId: string) {
  return runner(id).pause(queueId);
}
export function resumePs5Queue(id: string, queueId: string) {
  assertNoConsoleSpeedTest(id);
  return runner(id).resume(queueId);
}

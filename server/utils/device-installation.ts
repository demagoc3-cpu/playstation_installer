import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createError } from 'h3';
import {
  getConsoleProfile,
  getConsoleProfiles,
  refreshConsoleProfile,
  refreshConsoleProfiles,
} from './console-profiles';
import {
  beginSelectedReinstall,
  selectedReinstallPlan,
  replacementCoversComponents,
} from './selected-reinstallation';
import { readMaintenance } from './maintenance-store';
import { installedPackagePreviewChecker } from './installed-package-check';
import { getPackage, getLibraryPackages } from './package-library';
import { presetSelection } from './presets';
import { filterContent, contentBranchKey, contentFormat } from '../../shared/content-platform';
import { deviceInstallReason, installationSpaceSupported } from '../../shared/device-eligibility';
import type {
  DeviceSelection,
  DeviceInstallPreview,
  DeviceActivity,
} from '../../shared/types/consoles';
import {
  peekInstallationQueue,
  getInstallationHistory,
  appendInstallationQueue,
  startInstallationQueue,
} from './installation-queue';
import {
  getPs5Queue,
  getPs5TaskCounts,
  getPs5PendingSpaceItems,
  startPs5Queue,
} from './ps5-installation-queue';
import { latestInstallationAttempts } from '../../shared/latest-installation-attempts';
import { getTaskVisibility, installationTaskHidden } from './task-visibility';
import { installationTaskCategory } from '../../shared/types/tasks';
import { getLocalIp } from './ps4-installer';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { requiredPs5InstallSpace } from '../../shared/ps5-installation-space';
import { requiredInstallSpace } from './installation-space';
import { getPs4InstallSettings } from './ps4-install-settings';
import { ps4TransportConflict, PS4_PARALLEL_SERVICE_REQUIRED } from './ps4-transport-admission';

export function resolveDeviceSelection(selection: DeviceSelection): string[] {
  if (
    !selection ||
    typeof selection !== 'object' ||
    [selection.packageIds, selection.librarySelection, selection.preset].filter(
      (value) => value !== undefined,
    ).length !== 1
  )
    throw createError({ statusCode: 400, message: 'Выберите один набор файлов' });
  let ids: string[];
  if (selection.preset)
    ids = presetSelection(selection.preset.id, selection.preset.keys).map((item) => item.id);
  else if (selection.librarySelection) {
    const s = selection.librarySelection;
    if (
      !['all', 'dlc'].includes(s.scope) ||
      (s.platform !== undefined && !['all', 'ps4', 'ps5'].includes(s.platform)) ||
      (s.titleId !== undefined && (typeof s.titleId !== 'string' || !s.titleId))
    )
      throw createError({ statusCode: 400, message: 'Неверный выбор библиотеки' });
    ids = filterContent(getLibraryPackages(), s.platform)
      .filter(
        (item) =>
          (s.scope !== 'dlc' || item.type === 'DLC') && (!s.titleId || item.titleId === s.titleId),
      )
      .map((item) => item.id);
  } else ids = selection.packageIds!;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 10000 ||
    ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id))
  )
    throw createError({
      statusCode: 400,
      message: 'Выберите файлы для установки (не более 10000)',
    });
  // Resolve aliases once so duplicate source files cannot be sent twice.
  const library = getLibraryPackages();
  const direct = new Map(library.map((item) => [item.id, item.id]));
  const aliases = new Map<string, Set<string>>();
  for (const item of library)
    for (const alias of item.sourceIds || []) {
      const owners = aliases.get(alias) || new Set<string>();
      owners.add(item.id);
      aliases.set(alias, owners);
    }
  return [
    ...new Set(
      ids.map((id) => {
        if (direct.has(id)) return direct.get(id)!;
        const owners = aliases.get(id);
        if (!owners?.size)
          throw createError({
            statusCode: 404,
            message: 'Файл больше не доступен в библиотеке. Обновите выбор',
          });
        if (owners.size !== 1)
          throw createError({
            statusCode: 409,
            message: 'Неоднозначный идентификатор пакета. Обновите библиотеку и выбор',
          });
        return [...owners][0]!;
      }),
    ),
  ];
}
export function deviceQueue(id: string) {
  const profile = getConsoleProfile(id);
  return profile.platform === 'ps5' ? getPs5Queue(id) : peekInstallationQueue(profile.ip);
}
export function deviceActivities(packageIds: string[] = []): DeviceActivity[] {
  const visible = new Set(packageIds);
  const hidden = new Set(getTaskVisibility().hidden);
  return getConsoleProfiles().consoles.map((profile) => {
    try {
      const queue = deviceQueue(profile.id);
      const flow = readMaintenance()[profile.ip];
      if (
        flow?.kind === 'selected-reinstall' &&
        !['completed', 'failed', 'installing'].includes(flow.state)
      )
        return {
          consoleId: profile.id,
          status: 'running',
          queueId: flow.id,
          message: flow.message,
          counts: { active: 1, queued: flow.input.packageIds.length, completed: 0, failed: 0 },
          activePackageIds: flow.input.packageIds,
          queuedPackageIds: flow.input.packageIds,
          installedPackageIds: [],
        };
      const counts =
        profile.platform === 'ps5'
          ? getPs5TaskCounts(profile.id)
          : { active: 0, queued: 0, completed: 0, failed: 0 };
      if (profile.platform === 'ps4') {
        const attempts = [
          queue,
          ...getInstallationHistory(profile.ip).filter((record) => record.id !== queue.id),
        ].flatMap((record) =>
          record.items.map((item) => ({
            ...item,
            psIp: profile.ip,
            createdAt: record.createdAt || 0,
            taskHidden:
              installationTaskHidden(hidden, record.id, item, profile.ip) &&
              ['completed', 'failed'].includes(installationTaskCategory(item.state)),
          })),
        );
        for (const item of latestInstallationAttempts(attempts).filter((item) => !item.taskHidden))
          counts[installationTaskCategory(item.state)]++;
      }
      const running = ['running', 'cancelling'].includes(queue.status);
      return {
        consoleId: profile.id,
        status: queue.status,
        queueId: queue.id,
        message: queue.message,
        counts,
        activePackageIds: running
          ? queue.items
              .filter((item) =>
                [
                  'sending',
                  'waiting',
                  'receiving',
                  'installing',
                  'verifying',
                  'unconfirmed',
                ].includes(item.state),
              )
              .map((item) => item.packageId)
          : [],
        queuedPackageIds: running
          ? queue.items
              .filter((item) => item.state === 'pending' && visible.has(item.packageId))
              .map((item) => item.packageId)
          : [],
        installedPackageIds: [],
      };
    } catch {
      return {
        consoleId: profile.id,
        status: 'unavailable',
        message: 'Не удалось прочитать задания устройства',
        counts: { active: 0, queued: 0, completed: 0, failed: 0 },
        activePackageIds: [],
        queuedPackageIds: [],
        installedPackageIds: [],
      };
    }
  });
}
// This short-lived memory cache contains only live device replies. It never reads installation marks.
const liveActivitySnapshots = new Map<string, { until: number; value: string[] }>();
const liveActivityChecks = new Map<string, Promise<string[]>>();
export async function deviceActivitiesLive(packageIds: string[] = []): Promise<DeviceActivity[]> {
  const activity = deviceActivities(packageIds),
    check = installedPackagePreviewChecker(),
    selection = [...new Set(packageIds)].sort();
  await Promise.all(
    activity.map(async (entry) => {
      const profile = getConsoleProfiles().consoles.find((item) => item.id === entry.consoleId);
      if (
        !profile ||
        !profile.online ||
        !profile.paired ||
        (profile.platform === 'ps4' && profile.transport === 'payload') ||
        !packageIds.length
      )
        return;
      const key = JSON.stringify([profile.id, profile.ip, profile.transport, selection]),
        cached = liveActivitySnapshots.get(key);
      if (cached && cached.until > Date.now()) {
        entry.installedPackageIds = cached.value;
        return;
      }
      const pending = liveActivityChecks.get(key);
      if (pending) {
        entry.installedPackageIds = await pending;
        return;
      }
      const value = (async () => {
        try {
          const present: string[] = [];
          for (let offset = 0; offset < selection.length; offset += 8) {
            await Promise.all(
              selection.slice(offset, offset + 8).map(async (id) => {
                try {
                  const pkg = getPackage(id);
                  if ((await check(profile, pkg)).state === 'installed') present.push(id);
                } catch {
                  /* Unavailable package is not installed proof. */
                }
              }),
            );
          }
          if (liveActivitySnapshots.size >= 64)
            liveActivitySnapshots.delete(liveActivitySnapshots.keys().next().value!);
          liveActivitySnapshots.set(key, { until: Date.now() + 5000, value: present });
          return present;
        } finally {
          // A slow check stays shared until completion, independently of the snapshot TTL.
          liveActivityChecks.delete(key);
        }
      })();
      liveActivityChecks.set(key, value);
      entry.installedPackageIds = await value;
    }),
  );
  return activity;
}
const activeStates = [
  'pending',
  'sending',
  'waiting',
  'receiving',
  'installing',
  'verifying',
  'unconfirmed',
];
function ps5SpaceItems(
  consoleId: string,
  packages: ReturnType<typeof getPackage>[],
  running: boolean,
) {
  const chosen = packages.map((item) => ({ size: item.size, format: contentFormat(item) }));
  return running ? [...chosen, ...getPs5PendingSpaceItems(consoleId)] : chosen;
}
const packageSummary = (item: ReturnType<typeof getPackage>) => ({
  packageId: item.id,
  title: item.title,
  titleId: item.titleId,
  type: item.type,
  version: item.appVersion || '',
  size: item.size,
});
export async function previewDeviceInstall(
  selection: DeviceSelection,
  destinations?: string[],
): Promise<DeviceInstallPreview> {
  const ids = resolveDeviceSelection(selection),
    items = ids.map((id) => getPackage(id)),
    scope = items.every((item) => contentFormat(item) === 'pkg') ? 'pkg' : 'full';
  if (destinations)
    for (let offset = 0; offset < destinations.length; offset += 8)
      await Promise.all(
        destinations
          .slice(offset, offset + 8)
          .map((id) => refreshConsoleProfile(id, true, false, scope)),
      );
  // An explicit installation review must not reuse a cached failed PS5 probe.
  else await refreshConsoleProfiles(true, scope);
  const checkInstalled = installedPackagePreviewChecker();
  const size = items.reduce((sum, item) => sum + item.size, 0);
  return {
    selection: { packageIds: ids },
    files: ids.length,
    size,
    packages: items.map(packageSummary),
    devices: (
      await Promise.all(
        getConsoleProfiles().consoles.map(async (profile) => {
          if (destinations && !destinations.includes(profile.id)) return null;
          const queue = deviceQueue(profile.id),
            running = ['running', 'cancelling'].includes(queue.status);
          const existing = new Set(
            running
              ? queue.items
                  .filter((item) => activeStates.includes(item.state))
                  .map((item) => item.packageId)
              : [],
          );
          const checks = [];
          // PyLoader has no inventory API and must work independently of our service.
          if (
            profile.online &&
            profile.paired &&
            !(profile.platform === 'ps4' && profile.transport === 'payload')
          )
            for (let offset = 0; offset < items.length; offset += 8)
              checks.push(
                ...(await Promise.all(
                  items
                    .slice(offset, offset + 8)
                    .map(async (item) => ({ item, check: await checkInstalled(profile, item) })),
                )),
              );
          const installedPackages = checks
            .filter(({ check }) => ['installed', 'base-present'].includes(check.state))
            .map(({ item, check }) => {
              const components = check.components || [];
              const relevant = components.filter(
                (c) =>
                  item.installOrder === 0 ||
                  (c.kind === (item.type === 'DLC' ? 'dlc' : 'patch') &&
                    (c.kind !== 'dlc' || c.contentId === item.contentId)),
              );
              const covers = replacementCoversComponents(relevant, items);
              const removable = !!relevant.length && relevant.every((c) => c.canRemove);
              const inQueueHistory =
                running &&
                queue.items.some(
                  (old) => old.packageId === item.id && !activeStates.includes(old.state),
                );
              const canReinstall =
                profile.platform === 'ps4' &&
                profile.transport !== 'payload' &&
                !running &&
                removable &&
                covers;
              return {
                ...packageSummary(item),
                detail: check.detail,
                canOverwrite:
                  profile.platform === 'ps5' && !inQueueHistory && contentFormat(item) === 'pkg',
                canReinstall,
                reinstallReason:
                  inQueueHistory || (running && profile.platform === 'ps4')
                    ? 'Дождитесь завершения прежней очереди перед переустановкой'
                    : profile.platform === 'ps4'
                      ? !covers
                        ? 'Добавьте в набор все патчи и DLC, которые удаляются вместе с базой'
                        : !removable
                          ? 'Служба не подтвердила возможность удаления компонента'
                          : ''
                      : contentFormat(item) !== 'pkg'
                        ? 'Переустановка этого формата доступна через «На консоли»'
                        : '',
                affected:
                  item.installOrder === 0
                    ? relevant
                        .filter((c) => c.kind !== 'base')
                        .map((c) => `${c.kind}: ${c.title || c.contentId}`)
                    : [],
              };
            });
          const installedIds = new Set(installedPackages.map((item) => item.packageId));
          const additional = items
            .filter((item) => !existing.has(item.id) && !installedIds.has(item.id))
            .reduce((sum, item) => sum + item.size, 0);
          const pendingBytes = running
            ? queue.items
                .filter((item) =>
                  [
                    'pending',
                    'sending',
                    'waiting',
                    'receiving',
                    'installing',
                    'verifying',
                    'unconfirmed',
                  ].includes(item.state),
                )
                .reduce((sum, item) => sum + (item.size || 0), 0)
            : 0;
          // Folder v2 publishes the received inodes; legacy routes still need two copies.
          const sourceBytes = additional + pendingBytes;
          const requiredBytes =
            sourceBytes && installationSpaceSupported(profile)
              ? profile.platform === 'ps5'
                ? requiredPs5InstallSpace(
                    ps5SpaceItems(
                      profile.id,
                      items.filter((item) => !existing.has(item.id) && !installedIds.has(item.id)),
                      running,
                    ),
                    profile.capabilities,
                  )
                : requiredInstallSpace(sourceBytes)
              : 0;
          const transportConflict =
            profile.platform === 'ps4'
              ? ps4TransportConflict(profile.ip, profile.transport || 'service')
              : '';
          const selectedPs4 = destinations
            ? getConsoleProfiles().consoles.filter(
                (other) => destinations.includes(other.id) && other.platform === 'ps4',
              )
            : [];
          const mixedPayload =
            profile.platform === 'ps4' &&
            selectedPs4.length > 1 &&
            selectedPs4.some((other) => other.transport === 'payload');
          const finishedRetry =
            running &&
            items.some(
              (item) =>
                !installedIds.has(item.id) &&
                queue.items.some(
                  (old) => old.packageId === item.id && !activeStates.includes(old.state),
                ),
            );
          const maintenance = readMaintenance()[profile.ip];
          const reason =
            maintenance && !['completed', 'failed'].includes(maintenance.state)
              ? 'Дождитесь завершения переустановки или обновления службы'
              : deviceInstallReason(
                  profile,
                  items,
                  requiredBytes,
                  getPs4InstallSettings().verifyPkgBeforeSend,
                ) ||
                (sourceBytes &&
                installationSpaceSupported(profile) &&
                profile.freeBytes === undefined
                  ? 'Не удалось прочитать свободное место с приставки'
                  : '') ||
                checks.find(({ check }) => check.state === 'unavailable')?.check.detail ||
                transportConflict ||
                (mixedPayload ? PS4_PARALLEL_SERVICE_REQUIRED : '') ||
                (finishedRetry
                  ? 'Выбранный пакет есть в истории текущей очереди. Дождитесь её завершения перед новым заданием'
                  : '') ||
                (queue.status === 'cancelling' ? 'Дождитесь завершения отмены очереди' : '') ||
                (running &&
                profile.platform === 'ps4' &&
                queue.transport !== (profile.transport || 'service')
                  ? 'Очередь использует другой способ установки'
                  : '');
          const queuedPackages = running
            ? queue.items
                .filter((item) => activeStates.includes(item.state))
                .map((item) => ({
                  packageId: item.packageId,
                  title: item.title || item.packageId,
                  titleId: item.titleId || '',
                  type: item.type || '',
                  version: '',
                  size: item.size || 0,
                }))
            : [];
          const reviewToken = createHash('sha256')
            .update(
              JSON.stringify({
                ids: [...ids].sort(),
                checks: checks
                  .map(({ item, check }) => [
                    item.id,
                    check.state,
                    check.revision || '',
                    (check.components || [])
                      .map((c) => [c.id, c.kind, c.contentId, c.version, c.canRemove])
                      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
                  ])
                  .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
                queue: running
                  ? { id: queue.id, items: queuedPackages.map((item) => item.packageId) }
                  : null,
              }),
            )
            .digest('hex');
          return {
            profile,
            eligible: !reason,
            reason,
            selectedBytes: additional,
            queueBytes: pendingBytes,
            reviewToken,
            queuedPackages,
            pending: running ? queue.items.filter((item) => item.state === 'pending').length : 0,
            requiredBytes,
            installedPackages,
          };
        }),
      )
    ).filter((item): item is NonNullable<typeof item> => item !== null),
  };
}

export async function dispatchDeviceInstall(
  id: string,
  packageIds: string[],
  host: string,
  overwritePackageIds: string[] = [],
) {
  const profile = getConsoleProfile(id),
    queue = deviceQueue(id),
    running = queue.status === 'running';
  const seen = new Set(
    running
      ? queue.items
          .filter((item) => activeStates.includes(item.state))
          .map((item) => item.packageId)
      : [],
  );
  const ids = packageIds
    .filter((id) => !seen.has(id))
    .map((id) => getPackage(id))
    .sort(
      (a, b) =>
        contentBranchKey(a).localeCompare(contentBranchKey(b)) ||
        a.installOrder - b.installOrder ||
        (a.appVersion || '').localeCompare(b.appVersion || '', undefined, { numeric: true }) ||
        a.fileName.localeCompare(b.fileName, undefined, { numeric: true }),
    )
    .map((item) => item.id);
  if (!ids.length) return queue;
  if (profile.platform === 'ps5')
    return startPs5Queue({
      consoleId: id,
      packageIds: ids,
      queueId: running ? queue.id : undefined,
      overwritePackageIds: overwritePackageIds.filter((id) => ids.includes(id)),
    });
  const pcIp = await getLocalIp(profile.ip),
    port = host.match(/:(\d+)$/)?.[1] || '3000';
  const input = {
    psIp: profile.ip,
    packageIds: ids,
    packageUrls: Object.fromEntries(
      ids.map((id) => [id, `http://${pcIp}:${port}/json/${id}.json`]),
    ),
  };
  return running
    ? appendInstallationQueue({ ...input, queueId: queue.id! })
    : startInstallationQueue({ ...input, transport: profile.transport || 'service' });
}

interface BatchResult {
  consoleId: string;
  name: string;
  state: 'pending' | 'queued' | 'failed' | 'uncertain';
  queueId?: string;
  message: string;
}
interface BatchRecord {
  id: string;
  fingerprint: string;
  state: 'pending' | 'completed';
  results: BatchResult[];
  createdAt: number;
}
const batches = new Map<string, Promise<Omit<BatchRecord, 'fingerprint'>>>();
function batchPath(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id))
    throw createError({ statusCode: 400, message: 'Неверный идентификатор установки' });
  return dataPath('installation-batches', `${id}.json`);
}
function publicBatch(value: BatchRecord) {
  const { fingerprint: _, ...result } = value;
  return result;
}
export function readDeviceBatch(id: string) {
  const path = batchPath(id);
  if (!existsSync(path)) throw createError({ statusCode: 404, message: 'Установка не найдена' });
  return publicBatch(JSON.parse(readFileSync(path, 'utf8')) as BatchRecord);
}
export async function installDeviceBatch(
  id: string,
  selection: DeviceSelection,
  destinations: string[],
  host: string,
  overwrite: Record<string, string[]> = {},
  reviewTokens: Record<string, string> = {},
) {
  const path = batchPath(id);
  if (
    !Array.isArray(destinations) ||
    !destinations.length ||
    destinations.some((id) => typeof id !== 'string')
  )
    throw createError({ statusCode: 400, message: 'Выберите устройства' });
  const targets = [...new Set(destinations)].sort();
  targets.forEach(getConsoleProfile);
  const ids = resolveDeviceSelection(selection).sort();
  if (
    !overwrite ||
    Array.isArray(overwrite) ||
    typeof overwrite !== 'object' ||
    Object.entries(overwrite).some(
      ([target, values]) =>
        !targets.includes(target) ||
        !Array.isArray(values) ||
        values.some(
          (value) =>
            typeof value !== 'string' ||
            !ids.includes(value) ||
            contentFormat(getPackage(value)) !== 'pkg',
        ),
    )
  )
    throw createError({ statusCode: 400, message: 'Неверное подтверждение повторной установки' });
  if (
    !reviewTokens ||
    Array.isArray(reviewTokens) ||
    typeof reviewTokens !== 'object' ||
    Object.entries(reviewTokens).some(
      ([target, token]) => !targets.includes(target) || !/^[a-f0-9]{64}$/.test(token),
    )
  )
    throw createError({ statusCode: 400, message: 'Неверное подтверждение состава установки' });
  const overwriteBinding = Object.fromEntries(
    Object.entries(overwrite)
      .filter(([, values]) => values.length)
      .sort()
      .map(([key, values]) => [key, [...new Set(values)].sort()]),
  );
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        targets,
        ids,
        ...(Object.keys(overwriteBinding).length ? { overwrite: overwriteBinding } : {}),
        ...(Object.keys(reviewTokens).length ? { reviewTokens } : {}),
      }),
    )
    .digest('hex');
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as BatchRecord;
    if (saved.fingerprint !== fingerprint)
      throw createError({
        statusCode: 409,
        message: 'Этот идентификатор уже использован для другой установки',
      });
    if (batches.has(id)) return batches.get(id)!;
    if (saved.state === 'pending') {
      saved.results = saved.results.map((result) =>
        result.state === 'pending'
          ? {
              ...result,
              state: 'uncertain',
              message:
                'WEB перезапускался. Проверьте очередь устройства; повторная установка не отправлена',
            }
          : result,
      );
      saved.state = 'completed';
      writeDurableJson(path, saved);
    }
    return publicBatch(saved);
  }
  const saved: BatchRecord = {
    id,
    fingerprint,
    state: 'pending',
    createdAt: Date.now(),
    results: targets.map((consoleId) => ({
      consoleId,
      name: getConsoleProfile(consoleId).name,
      state: 'pending',
      message: 'Проверяем устройство',
    })),
  };
  // Claim this ID synchronously before any network await.
  writeDurableJson(path, saved);
  const operation = (async () => {
    const preview = await previewDeviceInstall({ packageIds: ids }, targets);
    const reinstallPlans = new Map<string, Awaited<ReturnType<typeof selectedReinstallPlan>>>();
    for (const device of preview.devices) {
      const approved = overwriteBinding[device.profile.id] || [];
      const approvedPackages = approved.map((id) =>
        device.installedPackages.find((pkg) => pkg.packageId === id),
      );
      if (
        (device.installedPackages.length ||
          device.queuedPackages.length ||
          reviewTokens[device.profile.id]) &&
        reviewTokens[device.profile.id] !== device.reviewToken
      ) {
        device.eligible = false;
        device.reason =
          'Состав устройства или очереди изменился. Обновите и подтвердите таблицу заново';
        continue;
      }
      if (approvedPackages.some((pkg) => !pkg || !(pkg.canOverwrite || pkg.canReinstall))) {
        device.eligible = false;
        device.reason = 'Выбранные пакеты нельзя переустановить этим способом';
        continue;
      }
      const extra = approvedPackages.reduce((sum, pkg) => sum + (pkg?.size || 0), 0),
        sourceBytes = device.selectedBytes + device.queueBytes + extra;
      device.requiredBytes =
        sourceBytes && installationSpaceSupported(device.profile)
          ? device.profile.platform === 'ps5'
            ? requiredPs5InstallSpace(
                ps5SpaceItems(
                  device.profile.id,
                  ids
                    .map(getPackage)
                    .filter(
                      (pkg) =>
                        !device.queuedPackages.some((queued) => queued.packageId === pkg.id) &&
                        (!device.installedPackages.some(
                          (installed) => installed.packageId === pkg.id,
                        ) ||
                          approved.includes(pkg.id)),
                    ),
                  deviceQueue(device.profile.id).status === 'running',
                ),
                device.profile.capabilities,
              )
            : requiredInstallSpace(sourceBytes)
          : 0;
      const reason =
        deviceInstallReason(
          device.profile,
          ids.map(getPackage),
          device.requiredBytes,
          getPs4InstallSettings().verifyPkgBeforeSend,
        ) ||
        (device.requiredBytes &&
        installationSpaceSupported(device.profile) &&
        device.profile.freeBytes === undefined
          ? 'Не удалось прочитать свободное место с приставки'
          : '');
      if (reason) {
        device.eligible = false;
        device.reason = reason;
        continue;
      }
      if (device.profile.platform === 'ps4' && approved.length) {
        if (device.queuedPackages.length) {
          device.eligible = false;
          device.reason = 'Для переустановки дождитесь завершения или отмены прежней очереди';
          continue;
        }
        reinstallPlans.set(
          device.profile.id,
          await selectedReinstallPlan(device.profile.ip, approved),
        );
      }
    }
    if (preview.devices.some((device) => !device.eligible)) {
      saved.results = saved.results.map((result) => ({
        ...result,
        state: 'failed',
        message:
          preview.devices.find((device) => device.profile.id === result.consoleId)?.reason ||
          'Установка не началась: проверьте остальные выбранные устройства',
      }));
    } else {
      // Separate results and queue identity for every console; one failure never stops the others.
      await Promise.all(
        saved.results.map(async (result) => {
          try {
            const device = preview.devices.find((v) => v.profile.id === result.consoleId)!,
              approved = overwriteBinding[result.consoleId] || [];
            const sendIds = ids
              .filter(
                (id) =>
                  !device.installedPackages.some((pkg) => pkg.packageId === id) ||
                  approved.includes(id),
              )
              .map(getPackage)
              .sort(
                (a, b) =>
                  contentBranchKey(a).localeCompare(contentBranchKey(b)) ||
                  a.installOrder - b.installOrder ||
                  (a.appVersion || '').localeCompare(b.appVersion || '', undefined, {
                    numeric: true,
                  }),
              )
              .map((pkg) => pkg.id);
            if (!sendIds.length) {
              result.state = 'queued';
              result.message = 'Все выбранные пакеты подтверждены на приставке и пропущены';
              return;
            }
            const steps = reinstallPlans.get(result.consoleId);
            if (steps) {
              const pcIp = await getLocalIp(device.profile.ip),
                port = host.match(/:(\d+)$/)?.[1] || '3000';
              const flow = await beginSelectedReinstall(
                device.profile.ip,
                {
                  packageIds: sendIds,
                  packageUrls: Object.fromEntries(
                    sendIds.map((id) => [id, `http://${pcIp}:${port}/json/${id}.json`]),
                  ),
                },
                steps,
              );
              result.queueId = flow.id;
              result.message =
                'Переустановка выбранных компонентов принята. После удаления начнётся выбранный набор';
            } else {
              const queue = await dispatchDeviceInstall(result.consoleId, sendIds, host, approved);
              result.queueId = queue.id;
              result.message = 'Только выбранные новые пакеты и переустановки добавлены в очередь';
            }
            result.state = 'queued';
          } catch (error: any) {
            result.state = 'failed';
            result.message = error?.message || 'Не удалось запустить очередь устройства';
          }
          writeDurableJson(path, saved);
        }),
      );
    }
    saved.state = 'completed';
    writeDurableJson(path, saved);
    return publicBatch(saved);
  })()
    .catch((error) => {
      saved.results = saved.results.map((result) =>
        result.state === 'pending'
          ? {
              ...result,
              state: 'failed',
              message: error?.message || 'Не удалось проверить устройства',
            }
          : result,
      );
      saved.state = 'completed';
      writeDurableJson(path, saved);
      return publicBatch(saved);
    })
    .finally(() => batches.delete(id));
  batches.set(id, operation);
  return operation;
}

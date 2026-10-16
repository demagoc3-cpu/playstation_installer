import { preparePs5GameLaunch } from './ps5-launch-preparation';
import { assertNoConsoleSpeedTest } from './console-speed-lock';
import { createError } from 'h3';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { getConsoleProfile, ps5OperationRequest } from './console-profiles';
import { getLibraryPackages } from './package-library';
import { consoleCatalog, managementStatus } from './ps5-management';
import { getPs5Queue } from './ps5-installation-queue';
import { assertNoPs5ServiceUpdate } from './ps5-service-updates';
const titleRx = /^(PPSA|CUSA)\d{5}$/,
  idRx = /^[0-9a-f]{32}$/;
const fail = (message: string) => createError({ statusCode: 409, message });
const actions = [
  'launch',
  'stop',
  'mount',
  'unmount',
  'uninstall',
  'delete',
  'copy',
  'move',
  'unpack',
] as const;
export type Ps5GameAction = (typeof actions)[number];
function profile(id: unknown) {
  const p = getConsoleProfile(id);
  if (p.platform !== 'ps5') throw fail('Выберите PS5');
  return p;
}
function title(id: unknown): string {
  if (typeof id !== 'string' || !titleRx.test(id)) throw fail('Неверный Title ID');
  return id;
}
function jobPath(id: string) {
  if (!idRx.test(id)) throw fail('Неверный номер команды');
  return resolve(dataPath('ps5-game-commands'), `${id}.json`);
}
async function result(
  id: string,
  path: Parameters<typeof ps5OperationRequest>[1],
  headers: Record<string, string> = {},
) {
  const r = await ps5OperationRequest(id, path, headers);
  if (r.status !== 200)
    throw fail(`PS5 отклонила операцию (${r.status}). Закройте игру и обновите список.`);
  return r.body;
}
export function normalizePs5Game(row: any) {
  if (
    !row ||
    !titleRx.test(row.title_id) ||
    !['ps4', 'ps5'].includes(row.platform) ||
    !['pkg', 'folder', 'image', 'unknown'].includes(row.source_type) ||
    typeof row.title_name !== 'string' ||
    row.title_name.length > 512 ||
    typeof row.path !== 'string' ||
    row.path.length > 1024 ||
    typeof row.version !== 'string' ||
    typeof row.content_id !== 'string'
  )
    throw fail('Некорректная запись игры PS5');
  for (const key of [
    'installed',
    'mounted',
    'managed',
    'source_available',
    'can_uninstall',
    'can_manage_source',
  ])
    if (typeof row[key] !== 'boolean') throw fail('Неполные возможности игры PS5');
  const size =
    row.size_status === 0 && Number.isSafeInteger(row.size_bytes) && row.size_bytes >= 0
      ? row.size_bytes
      : undefined;
  return {
    titleId: row.title_id,
    title: row.title_name || row.title_id,
    platform: row.platform,
    version: row.version,
    contentId: row.content_id,
    path: row.path,
    runtimePath: typeof row.runtime_path === 'string' ? row.runtime_path : '',
    format:
      row.source_type === 'image'
        ? String(row.image_type || 'Image').toUpperCase()
        : row.source_type === 'folder'
          ? 'Folder'
          : row.source_type === 'pkg'
            ? 'PKG'
            : '',
    sourceType: row.source_type,
    sizeBytes: size,
    registrationBytes: Number.isSafeInteger(row.app_db_size_bytes)
      ? row.app_db_size_bytes
      : undefined,
    installed: row.installed,
    mounted: row.mounted,
    managed: row.managed,
    sourceAvailable: row.source_available,
    canUninstall: row.can_uninstall,
    canManageSource: row.can_manage_source,
    lastAccessTime: typeof row.last_access_time === 'string' ? row.last_access_time : '',
    sourceIdentity: /^[a-f0-9]{64}$/.test(row.sourceIdentity) ? row.sourceIdentity : undefined,
  };
}
export async function ps5ConsoleGames(id: unknown) {
  const p = profile(id),
    capabilities = await managementStatus(p.id),
    library = getLibraryPackages(p.ip);
  const entries: any[] = [];
  let offset = 0,
    revision: string | undefined,
    total: number | undefined;
  const seen = new Set<string>();
  for (let page = 0; page < 513; page++) {
    // Reading a complete catalog does not grant launch/storage permissions.
    // Losing a private qualification marker must not hide existing sources.
    const reply = await ps5OperationRequest(p.id, '/api/v1/console/games', {
      'X-PackageFlow-Offset': String(offset),
    });
    if (reply.status !== 200) {
      if (!capabilities.consoleGames && page === 0 && [404, 405, 410, 503].includes(reply.status)) {
        const value = await consoleCatalog(p.id);
        return {
          ...value,
          capabilities: { ...capabilities, consoleSourcesRead: false },
          sourceMessage:
            reply.status === 503
              ? 'Чтение папок и образов сейчас недоступно. Обновите список после восстановления связи.'
              : 'Для чтения исходных папок и образов нужна обновлённая служба PS5.',
          entries: value.entries.map((row) => ({
            ...row,
            installed: true,
            sourceType: 'unknown',
            format: '',
            canUninstall: false,
            canManageSource: false,
            sourceAvailable: false,
            cover:
              row.cover ||
              `/api/ps5/management/icon?consoleId=${encodeURIComponent(p.id)}&titleId=${row.titleId}`,
          })),
        };
      }
      throw fail(`PS5 отклонила чтение списка игр (${reply.status}). Обновите список.`);
    }
    const v = reply.body;
    if (
      !/^[a-f0-9]{64}$/.test(v.revision) ||
      (revision !== undefined && revision !== v.revision) ||
      !Number.isSafeInteger(v.total) ||
      v.total < 0 ||
      v.total > 4096 ||
      (total !== undefined && total !== v.total) ||
      !Array.isArray(v.entries) ||
      v.entries.length > 8 ||
      v.next !== offset + v.entries.length ||
      v.next > v.total ||
      v.done !== (v.next === v.total) ||
      (!v.done && !v.entries.length)
    )
      throw fail('Список игр изменился; обновите его');
    revision = v.revision;
    total = v.total;
    for (const raw of v.entries) {
      const row = normalizePs5Game(raw);
      if (seen.has(row.titleId)) throw fail('Повторная запись игры');
      seen.add(row.titleId);
      const item = library.find((item) => item.titleId === row.titleId && item.type === 'Игра');
      entries.push({
        ...row,
        title: raw.title_name || item?.title || row.titleId,
        cover: item?.iconSize
          ? `/api/packages/${item.id}?asset=icon`
          : `/api/ps5/management/icon?consoleId=${encodeURIComponent(p.id)}&titleId=${row.titleId}`,
      });
    }
    offset = v.next;
    if (v.done)
      return {
        consoleId: p.id,
        complete: true,
        capabilities: { ...capabilities, consoleSourcesRead: true },
        entries,
      };
  }
  throw fail('Неполный список игр PS5');
}
export async function ps5ConsoleActivity(id: unknown) {
  const p = profile(id),
    v = await result(p.id, '/api/v1/console/activity');
  if (
    v?.complete !== true ||
    typeof v.running !== 'boolean' ||
    !Number.isSafeInteger(v.appId) ||
    v.appId < 0 ||
    v.appId > 2147483647 ||
    typeof v.titleId !== 'string' ||
    (v.running ? !titleRx.test(v.titleId) || v.appId === 0 : v.titleId !== '' || v.appId !== 0)
  )
    throw fail('Не удалось определить запущенную игру. Обновите состояние PS5.');
  return {
    consoleId: p.id,
    complete: true,
    running: v.running,
    appId: v.appId,
    titleId: v.titleId,
  };
}
export async function ps5ConsoleGameInfo(id: unknown, titleId: unknown) {
  const p = profile(id);
  const v = await result(p.id, '/api/v1/console/info', { 'X-PackageFlow-Title': title(titleId) });
  const row = normalizePs5Game(v);
  if (row.titleId !== titleId || !row.sourceIdentity)
    throw fail('PS5 не подтвердила сведения об игре');
  return { consoleId: p.id, ...row };
}
function idle(p: ReturnType<typeof profile>, action: Ps5GameAction) {
  assertNoPs5ServiceUpdate(p.id);
  if (
    getPs5Queue(p.id).items.some(
      (item) => !['installed', 'failed', 'skipped', 'cancelled'].includes(item.state),
    )
  )
    throw fail('Дождитесь окончания очереди PS5');
  const dir = dataPath('ps5-save-restores');
  if (
    existsSync(dir) &&
    readdirSync(dir).some((name) => {
      if (!/^[a-f0-9]{32}\.json$/.test(name)) return false;
      try {
        const j = JSON.parse(readFileSync(resolve(dir, name), 'utf8'));
        if (j.consoleId !== p.id || ['failed', 'confirmed', 'rolled-back'].includes(j.state))
          return false;
        // A completed apply deliberately stays pending while the user plays to check progress.
        // Only launch/stop may run during that review; storage mutations remain blocked.
        return !(
          ['launch', 'stop'].includes(action) &&
          j.state === 'pending' &&
          j.sourceIp === p.ip &&
          j.receipt?.state === 'pending' &&
          j.receipt.requestId === j.id &&
          j.receipt.titleId === j.target?.titleId &&
          j.receipt.userId === j.target?.userId &&
          j.receipt.kind === j.target?.kind
        );
      } catch {
        return true;
      }
    })
  )
    throw fail('Сначала завершите восстановление сохранения или откатите его');
}
export async function ps5ConsoleGameCommand(
  id: unknown,
  input: any,
  internal?: { bundledPackageFlowUpdate: true },
) {
  assertNoConsoleSpeedTest(String(id));
  let intentWritten = false;
  try {
    const p = profile(id),
      titleId = title(input?.titleId),
      requestId = input?.requestId,
      action = input?.action as Ps5GameAction;
    if (
      !idRx.test(requestId) ||
      !actions.includes(action) ||
      !/^[a-f0-9]{64}$/.test(input?.sourceIdentity)
    )
      throw fail('Неверная команда управления игрой');
    const destination = ['copy', 'move', 'unpack'].includes(action) ? input?.destination : '';
    if (destination !== '' && !/^\/data\/homebrew$|^\/mnt\/usb[0-7](?:\/games)?$/.test(destination))
      throw fail('Выберите каталог на внутреннем диске или подключённом USB');
    if (['delete', 'uninstall'].includes(action) && input.confirmTitleId !== titleId)
      throw fail('Подтвердите удаление вводом Title ID');
    const expectedAppId = input?.expectedAppId ?? 0;
    if (
      !Number.isSafeInteger(expectedAppId) ||
      expectedAppId < 0 ||
      expectedAppId > 2147483647 ||
      (expectedAppId && action !== 'stop')
    )
      throw fail('Неверная привязка запущенной игры');
    const binding = {
      consoleId: p.id,
      sourceIp: p.ip,
      titleId,
      action,
      sourceIdentity: input.sourceIdentity,
      destination,
      expectedAppId,
    };
    const path = jobPath(requestId);
    if (existsSync(path)) {
      intentWritten = true;
      const old = JSON.parse(readFileSync(path, 'utf8'));
      if (
        Object.keys(binding).some(
          (k) =>
            (k === 'expectedAppId' ? (old[k] ?? 0) : old[k]) !== binding[k as keyof typeof binding],
        )
      )
        throw fail('Номер команды относится к другой операции');
      return ps5ConsoleGameCommandStatus(p.id, requestId);
    }
    const bundledUpdate =
      internal?.bundledPackageFlowUpdate === true &&
      titleId === 'PPSA95001' &&
      ['stop', 'delete', 'uninstall'].includes(action);
    const capabilities = await managementStatus(p.id);
    if (!capabilities.consoleControl)
      throw fail('Управление играми ещё не подтверждено испытанием службы PS5');
    if (
      !['launch', 'stop'].includes(action) &&
      capabilities.consoleSourceControl === false &&
      !bundledUpdate
    )
      throw fail('Изменение исходных файлов ещё не подтверждено испытанием службы PS5');
    if (action === 'unpack' && !capabilities.consoleUnpack)
      throw fail('Распаковка образов на этой PS5 ещё не подтверждена; исходный образ сохранён');
    idle(p, action);
    if (action === 'launch') {
      if (!capabilities.consoleActivity)
        throw fail('Обновите ELF для проверки запущенной игры перед запуском');
      const active = await ps5ConsoleActivity(p.id);
      if (active.running)
        throw createError({
          statusCode: 409,
          message: 'На PS5 уже запущена игра. Подтвердите её закрытие перед запуском другой.',
          data: { activeGame: active },
        });
    }
    const current = await ps5ConsoleGameInfo(p.id, titleId);
    if (current.sourceIdentity !== input.sourceIdentity)
      throw fail('Файлы или сведения игры изменились. Обновите карточку.');
    // This server-only permission belongs to the bundled app updater. A browser
    // body flag cannot grant general game source access.
    const ownOrphan =
      bundledUpdate && action === 'uninstall' && current.installed && !current.sourceAvailable;
    if (
      bundledUpdate &&
      (current.contentId !== 'IV0000-PPSA95001_00-PACKAGEFLOWUI001' ||
        (!ownOrphan &&
          (current.sourceType !== 'image' ||
            !current.managed ||
            !current.sourceAvailable ||
            !current.canManageSource)))
    )
      throw fail('Источник приложения PackageFlow не подтверждён для обновления');
    if (
      (action === 'uninstall' && !current.canUninstall && !ownOrphan) ||
      (!['launch', 'stop', 'uninstall'].includes(action) && !current.canManageSource)
    )
      throw fail('Эта операция недоступна для выбранной игры');
    if (action === 'launch' && !current.installed)
      throw fail('Сначала смонтируйте и зарегистрируйте игру');
    let job: any = {
      id: requestId,
      ...binding,
      state: 'unconfirmed',
      createdAt: new Date().toISOString(),
    };
    writeDurableJson(path, job);
    intentWritten = true;
    if (action === 'launch') {
      job = await preparePs5GameLaunch(job, current, {
        save: (value) => writeDurableJson(path, value),
        mount: (mountId) =>
          result(p.id, '/api/v1/console/command', {
            'X-PackageFlow-Request-Id': mountId,
            'X-PackageFlow-Title': titleId,
            'X-PackageFlow-Action': 'mount',
            'X-PackageFlow-Source-Identity': input.sourceIdentity,
          }),
        info: () => ps5ConsoleGameInfo(p.id, titleId),
        activity: () => ps5ConsoleActivity(p.id),
      });
      writeDurableJson(path, job);
      if (job.launchPreparation && !job.nativeLaunchDispatched) return job;
    }
    try {
      const v = await result(p.id, '/api/v1/console/command', {
        'X-PackageFlow-Request-Id': requestId,
        'X-PackageFlow-Title': titleId,
        'X-PackageFlow-Action': action,
        'X-PackageFlow-Source-Identity': input.sourceIdentity,
        ...(destination ? { 'X-PackageFlow-Destination': destination } : {}),
        ...(expectedAppId ? { 'X-PackageFlow-Expected-App-Id': String(expectedAppId) } : {}),
        ...(['delete', 'uninstall'].includes(action)
          ? { 'X-PackageFlow-Confirm-Title': titleId }
          : {}),
      });
      return persistCommand(job, v);
    } catch (e: any) {
      writeDurableJson(path, {
        ...job,
        message: e?.message || 'Ответ не получен; команда не повторяется',
      });
      return ps5ConsoleGameCommandStatus(p.id, requestId);
    }
  } catch (e: any) {
    if (!intentWritten)
      throw createError({
        statusCode: e?.statusCode || 500,
        message: e?.code
          ? 'WEB не смог сохранить команду; на PS5 она не отправлена'
          : e?.message || 'Команда не отправлена',
        data: { ...e?.data, commandNotDispatched: true },
      });
    throw e;
  }
}
function persistCommand(job: any, v: any) {
  if (
    v?.requestId !== job.id ||
    v.titleId !== job.titleId ||
    v.action !== job.action ||
    !['accepted', 'failed', 'unconfirmed'].includes(v.state)
  )
    throw fail('Ответ PS5 не соответствует команде');
  const next = { ...job, state: v.state, result: v.result };
  writeDurableJson(jobPath(job.id), next);
  return next;
}
export async function ps5ConsoleGameCommandStatus(id: unknown, requestId: string) {
  const p = profile(id),
    path = jobPath(requestId);
  let job: any;
  try {
    job = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e: any) {
    if (e?.code === 'ENOENT')
      throw createError({
        statusCode: 404,
        message: 'Запись команды не найдена в этом WEB. Автоматически повторять запуск не будем.',
        data: { commandRecordMissing: true },
      });
    throw fail('WEB не смог прочитать запись команды. Автоматически повторять её не будем.');
  }
  if (job.consoleId !== p.id || job.sourceIp !== p.ip)
    throw fail('Команда относится к другой приставке');
  if (job.state === 'unconfirmed') {
    if (job.launchPreparation && !job.nativeLaunchDispatched) {
      try {
        const receipt = await result(p.id, '/api/v1/console/command/status', {
          'X-PackageFlow-Request-Id': job.launchPreparation.requestId,
        });
        if (
          receipt.requestId === job.launchPreparation.requestId &&
          receipt.titleId === job.titleId &&
          receipt.action === 'mount' &&
          ['accepted', 'failed'].includes(receipt.state)
        ) {
          job = {
            ...job,
            state: 'failed',
            launchPreparation: receipt,
            result: { error: 'launch_not_dispatched', stage: 'mount' },
            message:
              'Результат подготовки получен. Запуск не отправлялся; нажмите «Запустить» снова',
          };
          writeDurableJson(path, job);
        }
      } catch {
        /* Read-only reconciliation never mounts or launches. */
      }
      return job;
    }
    try {
      return persistCommand(
        job,
        await result(p.id, '/api/v1/console/command/status', {
          'X-PackageFlow-Request-Id': requestId,
        }),
      );
    } catch {
      return job;
    }
  }
  return job;
}
export async function ps5ConsoleStorageStatus(id: unknown, requestId: string) {
  const p = profile(id),
    job = await ps5ConsoleGameCommandStatus(p.id, requestId);
  if (!job.result?.job_id) return job;
  const v = await result(p.id, '/api/v1/console/storage');
  if (v.job_id !== job.result.job_id) throw fail('Служба сообщает о другом задании файлов');
  return { ...job, storage: v };
}

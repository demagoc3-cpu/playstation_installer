import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createError } from 'h3';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { getConsoleProfile, probeConsoleProfile, ps5ServiceRequest } from './console-profiles';
import { consoleSetupBundle } from './console-setup-artifacts';
import { type BootstrapFlow } from './ps5-bootstrap-driver';
import { getPs5Queue, getPs5SetupAttempt, startPs5Queue } from './ps5-installation-queue';
import { checkPs5InstalledPackage } from './installed-package-check';
import { desktopAppRetryState } from './desktop-app-retry';
import { desktopAppDeleteWasNotDispatched } from './desktop-app-upgrade';
import { registerPs5ImageFile, getPackage } from './package-library';
import { claimConsoleWorker } from './console-worker-lock';
import { trackDesktopRequest } from './desktop-lifecycle';
import { assertNoPs5ServiceUpdate } from './ps5-service-updates';
import { beginPs5ServiceStart, ps5ServiceStartInfo } from './ps5-service-start';
import { readPs5ServiceArtifact } from './ps5-service-artifact';
import { assertNoPs5Bootstrap } from './ps5-bootstrap-journal';

const flowPath = (id: string) => dataPath('console-setup', `bootstrap-${id}.json`);
function target(id: unknown) {
  const p = getConsoleProfile(id);
  if (p.platform !== 'ps5')
    throw createError({ statusCode: 400, message: 'Для этого шага выберите PS5' });
  return p;
}
function flow(id: string): BootstrapFlow | null {
  if (!existsSync(flowPath(id))) return null;
  try {
    const f = JSON.parse(readFileSync(flowPath(id), 'utf8'));
    if (
      f.consoleId !== id ||
      !/^[a-f0-9]{32}$/.test(f.id) ||
      !['checking', 'sending', 'verifying', 'completed', 'failed', 'unconfirmed'].includes(
        f.state,
      ) ||
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      typeof f.ip !== 'string' ||
      !Number.isSafeInteger(f.startedAt)
    )
      throw new Error();
    return f;
  } catch {
    throw createError({
      statusCode: 503,
      message: 'Не удалось прочитать результат отправки ELF. Повтор заблокирован',
    });
  }
}
function idle(id: string) {
  assertNoPs5ServiceUpdate(id);
  const q = getPs5Queue(id);
  return (
    !['running', 'cancelling'].includes(q.status) &&
    q.items.every((i) => ['installed', 'failed', 'skipped', 'cancelled'].includes(i.state))
  );
}
export async function desktopConsoleSetupInfo(id: unknown) {
  const p = target(id);
  await ps5ServiceStartInfo(p.id);
  const previous = flow(p.id);
  let release: any = null,
    artifactMessage = 'Комплект PS5 пока не включён в эту сборку Windows';
  try {
    const b = await consoleSetupBundle({ verifyFiles: false });
    const service = await readPs5ServiceArtifact();
    release = { ...b.manifest, elf: service.manifest };
    artifactMessage = 'Проверенный ELF и приложение PackageFlow готовы';
  } catch (e) {
    if ((e as any)?.code !== 'ENOENT')
      artifactMessage = e instanceof Error ? e.message : artifactMessage;
  }
  const profiles = await probeConsoleProfile(p.id),
    profile = profiles.consoles.find((v) => v.id === p.id)!;
  const loader: boolean | null = null;
  let installReady = false,
    shadowMount: boolean | null = null;
  // A status read must not open an empty connection to the stock ELF loader.
  if (profile.online && profile.paired) {
    try {
      const r = await ps5ServiceRequest(p.ip, '/api/v1/install/readiness');
      if (r.status === 200 && r.body?.service === 'PackageFlowService-PS5') {
        installReady = profile.capabilities.formats.includes(release?.app?.format);
        shadowMount =
          /^ShadowMountPlus-/.test(r.body?.images?.backend || '') && r.body.images.ready === true
            ? true
            : null;
      }
    } catch {
      /* Unknown stays unknown. */
    }
  }
  const q = getPs5Queue(p.id);
  return {
    consoleId: p.id,
    profile,
    release,
    artifactMessage,
    flow: previous,
    loader,
    webKit: null,
    kstuff: null,
    shadowMount,
    installReady,
    queue: q,
  };
}
export async function beginDesktopPs5Bootstrap(
  id: unknown,
  firmware: unknown,
  confirmedServiceStopped: unknown = false,
) {
  const p = target(id),
    artifact = await readPs5ServiceArtifact().catch((error) => {
      throw createError({
        statusCode: 409,
        message:
          error instanceof Error ? error.message : 'В установщике нет проверенного комплекта PS5',
      });
    });
  if (firmware !== undefined && firmware !== artifact.manifest.firmware)
    throw createError({
      statusCode: 409,
      message: 'Этот комплект ещё не подтверждён для указанной прошивки',
    });
  const previous = flow(p.id);
  if (previous && !['failed', 'completed'].includes(previous.state))
    return desktopConsoleSetupInfo(p.id);
  await beginPs5ServiceStart(
    { consoleId: p.id, requestId: randomBytes(16).toString('hex'), action: 'install' },
    { confirmedServiceStopped: confirmedServiceStopped === true },
  );
  return { consoleId: p.id, flow: flow(p.id) };
}
type DesktopPs5AppSetup = {
  consoleId: string;
  receipt: {
    consoleId: string;
    ip: string;
    requestId: string;
    packageId: string;
    sha256: string;
    queueId: string;
    state: string;
    repairMissingSource: boolean;
    startedAt: number;
  };
  queue: ReturnType<typeof getPs5Queue>;
  retry: Awaited<ReturnType<typeof desktopAppRetryState>>;
};
export async function readDesktopPs5AppSetup(
  id: unknown,
  requestId: unknown,
  updateApp = true,
): Promise<DesktopPs5AppSetup | null> {
  const p = target(id);
  if (typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId))
    throw createError({ statusCode: 400, message: 'Неверный номер установки приложения' });
  const receiptPath = dataPath('console-setup', `app-${p.id}-${requestId}.json`);
  if (!existsSync(receiptPath)) {
    if (updateApp) {
      const bundle = await consoleSetupBundle({ verifyFiles: false }),
        shared = findDesktopPs5AppRequest(p.id, bundle.manifest.app.sha256);
      if (shared) {
        const observed = await readDesktopPs5AppSetup(p.id, shared, true);
        if (
          observed &&
          ['installed', 'active', 'unconfirmed', 'unavailable'].includes(observed.retry)
        )
          return observed;
      }
    }
    return null;
  }
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt.consoleId !== p.id || receipt.ip !== p.ip)
    throw createError({ statusCode: 409, message: 'Профиль приставки изменился' });
  const b = updateApp ? await consoleSetupBundle({ verifyFiles: false }) : null;
  const retry = await desktopAppRetryState(
    getPs5SetupAttempt(p.id, receipt.queueId, receipt.packageId),
    () => {
      const source = getPackage(receipt.packageId);
      return checkPs5InstalledPackage(p.id, p.ip, source, AbortSignal.timeout(15000));
    },
    b
      ? {
          recordedSha256: receipt.sha256,
          targetSha256: b.manifest.app.sha256,
          superseded: latestAppSetupRequest(p)?.requestId !== requestId,
        }
      : undefined,
  );
  return { consoleId: p.id, receipt, queue: getPs5Queue(p.id), retry };
}
// A newer attempt of ANY build invalidates an older same-version success.
// Source identities contain metadata, not the image's byte hash.
function latestAppSetupRequest(
  p: ReturnType<typeof target>,
): { requestId: string; sha256?: string; startedAt: number } | null {
  const directory = dataPath('console-setup');
  if (!existsSync(directory)) return null;
  let latest: { requestId: string; sha256?: string; startedAt: number } | null = null;
  for (const name of readdirSync(directory)) {
    const prefix = name.startsWith(`app-upgrade-${p.id}-`)
      ? `app-upgrade-${p.id}-`
      : `app-${p.id}-`;
    if (!name.startsWith(prefix) || !/^[a-f0-9]{32}\.json$/.test(name.slice(prefix.length)))
      continue;
    const path = dataPath('console-setup', name),
      value = JSON.parse(readFileSync(path, 'utf8'));
    if (value.consoleId !== p.id || value.ip !== p.ip)
      throw createError({
        statusCode: 409,
        message: 'Прежнее обновление относится к другому адресу приставки',
      });
    const entry = {
      requestId: name.slice(prefix.length, -5),
      sha256: value.sha256,
      startedAt: value.startedAt || statSync(path).mtimeMs,
    };
    if (!latest || entry.startedAt > latest.startedAt) latest = entry;
  }
  return latest;
}
export function findDesktopPs5AppRequest(id: unknown, sha256: string): string | null {
  const p = target(id),
    latest = latestAppSetupRequest(p);
  if (!latest || latest.sha256 !== sha256) return null;
  const path = dataPath('console-setup', `app-${p.id}-${latest.requestId}.json`);
  if (!existsSync(path)) return null;
  const receipt = JSON.parse(readFileSync(path, 'utf8')),
    attempt = getPs5SetupAttempt(p.id, receipt.queueId, receipt.packageId);
  return attempt?.state === 'installed' &&
    attempt.confirmation === 'service-registration' &&
    !attempt.alreadyPresent
    ? latest.requestId
    : null;
}
async function assertOtherAppUpdatesSettled(p: ReturnType<typeof target>, requestId: unknown) {
  const directory = dataPath('console-setup');
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    const prefix = `app-upgrade-${p.id}-`;
    if (
      !name.startsWith(prefix) ||
      !/^[a-f0-9]{32}\.json$/.test(name.slice(prefix.length)) ||
      name === `${prefix}${requestId}.json`
    )
      continue;
    const journal = JSON.parse(readFileSync(dataPath('console-setup', name), 'utf8'));
    if (journal.consoleId !== p.id || journal.ip !== p.ip)
      throw createError({
        statusCode: 409,
        message: 'Проверьте результат прежнего обновления на старом адресе PS5',
      });
    for (const command of [
      journal.stopId,
      journal.sourceMissing ? null : journal.deleteId,
      journal.uninstallId,
    ].filter(Boolean)) {
      if (!/^[a-f0-9]{32}$/.test(command))
        throw createError({
          statusCode: 409,
          message: 'Не удалось проверить прежнее обновление приложения',
        });
      const path = dataPath('ps5-game-commands', `${command}.json`);
      const result = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
      if (!result && command === journal.deleteId && desktopAppDeleteWasNotDispatched(journal))
        continue;
      if (!result || !['accepted', 'failed'].includes(result.state))
        throw createError({
          statusCode: 409,
          message: 'Результат прежнего обновления приложения неизвестен. Повтор не отправлен',
        });
      if (
        command === journal.deleteId &&
        result.state === 'accepted' &&
        result.result?.job_id &&
        !journal.deleted
      ) {
        const { ps5ConsoleStorageStatus } = await import('./ps5-console-games');
        const observed = await ps5ConsoleStorageStatus(p.id, command),
          storage = observed.storage;
        const source = journal.sourcePath || result.result.source;
        if (
          !storage ||
          storage.job_id !== result.result.job_id ||
          !source ||
          storage.source !== source ||
          storage.active !== false ||
          storage.state !== 'completed' ||
          storage.result_status !== 0
        )
          throw createError({
            statusCode: 409,
            message: 'Дождитесь подтверждения прежнего удаления PackageFlow',
          });
        journal.deleted = true;
        writeDurableJson(dataPath('console-setup', name), journal);
      }
    }
  }
}
export async function installDesktopPs5App(id: unknown, requestId: unknown, updateApp = false) {
  const done = trackDesktopRequest();
  try {
    return await installDesktopPs5AppInternal(id, requestId, updateApp);
  } finally {
    done();
  }
}
async function appSetupSnapshot(
  p: ReturnType<typeof target>,
  manifest: Awaited<ReturnType<typeof consoleSetupBundle>>['manifest'],
) {
  let snapshot = (await probeConsoleProfile(p.id)).consoles.find((value) => value.id === p.id);
  const startedAt = Date.now();
  // Immediately after an ELF restart, ShadowMount readiness can lag behind the
  // authenticated service. Only that narrow transition permits two fresh reads;
  // an offline, unpaired, changed-address or wrong-firmware result stops here.
  for (
    let retry = 0;
    retry < 2 &&
    snapshot?.id === p.id &&
    snapshot.ip === p.ip &&
    snapshot.platform === 'ps5' &&
    snapshot.online &&
    snapshot.paired &&
    snapshot.firmware === manifest.elf.firmware &&
    !snapshot.capabilities.formats.includes(manifest.app.format);
    retry++
  ) {
    if (Date.now() - startedAt + 500 > 2000) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
    snapshot = (await probeConsoleProfile(p.id)).consoles.find((value) => value.id === p.id);
  }
  return snapshot;
}
async function installDesktopPs5AppInternal(id: unknown, requestId: unknown, updateApp = false) {
  const p = target(id),
    previous = await readDesktopPs5AppSetup(id, requestId, updateApp);
  if (previous) return previous;
  assertNoPs5Bootstrap(p.id, p.ip);
  const receiptPath = dataPath('console-setup', `app-${p.id}-${requestId}.json`);
  assertNoPs5ServiceUpdate(p.id);
  const b = await consoleSetupBundle(),
    snapshot = await appSetupSnapshot(p, b.manifest);
  if (
    !snapshot ||
    snapshot.id !== p.id ||
    snapshot.ip !== p.ip ||
    snapshot.platform !== 'ps5' ||
    !snapshot.online ||
    !snapshot.paired ||
    snapshot.firmware !== b.manifest.elf.firmware ||
    !snapshot.capabilities.formats.includes(b.manifest.app.format)
  )
    throw createError({
      statusCode: 409,
      message:
        'Подключите PS5 и запустите ShadowMount+. Установка этого формата должна быть подтверждена службой',
    });
  const service = /^(\d+)\.(\d+)\.(\d+)(?:-dev)?$/.exec(snapshot.version || '');
  if (
    updateApp &&
    (!service ||
      !(
        Number(service[1]) > 0 ||
        Number(service[2]) > 1 ||
        (Number(service[2]) === 1 && Number(service[3]) >= 28)
      ))
  )
    throw createError({
      statusCode: 409,
      message: 'Сначала обновите ELF службы PS5 до 0.1.28 или новее для замены приложения',
    });
  if ((flow(p.id) && !['completed', 'failed'].includes(flow(p.id)!.state)) || !idle(p.id))
    throw createError({
      statusCode: 409,
      message: 'Дождитесь подтверждения ELF и завершения текущих заданий',
    });
  const lock = claimConsoleWorker('bootstrap', p.ip);
  if (!lock)
    throw createError({ statusCode: 409, message: 'Другой мастер уже выполняет установку' });
  try {
    await assertOtherAppUpdatesSettled(p, requestId);
    // Check again after taking the lock: concurrent clicks must share the receipt.
    if (existsSync(receiptPath))
      return {
        consoleId: p.id,
        receipt: JSON.parse(readFileSync(receiptPath, 'utf8')),
        queue: getPs5Queue(p.id),
      };
    const item = await registerPs5ImageFile(b.appPath),
      source = getPackage(item.id);
    if (
      source.titleId !== b.manifest.app.titleId ||
      source.contentId !== b.manifest.app.contentId ||
      source.appVersion !== b.manifest.app.version
    )
      throw new Error('Приложение изменилось при подготовке');
    let presence = await checkPs5InstalledPackage(p.id, p.ip, source, AbortSignal.timeout(15000));
    if (presence.state === 'installed' && !updateApp)
      return { consoleId: p.id, retry: 'installed', queue: getPs5Queue(p.id) };
    if (
      updateApp &&
      (['installed', 'base-present'].includes(presence.state) ||
        existsSync(dataPath('console-setup', `app-upgrade-${p.id}-${requestId}.json`)))
    ) {
      const { ps5ConsoleGameInfo } = await import('./ps5-console-games');
      const before = await ps5ConsoleGameInfo(p.id, b.manifest.app.titleId);
      // Replace only the owned app; the driver also removes its retained registration.
      if (
        before.installed ||
        existsSync(dataPath('console-setup', `app-upgrade-${p.id}-${requestId}.json`))
      ) {
        presence = await prepareDesktopPs5AppUpgrade(
          p.id,
          p.ip,
          requestId as string,
          b.manifest,
          source,
        );
      }
    }
    let repairMissingSource = false,
      repairIdentity: string | undefined;
    if (presence.state === 'unavailable' || presence.state === 'base-present') {
      // Only repair this bundled application's orphan registration. An unknown
      // catalog or a different application's identity must never become absent.
      const { ps5ConsoleGameInfo } = await import('./ps5-console-games');
      const current = await ps5ConsoleGameInfo(p.id, b.manifest.app.titleId);
      repairMissingSource =
        current.titleId === 'PPSA95001' &&
        current.contentId === b.manifest.app.contentId &&
        current.installed === true &&
        current.sourceAvailable === false &&
        /^\d{2}\.\d{3}\.\d{3}$/.test(current.version || '') &&
        current.version <= b.manifest.app.version;
      if (repairMissingSource) repairIdentity = current.sourceIdentity;
      if (repairMissingSource && updateApp) {
        presence = await prepareDesktopPs5AppUpgrade(
          p.id,
          p.ip,
          requestId as string,
          b.manifest,
          source,
        );
        repairMissingSource = false;
        repairIdentity = undefined;
      }
    }
    if (presence.state === 'base-present' && !repairMissingSource)
      throw createError({
        statusCode: 409,
        message:
          'На PS5 установлена другая версия PackageFlow. Выберите установку / обновление приложения',
      });
    if (presence.state !== 'absent' && !repairMissingSource)
      throw createError({
        statusCode: 409,
        message:
          'PS5 не подтвердила наличие приложения. Установка не отправлена; восстановите связь и проверьте снова',
      });
    const receipt = {
      consoleId: p.id,
      ip: p.ip,
      requestId,
      packageId: item.id,
      sha256: b.manifest.app.sha256,
      queueId: randomBytes(16).toString('hex'),
      state: 'prepared',
      repairMissingSource,
      startedAt: Date.now(),
    };
    writeDurableJson(receiptPath, receipt);
    try {
      const queue = await startPs5Queue({
        consoleId: p.id,
        packageIds: [item.id],
        newQueueId: receipt.queueId,
        appSourceRepair: repairMissingSource
          ? { packageId: item.id, sourceIdentity: repairIdentity! }
          : undefined,
      });
      receipt.state = 'queued';
      writeDurableJson(receiptPath, receipt);
      return { consoleId: p.id, receipt, queue };
    } catch (e) {
      receipt.state = 'unconfirmed';
      writeDurableJson(receiptPath, receipt);
      throw e;
    }
  } finally {
    lock();
  }
}

async function prepareDesktopPs5AppUpgrade(
  id: string,
  ip: string,
  requestId: string,
  manifest: Awaited<ReturnType<typeof consoleSetupBundle>>['manifest'],
  source: ReturnType<typeof getPackage>,
) {
  const {
    ps5ConsoleGameInfo,
    ps5ConsoleActivity,
    ps5ConsoleGameCommand,
    ps5ConsoleGameCommandStatus,
    ps5ConsoleStorageStatus,
  } = await import('./ps5-console-games');
  const { upgradeDesktopApp } = await import('./desktop-app-upgrade');
  const journalPath = dataPath('console-setup', `app-upgrade-${id}-${requestId}.json`);
  return upgradeDesktopApp(
    {
      consoleId: id,
      ip,
      sha256: manifest.app.sha256,
      titleId: manifest.app.titleId,
      contentId: manifest.app.contentId,
      version: manifest.app.version,
      replaceSameVersion: true,
      repairMissingSource: true,
    },
    {
      readJournal: () =>
        existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : null,
      saveJournal: (journal) => writeDurableJson(journalPath, journal),
      info: () => ps5ConsoleGameInfo(id, manifest.app.titleId),
      activity: () => ps5ConsoleActivity(id),
      hasCommand: (request) => existsSync(dataPath('ps5-game-commands', `${request}.json`)),
      command: (body) => ps5ConsoleGameCommand(id, body, { bundledPackageFlowUpdate: true }),
      status: (request) => ps5ConsoleGameCommandStatus(id, request),
      storage: (request) => ps5ConsoleStorageStatus(id, request),
      presence: () => checkPs5InstalledPackage(id, ip, source, AbortSignal.timeout(15000)),
      newId: () => randomBytes(16).toString('hex'),
    },
  );
}

/** This removes the retained source, not only its home-screen registration. */
export async function removeDesktopPs5App(id: unknown, requestId: unknown, confirmed: unknown) {
  const p = target(id);
  if (confirmed !== true || typeof requestId !== 'string' || !/^[a-f0-9]{32}$/.test(requestId))
    throw createError({
      statusCode: 400,
      message: 'Подтвердите удаление PackageFlow и его образа',
    });
  const {
    ps5ConsoleActivity,
    ps5ConsoleGameInfo,
    ps5ConsoleGameCommand,
    ps5ConsoleGameCommandStatus,
  } = await import('./ps5-console-games');
  const commandPath = dataPath('ps5-game-commands', `${requestId}.json`);
  if (existsSync(commandPath)) {
    const command = JSON.parse(readFileSync(commandPath, 'utf8'));
    if (command.titleId !== 'PPSA95001' || command.action !== 'delete')
      throw createError({ statusCode: 409, message: 'Номер удаления относится к другой операции' });
    return ps5ConsoleGameCommandStatus(p.id, requestId);
  }
  const b = await consoleSetupBundle({ verifyFiles: false });
  // No arbitrary title/path may be supplied by the desktop client.
  if (b.manifest.app.titleId !== 'PPSA95001')
    throw createError({ statusCode: 409, message: 'Неизвестный идентификатор PackageFlow' });
  const current = await ps5ConsoleGameInfo(p.id, b.manifest.app.titleId);
  if (
    current.contentId !== b.manifest.app.contentId ||
    !current.managed ||
    !current.canManageSource ||
    !current.sourceAvailable
  )
    throw createError({
      statusCode: 409,
      message: 'PS5 не подтвердила управляемый источник PackageFlow. Удаление не отправлено',
    });
  const active = await ps5ConsoleActivity(p.id);
  if (active.running)
    throw createError({
      statusCode: 409,
      message: 'Закройте игру или приложение на PS5 перед удалением PackageFlow',
    });
  return ps5ConsoleGameCommand(p.id, {
    requestId,
    titleId: current.titleId,
    sourceIdentity: current.sourceIdentity,
    confirmTitleId: current.titleId,
    action: 'delete',
  });
}

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import {
  createFolderPlan,
  verifyFolderSource,
  runFolderPlan,
  cancelFolderPlan,
  type FolderPlan,
  type FolderRequest,
} from './ps5-folder-driver';
import { ps5BaseRegistration } from './ps5-registration';
import { open } from 'node:fs/promises';
import { ps5TransferProfile } from './ps5-transfer-profile';
import { logEvent } from './event-log';
import { ps5AckRejected, ps5SendChunks, ps5TransferProtocol } from './ps5-send-chunks';
import { ps5SourceStamp as stamp } from './ps5-source-hash';
import { Ps5SourceHashCache, cachedPs5SourceHash } from './ps5-source-hash-cache';
import { seedPs5SourceHashHistory } from './ps5-source-hash-history';
import { getPackage } from './package-library';
import {
  ps5OperationRequest,
  Ps5OperationValidationError,
  readPs5PkgInstallCapabilities,
  readPs5ActivatedRouteCapabilities,
} from './console-profiles';
import { Ps5QueueFailure, Ps5QueueUncertain, type Ps5Driver, type Ps5Item } from './ps5-queue-core';
import { ps5InstallCapabilities, ps5PkgInstallMessage } from '../../shared/ps5-install-readiness';
import { getConsoleProfile, ps5RestMode, ps5ServiceRequest } from './console-profiles';
import { ps5ClearsOwnOrphans } from './ps5-qualified-builds';
import { checkPs5InstalledPackage } from './installed-package-check';
import { checkPs5SourceFirmware } from './ps5-installation-firmware';
import {
  isPs5ImageFormat,
  createImagePlan,
  verifyImagePlan,
  runRegisteredImagePlan,
  cancelImagePlan,
  type ImagePlan,
} from './ps5-image-driver';
const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
export function ps5TransferChunkSize(reply: { chunkMax?: unknown }) {
  const size = reply.chunkMax;
  return typeof size === 'number' &&
    Number.isInteger(size) &&
    size >= 262144 &&
    size <= 4194304 &&
    (size & (size - 1)) === 0
    ? size
    : 262144;
}
/** How an installed patch or DLC is confirmed after its installer job, or
 * undefined while that is not proven yet. */
export function ps5ComponentConfirmation(
  item: Pick<Ps5Item, 'order' | 'type' | 'titleId' | 'contentId' | 'appVersion' | 'size'>,
  job: { phase?: unknown; code?: unknown; total?: unknown; bytes_served?: unknown },
  info?: { status: number; body: any },
) {
  if (item.order <= 0) return undefined;
  if (item.type === 'DLC')
    // The last job stays «serving» until the next one starts: a whole file read
    // without an error code counts like a finished job.
    return job.code === 0 &&
      (job.phase === 'done' ||
        (job.phase === 'serving' && job.total === item.size && job.bytes_served === item.size))
      ? {
          confirmation: 'installer-result' as const,
          detail: 'Системный установщик PS5 завершил DLC без ошибки',
        }
      : undefined;
  const row = info?.status === 200 ? info.body : undefined;
  return item.contentId &&
    item.appVersion &&
    row?.title_id === item.titleId &&
    row.installed === true &&
    row.content_id === item.contentId &&
    versionAtLeast(row.version, item.appVersion)
    ? {
        confirmation: 'service-version' as const,
        detail: `PS5 сообщает версию игры ${row.version}`,
      }
    : undefined;
}
/** '01.02' >= '01.02', '01.10' >= '01.02'; a malformed version never matches. */
function versionAtLeast(current: unknown, wanted: string) {
  const parse = (v: unknown) =>
    typeof v === 'string' && /^\d+(?:\.\d+)*$/.test(v) ? v.split('.').map(Number) : undefined;
  const a = parse(current),
    b = parse(wanted);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}
/** Approved replacement of an own Folder/image whose source is gone: the
 * service refuses to publish over the leftover registration, so clear it
 * first (only the service's own orphans are accepted) and wait for PS5. */
export async function ps5ClearOwnOrphanRegistration(
  call: (
    path: Parameters<typeof ps5OperationRequest>[1],
    headers?: Record<string, string>,
    body?: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<{ status: number; body: any }>,
  item: Ps5Item,
  signal: AbortSignal,
  save: (patch: Partial<Ps5Item>) => void,
  wait: (signal: AbortSignal) => Promise<void> = pause,
  clearsOrphans: () => Promise<boolean> = async () => true,
) {
  const read = async () => {
    const info = await call(
      '/api/v1/console/info',
      { 'X-PackageFlow-Title': item.titleId },
      undefined,
      signal,
    );
    // 404: neither ShadowMount nor app.db knows the title, nothing to clear.
    if (info.status === 404) return { installed: false, source_available: false };
    if (info.status !== 200 || info.body?.title_id !== item.titleId)
      throw new Error('PS5 operation unavailable');
    return info.body;
  };
  const identity = (row: any) => {
    if (typeof row.sourceIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceIdentity))
      throw new Error('PS5 operation unavailable');
    return row.sourceIdentity as string;
  };
  let row = await read();
  // An installed own image/Folder: delete its files first (approved reinstall).
  if (row.installed === true && row.source_available === true) {
    if (row.can_manage_source !== true || !['image', 'folder'].includes(row.source_type))
      throw new Ps5QueueFailure(
        'PS5 не разрешает удалить прежние файлы этой игры. Переустановка не отправлена',
      );
    // Files go first, then the registration: a service that cannot clear the
    // leftover registration would leave the game in the menu without files.
    if (!(await clearsOrphans()))
      throw new Ps5QueueFailure(
        'Служба PS5 старше сборки 029d не снимает регистрацию после удаления файлов. Файлы игры не удалялись; обновите службу: «Сервис ▾» → «Проверить обновления»',
      );
    const deleteId = item.sourceDeleteId || randomBytes(16).toString('hex');
    save({ sourceDeleteId: deleteId, detail: 'Удаляем прежние файлы игры на PS5' });
    const d = await call(
      '/api/v1/console/command',
      {
        'X-PackageFlow-Request-Id': deleteId,
        'X-PackageFlow-Title': item.titleId,
        'X-PackageFlow-Action': 'delete',
        'X-PackageFlow-Source-Identity': identity(row),
        'X-PackageFlow-Confirm-Title': item.titleId,
      },
      undefined,
      signal,
    );
    if (d.status !== 200)
      throw new Ps5QueueFailure(`PS5 не удалила прежние файлы этой игры (${d.status})`);
    let gone = false;
    for (let attempt = 0; attempt < 30 && !gone; attempt++) {
      await wait(signal);
      row = await read();
      gone = row.source_available !== true;
    }
    if (!gone)
      throw new Ps5QueueUncertain('Удаление прежних файлов не подтверждено. Повтор не отправлен');
    save({ detail: 'Прежние файлы удалены' });
  }
  if (row.installed !== true || row.source_available !== false) return;
  identity(row);
  const requestId = item.orphanClearId || randomBytes(16).toString('hex');
  save({ orphanClearId: requestId, detail: 'Снимаем прежнюю регистрацию игры на PS5' });
  const r = await call(
    '/api/v1/console/command',
    {
      'X-PackageFlow-Request-Id': requestId,
      'X-PackageFlow-Title': item.titleId,
      'X-PackageFlow-Action': 'uninstall',
      'X-PackageFlow-Source-Identity': identity(row),
      'X-PackageFlow-Confirm-Title': item.titleId,
    },
    undefined,
    signal,
  );
  if (r.status !== 200)
    throw new Ps5QueueFailure(
      r.status === 409
        ? 'PS5 не сняла прежнюю регистрацию этой игры (409). Нужна служба PS5 с очисткой регистраций, закрытая игра и неизменная запись'
        : `PS5 не сняла прежнюю регистрацию этой игры (${r.status})`,
    );
  for (let attempt = 0; attempt < 30; attempt++) {
    await wait(signal);
    if ((await read()).installed !== true) {
      save({ detail: 'Прежняя регистрация снята. Публикуем игру заново' });
      return;
    }
  }
  throw new Ps5QueueUncertain('Снятие прежней регистрации не подтверждено. Повтор не отправлен');
}
export function ps5QueueDriver(consoleId: string): Ps5Driver {
  const request = async (
    item: Ps5Item,
    path: Parameters<typeof ps5OperationRequest>[1],
    headers = {},
    body?: Uint8Array,
    signal?: AbortSignal,
    onUpload?: (bytes: number) => void,
  ) => {
    const r = await ps5OperationRequest(
      consoleId,
      path,
      { 'X-PackageFlow-Transfer-Id': item.transferId, ...headers },
      body,
      signal,
      onUpload,
    ).catch((error) => {
      if (error instanceof Ps5OperationValidationError)
        throw new Ps5QueueFailure(
          'WEB отклонил параметры команды PS5. Требуется исправление WEB; это не потеря связи с приставкой',
        );
      throw error;
    });
    if ([400, 401, 403, 413, 422].includes(r.status))
      throw new Ps5QueueFailure(`Сервис PS5 отклонил операцию (${r.status})`);
    if (r.status >= 500) {
      const reason = typeof r.body?.error === 'string' ? r.body.error.slice(0, 80) : 'no detail';
      logEvent('warn', `PS5: ${path} → HTTP ${r.status} (${reason})`);
      throw Object.assign(new Error('PS5 operation unavailable'), {
        batchRejected: path === '/api/v1/transfers/batch',
      });
    }
    return r;
  };
  const planPath = (item: Ps5Item) =>
    dataPath(`consoles/${consoleId}/${item.transferId}.folder-plan.json`);
  const readPlan = (item: Ps5Item): FolderPlan | undefined => {
    if (!existsSync(planPath(item))) return;
    try {
      return JSON.parse(readFileSync(planPath(item), 'utf8'));
    } catch {
      throw new Ps5QueueFailure('Не удалось прочитать сохранённый план Folder');
    }
  };
  const folderRequest: FolderRequest = (id, path, headers, body, signal, onUpload) =>
    request(
      { transferId: id } as Ps5Item,
      path as Parameters<typeof ps5OperationRequest>[1],
      headers,
      body,
      signal,
      onUpload,
    );
  const imagePlanPath = (item: Ps5Item) =>
    dataPath(`consoles/${consoleId}/${item.transferId}.image-plan.json`);
  const readImagePlan = (item: Ps5Item): ImagePlan | undefined => {
    if (!existsSync(imagePlanPath(item))) return;
    try {
      return JSON.parse(readFileSync(imagePlanPath(item), 'utf8'));
    } catch {
      throw new Ps5QueueFailure('Не удалось прочитать сохранённый план образа');
    }
  };
  const firmwareGate = async (source: ReturnType<typeof getPackage>, signal: AbortSignal) => {
    const assessment = await checkPs5SourceFirmware(consoleId, source, signal);
    if (assessment.state === 'unavailable')
      return { state: 'waiting' as const, detail: assessment.detail };
    if (assessment.state !== 'compatible') throw new Ps5QueueFailure(assessment.detail);
  };
  const clearOwnOrphanRegistration = (
    item: Ps5Item,
    signal: AbortSignal,
    save: (patch: Partial<Ps5Item>) => void,
  ) =>
    ps5ClearOwnOrphanRegistration(
      (...args) => request(item, ...args),
      item,
      signal,
      save,
      undefined,
      async () => {
        const ip = getConsoleProfile(consoleId).ip;
        const health = await ps5ServiceRequest(ip, '/health', signal);
        const capabilities = await ps5ServiceRequest(ip, '/api/v1/capabilities', signal).catch(
          () => undefined,
        );
        return ps5ClearsOwnOrphans(
          health.body?.serviceReport?.buildId,
          capabilities?.body?.capabilities,
        );
      },
    );
  const installedGate = async (item: Ps5Item, signal: AbortSignal) => {
    if (item.overwriteApproved === true) return;
    const source = getPackage(item.packageId),
      profile = getConsoleProfile(consoleId);
    const check = await checkPs5InstalledPackage(
      consoleId,
      profile.ip,
      { ...source, format: item.format },
      signal,
    );
    if (check.state === 'unavailable') return { state: 'waiting' as const, detail: check.detail };
    if (check.state === 'installed')
      return {
        state: 'installed' as const,
        confirmation: 'service-existing' as const,
        confirmedAt: Date.now(),
        alreadyPresent: true,
        detail: check.detail,
      };
    if (check.state === 'base-present')
      return { state: 'skipped' as const, alreadyPresent: true, detail: check.detail };
  };
  return {
    async cancel(item) {
      if (isPs5ImageFormat(item.format)) {
        await cancelImagePlan(readImagePlan(item), item, folderRequest);
        return;
      }
      if (item.format === 'folder') {
        await cancelFolderPlan(readPlan(item), item, folderRequest);
        return;
      }
      const r = await request(item, '/api/v1/transfers/cancel');
      if ([200, 404].includes(r.status)) return;
      // Verification may have finished while cancellation was travelling. The
      // service retains a verified file; we can drop the WEB task only if it was
      // never passed to the installer. Do not stop or delete a system job.
      if (r.status === 409) {
        const transfer = await request(item, '/api/v1/transfers/status'),
          install = await request(item, '/api/v1/install/status');
        if (
          transfer.status === 200 &&
          transfer.body.id === item.transferId &&
          transfer.body.verified === true &&
          install.status === 404
        )
          return;
      }
      throw new Error('Cancellation not confirmed');
    },
    async run(item, signal, save) {
      // A sleeping PS5 is not contacted; the queue resumes after it wakes up.
      if (ps5RestMode(consoleId))
        return {
          ...(item.installDispatched ? {} : { state: 'waiting' as const }),
          detail: 'PS5 в режиме покоя. Передача продолжится после пробуждения',
        };
      const capture = (body: any, offset: number, bytes: number) => {
        const profile = ps5TransferProfile(body, offset, bytes);
        if (profile) item.transferProfile = profile;
      };
      const profiledRequest: FolderRequest = Object.assign(
        (...args: Parameters<FolderRequest>) => folderRequest(...args),
        {
          onTransferProfile: capture,
          adaptiveKey: consoleId,
          // Images report live bytes of the batch on the way (display only).
          onUpload: (bytes: number) => save({ bytesInFlight: bytes }),
        },
      );
      if (isPs5ImageFormat(item.format)) {
        let plan = readImagePlan(item);
        if (item.installDispatched) {
          if (!plan || item.hash !== plan.imageHash)
            throw new Ps5QueueUncertain('План принятого образа недоступен. Повтор не отправлен');
          return runRegisteredImagePlan(plan, item, signal, profiledRequest, save);
        }
        const source = getPackage(item.packageId);
        if (
          source.size !== item.size ||
          source.contentId !== item.contentId ||
          source.appVersion !== item.appVersion
        )
          throw new Ps5QueueFailure('Образ изменился в библиотеке');
        let capabilities = await readPs5ActivatedRouteCapabilities(consoleId, signal);
        if (capabilities === undefined) {
          const readiness = await request(item, '/api/v1/install/readiness', {}, undefined, signal);
          capabilities = ps5InstallCapabilities(
            readiness.status,
            readiness.body,
            getConsoleProfile(consoleId).firmware,
          );
        }
        if (!capabilities.images?.ready || !capabilities.formats.includes(item.format))
          return {
            state: 'waiting',
            detail: 'Для установки образов требуется проверенный и запущенный ShadowMount+',
          };
        const denied = await firmwareGate(source, signal);
        if (denied) return denied;
        const present = await installedGate(item, signal);
        if (present) return present;
        if (item.overwriteApproved === true) await clearOwnOrphanRegistration(item, signal, save);
        if (plan) await verifyImagePlan(plan, item, source.path);
        else {
          save({
            state: 'verifying',
            progressPhase: 'source-check',
            bytesChecked: 0,
            detail: 'Проверяем исходный образ PS5',
          });
          plan = await createImagePlan(source.path, item, signal, (bytesChecked) =>
            save({ bytesChecked }),
          );
          writeDurableJson(imagePlanPath(item), plan);
        }
        save({ hash: plan.imageHash, sourceStamp: plan.stamp, bytesChecked: item.size });
        return runRegisteredImagePlan(plan, item, signal, profiledRequest, save);
      }
      if (item.format === 'folder') {
        let plan = readPlan(item);
        if (item.installDispatched) {
          if (!plan || item.hash !== plan.manifestHash)
            throw new Ps5QueueFailure('План принятого Folder недоступен. Повтор не отправлен');
          return runFolderPlan(plan, item, signal, profiledRequest, save);
        }
        const source = getPackage(item.packageId);
        if (
          source.size !== item.size ||
          source.contentId !== item.contentId ||
          source.appVersion !== item.appVersion
        )
          throw new Ps5QueueFailure('Folder изменился в библиотеке');
        let capabilities = await readPs5ActivatedRouteCapabilities(consoleId, signal);
        if (capabilities === undefined) {
          const readiness = await request(item, '/api/v1/install/readiness', {}, undefined, signal);
          capabilities = ps5InstallCapabilities(
            readiness.status,
            readiness.body,
            getConsoleProfile(consoleId).firmware,
          );
        }
        if (!capabilities.formats.includes('folder'))
          return { state: 'waiting', detail: 'Служба ещё не подтвердила маршрут Folder' };
        const denied = await firmwareGate(source, signal);
        if (denied) return denied;
        const present = await installedGate(item, signal);
        if (present) return present;
        if (item.overwriteApproved === true) await clearOwnOrphanRegistration(item, signal, save);
        if (plan) await verifyFolderSource(plan, item, source.path, signal);
        else {
          save({
            state: 'verifying',
            progressPhase: 'source-check',
            bytesChecked: 0,
            detail: capabilities.folder?.streamProtocol
              ? 'Читаем список файлов и метаданные Folder'
              : 'Проверяем файлы исходной папки',
          });
          plan = await createFolderPlan(
            source.path,
            item,
            signal,
            (bytesChecked) => save({ bytesChecked }),
            capabilities.folder?.streamProtocol === 'folder-stream-v2',
          );
          writeDurableJson(planPath(item), plan);
        }
        if (plan.manifestHash) save({ hash: plan.manifestHash, bytesChecked: item.size });
        return runFolderPlan(
          plan,
          item,
          signal,
          profiledRequest,
          save,
          capabilities.folder?.verificationWindow,
          (p) => writeDurableJson(planPath(item), p),
        );
      }
      // An intent is durably recorded BEFORE dispatch. Recovery never submits it again.
      if (item.installDispatched) {
        const receipt = await request(item, '/api/v1/install/status', {}, undefined, signal).catch(
          () => {
            signal.throwIfAborted();
            throw new Ps5QueueUncertain(
              'Не удалось прочитать результат установки. Повтор не отправлен',
            );
          },
        );
        if (receipt.status !== 200)
          throw new Ps5QueueUncertain(
            'Сохранённый результат установки недоступен. Повтор не отправлен',
          );
        if (receipt.body.state === 'submitting')
          return { state: 'installing', detail: 'Ожидаем ответ системного установщика' };
        if (receipt.body.ok === false)
          throw new Ps5QueueFailure('Системный установщик отклонил пакет');
        if (!receipt.body.ok || !/^[0-9-]{1,63}$/.test(receipt.body.job || ''))
          throw new Ps5QueueUncertain('Результат отправки неизвестен. Нужна сверка с приставкой');
        save({ serviceJobId: receipt.body.job });
        const job = await request(
          item,
          '/api/v1/installer/job',
          { 'X-PackageFlow-Installer-Job': receipt.body.job },
          undefined,
          signal,
        ).catch(() => {
          signal.throwIfAborted();
          throw new Ps5QueueUncertain(
            'Не удалось прочитать системное задание. Повтор не отправлен',
          );
        });
        if (job.status !== 200 || !job.body.ok)
          throw new Ps5QueueUncertain('Системное задание недоступно. Повтор не отправлен');
        if (job.body.phase === 'failed')
          throw new Ps5QueueFailure(
            `Ошибка системной установки: 0x${Number(job.body.code || 0)
              .toString(16)
              .toUpperCase()}`,
          );
        if (
          item.order === 0 &&
          item.contentId &&
          item.appVersion &&
          ['done', 'serving'].includes(job.body.phase) &&
          job.body.code === 0 &&
          job.body.total === item.size &&
          job.body.bytes_served === item.size
        ) {
          const registration = await request(
            item,
            '/api/v1/install/verify',
            {
              'X-PackageFlow-Title': item.titleId,
              'X-PackageFlow-Content': item.contentId,
              'X-PackageFlow-Version': item.appVersion,
              'X-PackageFlow-Installer-Job': receipt.body.job,
            },
            undefined,
            signal,
          ).catch(() => ({ status: 503, body: {} }));
          signal.throwIfAborted();
          if (ps5BaseRegistration(item, job.body, registration))
            return {
              state: 'installed',
              confirmation: 'service-registration',
              confirmedAt: Date.now(),
              detail: `PS5 подтвердила регистрацию игры, версия ${item.appVersion}`,
            };
        }
        // A patch is confirmed by the version PS5 reports for the game; a DLC
        // (PS5 cannot list them yet) by a finished installer job without an
        // error. Until then the item stays unconfirmed and is re-checked.
        const info =
          item.order > 0 && item.type !== 'DLC'
            ? await request(
                item,
                '/api/v1/console/info',
                { 'X-PackageFlow-Title': item.titleId },
                undefined,
                signal,
              ).catch(() => undefined)
            : undefined;
        signal.throwIfAborted();
        const component = ps5ComponentConfirmation(item, job.body, info);
        if (component) return { state: 'installed', confirmedAt: Date.now(), ...component };
        // Full coverage alone never confirms a patch/DLC or a different version.
        if (
          job.body.phase === 'done' ||
          (job.body.phase === 'serving' &&
            job.body.code === 0 &&
            job.body.total === item.size &&
            job.body.bytes_served === item.size)
        )
          throw new Ps5QueueUncertain(
            'Пакет полностью передан установщику. Если установка завершилась на PS5, подтвердите результат',
          );
        return { state: 'installing', detail: 'PS5 выполняет системное задание' };
      }
      let source: ReturnType<typeof getPackage>;
      try {
        source = getPackage(item.packageId);
      } catch {
        throw new Ps5QueueFailure('Пакет больше не доступен в библиотеке');
      }
      if (
        source.size !== item.size ||
        source.contentId !== item.contentId ||
        source.appVersion !== item.appVersion
      )
        throw new Ps5QueueFailure('Пакет изменился в библиотеке. Просканируйте его повторно');
      if (item.format !== 'pkg')
        throw new Ps5QueueFailure('Backend этого формата ещё не проверен на PS5');
      // Check before hashing/transferring gigabytes. Recovery of accepted jobs
      // above does not depend on current admission and never resubmits them.
      const capabilities = await readPs5PkgInstallCapabilities(consoleId, signal);
      if (!capabilities.installation?.ready || !capabilities.formats.includes('pkg'))
        return { state: 'waiting', detail: ps5PkgInstallMessage(capabilities) };
      if (
        !(item.platform === 'ps4'
          ? capabilities.installPs4
          : item.platform === 'ps5' && capabilities.installPs5)
      )
        throw new Ps5QueueFailure('Этот маршрут установки не проверен для платформы пакета');
      if (item.platform === 'ps5') {
        const denied = await firmwareGate(source, signal);
        if (denied) return denied;
      }
      const present = await installedGate(item, signal);
      if (present) return present;
      const file = await open(source.path, 'r').catch(() => {
        throw new Ps5QueueFailure('Не удалось открыть исходный пакет');
      });
      try {
        const initial = await file.stat(),
          identity = stamp(initial);
        if (
          !initial.isFile() ||
          initial.size !== item.size ||
          (item.sourceStamp && item.sourceStamp !== identity)
        )
          throw new Ps5QueueFailure('Исходный файл изменился; передача остановлена');
        if (!item.hash) {
          save({
            state: 'verifying',
            progressPhase: 'source-check',
            bytesChecked: 0,
            detail: 'Проверяем целостность исходного пакета',
          });
          const cache = new Ps5SourceHashCache(source.path);
          await seedPs5SourceHashHistory(cache, signal, item.packageId);
          let hash: string;
          try {
            hash = await cachedPs5SourceHash(
              cache,
              '.',
              file,
              initial.size,
              identity,
              signal,
              (bytesChecked) => save({ bytesChecked }),
            );
          } catch (error) {
            signal.throwIfAborted();
            throw new Ps5QueueFailure(
              error instanceof Error ? error.message : 'Проверка исходного пакета не завершилась',
            );
          } finally {
            cache.flush();
          }
          save({ hash, sourceStamp: identity, bytesChecked: initial.size });
        }
        let response = await request(
          item,
          '/api/v1/transfers/begin',
          { 'X-PackageFlow-Size': String(item.size), 'X-PackageFlow-Blake3': item.hash! },
          undefined,
          signal,
        );
        if (response.status === 409)
          response = await request(item, '/api/v1/transfers/status', {}, undefined, signal);
        const valid = (body: any) =>
          body?.id === item.transferId &&
          body.size === item.size &&
          body.blake3 === item.hash &&
          Number.isSafeInteger(body.bytesDurable) &&
          body.bytesDurable >= 0 &&
          body.bytesDurable <= item.size &&
          body.cancelled === false;
        if (response.status !== 200 || !valid(response.body))
          throw new Ps5QueueFailure('PS5 не подтвердила состояние передачи');
        const offset = response.body.bytesDurable;
        const protocol = ps5TransferProtocol(response.body);
        save({
          state: 'sending',
          progressPhase: 'transfer',
          bytesSent: offset,
          bytesInFlight: 0,
          detail: 'Передаём пакет на PS5 с докачкой',
        });
        await ps5SendChunks({
          read: async (buffer, position) =>
            (await file.read(buffer, 0, buffer.length, position)).bytesRead,
          size: item.size,
          offset,
          chunkSize: protocol.size,
          adaptiveKey: protocol.path === '/api/v1/transfers/batch' ? consoleId : undefined,
          signal,
          validateSource: async () => stamp(await file.stat()) === identity,
          send: async (position, bytes) => {
            const ack = await request(
              item,
              protocol.path,
              { 'X-PackageFlow-Offset': String(position) },
              bytes,
              signal,
              (sent) => save({ bytesInFlight: sent }),
            );
            if (
              ack.status !== 200 ||
              !valid(ack.body) ||
              ack.body.bytesDurable !== position + bytes.length
            )
              throw ps5AckRejected('Chunk', ack, position, bytes.length);
            capture(ack.body, position, bytes.length);
          },
          progress: (bytesSent) => save({ bytesSent, bytesInFlight: 0 }),
        });
        save({
          state: 'verifying',
          progressPhase: 'device-check',
          detail: 'PS5 проверяет BLAKE3 полученного пакета',
        });
        response = await request(item, '/api/v1/transfers/commit', {}, undefined, signal);
        if (![200, 202, 409].includes(response.status))
          throw new Ps5QueueFailure('Проверка пакета не началась');
        if (response.status === 409)
          return {
            state: 'waiting',
            detail: 'Служба завершает другую операцию; проверка будет продолжена',
          };
        for (;;) {
          signal.throwIfAborted();
          const transfer = await request(item, '/api/v1/transfers/status', {}, undefined, signal);
          if (transfer.status !== 200 || !valid(transfer.body))
            throw new Ps5QueueFailure('Состояние пакета на PS5 изменилось');
          if (transfer.body.verified === true) break;
          const operation = await request(item, '/api/v1/operations/status', {}, undefined, signal);
          if (
            operation.body.id === item.transferId &&
            !operation.body.running &&
            operation.body.status !== 200
          )
            throw new Ps5QueueFailure('Проверка целостности на PS5 завершилась ошибкой');
          if (!operation.body.running && operation.body.id !== item.transferId)
            return {
              state: 'waiting',
              detail: 'Служба перезапустилась. Повторим только проверку целостности',
            };
          await pause(signal);
        }
        signal.throwIfAborted();
        if (item.cancelRequested) signal.throwIfAborted();
        save({
          state: 'installing',
          installDispatched: true,
          detail: 'Передаём проверенный пакет системному установщику',
        });
        response = await request(item, '/api/v1/install/staged', {}, undefined, signal);
        if (![200, 202].includes(response.status))
          throw new Ps5QueueUncertain(
            'Ответ установщика потерян. Проверяем сохранённый результат без повторной отправки',
          );
        return { state: 'installing' };
      } finally {
        await file.close();
      }
    },
  };
}

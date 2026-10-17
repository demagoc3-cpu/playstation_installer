import { existsSync, readFileSync } from 'node:fs';
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
import { getConsoleProfile } from './console-profiles';
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

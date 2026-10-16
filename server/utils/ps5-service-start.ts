import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createError } from 'h3';
import type { Ps5ServiceRelease, Ps5ServiceStartInfo } from '../../shared/types/ps5-service-start';
import { getConsoleProfile, ps5ServiceRequest } from './console-profiles';
import { claimConsoleWorker } from './console-worker-lock';
import { assertNoConsoleSpeedTest } from './console-speed-lock';
import { assertNoPs5ServiceUpdate } from './ps5-service-updates';
import { assertDesktopWritable, trackDesktopRequest } from './desktop-lifecycle';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { bootstrapHealth } from './ps5-bootstrap-driver';
import { readPs5ServiceArtifact, PS5_SERVICE_ELF_FILE_NAME } from './ps5-service-artifact';
import {
  isPs5StoredServicePayload,
  readPs5PayloadManager,
  storePs5ServicePayload,
  launchPs5StoredPayload,
  type Ps5StoredPayload,
} from './ps5-payload-manager';
import {
  runPs5ServiceLaunch,
  ps5ServiceLaunchReceipt,
  type Ps5ServiceLaunchRecord,
} from './ps5-service-start-driver';

const running = new Set<string>();
const terminal = (state: string) => state === 'completed' || state === 'failed';
const journalPath = (id: string) => dataPath('console-setup', `bootstrap-${id}.json`);
const requestPath = (id: string, request: string) =>
  dataPath('console-setup', 'service-start', `${id}-${request}.json`);
const receiptPath = (id: string) => dataPath('console-setup', `saved-service-${id}.json`);
const artifactConfigured = () =>
  [
    'ps5-service-artifacts/manifest.json',
    'console-setup/service-manifest.json',
    'console-setup/manifest.json',
  ].some((path) => existsSync(dataPath(path)));

function target(id: unknown) {
  const profile = getConsoleProfile(id);
  if (profile.platform !== 'ps5' || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.id))
    throw createError({ statusCode: 400, message: 'Для запуска службы выберите профиль PS5' });
  return profile;
}
function readJson(path: string, maximum = 64 * 1024): any {
  if (!existsSync(path)) return null;
  try {
    const bytes = readFileSync(path);
    if (bytes.length > maximum) throw new Error('Oversize journal');
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw createError({
      statusCode: 503,
      message: 'Не удалось прочитать журнал запуска PS5. Повтор заблокирован',
    });
  }
}
function validRelease(value: any): value is Ps5ServiceRelease {
  return !!(
    value &&
    value.fileName === PS5_SERVICE_ELF_FILE_NAME &&
    Number.isSafeInteger(value.size) &&
    value.size >= 4096 &&
    value.size <= 4 * 1024 ** 2 &&
    /^[a-f0-9]{64}$/.test(value.sha256 || '') &&
    /^\d+\.\d+\.\d+(?:-dev)?$/.test(value.version || '') &&
    /^[a-z0-9-]{1,64}$/.test(value.buildId || '') &&
    value.firmware === '13.60'
  );
}
function savedFlow(id: string, path = journalPath(id)): Ps5ServiceLaunchRecord | null {
  const value = readJson(path);
  if (!value) return null;
  if (
    value.consoleId !== id ||
    !/^[a-f0-9]{32}$/.test(value.id || '') ||
    !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.ip || '') ||
    !/^[a-f0-9]{64}$/.test(value.sha256 || '') ||
    typeof value.version !== 'string' ||
    typeof value.buildId !== 'string' ||
    value.firmware !== '13.60' ||
    !Number.isSafeInteger(value.startedAt) ||
    ![
      'checking',
      'starting',
      'sending',
      'verifying',
      'completed',
      'failed',
      'unconfirmed',
    ].includes(value.state) ||
    (value.dispatched !== undefined && typeof value.dispatched !== 'boolean') ||
    (value.action !== undefined && !['start', 'install'].includes(value.action))
  )
    throw createError({
      statusCode: 503,
      message: 'Журнал запуска PS5 повреждён. Повтор заблокирован',
    });
  return {
    ...value,
    state: value.state === 'sending' ? 'starting' : value.state,
    action: value.action || 'start',
    dispatched: value.dispatched ?? ['sending', 'verifying', 'unconfirmed'].includes(value.state),
  };
}
function persist(flow: Ps5ServiceLaunchRecord) {
  // The existing queue/update/Windows admission gate reads this same journal.
  // Its legacy state spelling must remain compatible with installed launchers.
  writeDurableJson(journalPath(flow.consoleId), {
    ...flow,
    state: flow.state === 'starting' ? 'sending' : flow.state,
  });
  writeDurableJson(requestPath(flow.consoleId, flow.id), flow);
}
function storedReceipt(profile: ReturnType<typeof target>) {
  const value = readJson(receiptPath(profile.id));
  if (!value) return null;
  if (
    value.consoleId !== profile.id ||
    value.ip !== profile.ip ||
    !validRelease(value.release) ||
    !isPs5StoredServicePayload(value.entry)
  )
    throw createError({
      statusCode: 503,
      message: 'Не удалось подтвердить сохранённую нагрузку PS5',
    });
  return value as {
    consoleId: string;
    ip: string;
    release: Ps5ServiceRelease;
    entry: Ps5StoredPayload;
  };
}
async function health(ip: string) {
  try {
    return await ps5ServiceRequest(ip, '/health');
  } catch (error: any) {
    if (error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') return null;
    // Timeout, a malformed reply and an unreachable network do not prove absence.
    throw error;
  }
}
async function manager(profile: ReturnType<typeof target>, release?: Ps5ServiceRelease) {
  let result: Awaited<ReturnType<typeof readPs5PayloadManager>>;
  try {
    result = await readPs5PayloadManager(profile.ip);
  } catch {
    return { available: false, known: false };
  }
  const matches = result.payloads.filter((item) => item.filename === PS5_SERVICE_ELF_FILE_NAME);
  if (matches.length > 1 || (matches[0] && !isPs5StoredServicePayload(matches[0])))
    throw createError({
      statusCode: 409,
      message: 'Сохранённые нагрузки PackageFlow неоднозначны. Проверьте записи PLDMGR',
    });
  const entry = matches[0],
    receipt = storedReceipt(profile);
  return {
    available: true,
    entry,
    known: !!(
      entry &&
      receipt &&
      release &&
      receipt.entry.path === entry.path &&
      receipt.entry.slot === entry.slot &&
      receipt.entry.version === entry.version &&
      receipt.entry.buildId === entry.buildId &&
      receipt.release.sha256 === release.sha256 &&
      receipt.release.version === release.version &&
      receipt.release.buildId === release.buildId &&
      receipt.release.firmware === release.firmware
    ),
  };
}
function assertTarget(profile: ReturnType<typeof target>) {
  const current = target(profile.id);
  if (current.ip !== profile.ip || (current.firmware && current.firmware !== '13.60'))
    throw createError({
      statusCode: 409,
      message: 'Адрес или прошивка PS5 изменились. Запуск остановлен',
    });
}
function assertIdle(profile: ReturnType<typeof target>) {
  assertDesktopWritable();
  assertNoConsoleSpeedTest(profile.id);
  assertNoPs5ServiceUpdate(profile.id);
  const queue = readJson(
    dataPath('consoles', profile.id, 'ps5-installation-queue.json'),
    32 * 1024 ** 2,
  );
  if (queue) {
    const settled = (item: any) =>
      ['installed', 'failed', 'skipped', 'cancelled'].includes(item.state) &&
      !item.observationStoppedAt;
    const terminalQueue =
      ['idle', 'completed', 'failed', 'cancelled'].includes(queue.status) &&
      Array.isArray(queue.items) &&
      queue.items.every(settled);
    // An already authorised queue waiting for a missing service can resume.
    // Never reclassify a partial transfer or a dispatched Sony task as idle.
    const awaitingService =
      ['running', 'paused'].includes(queue.status) &&
      Array.isArray(queue.items) &&
      queue.items.every(
        (item: any) =>
          settled(item) ||
          (['pending', 'waiting'].includes(item.state) &&
            item.bytesSent === 0 &&
            !item.installDispatched &&
            !item.observationStoppedAt),
      );
    if (!(
      queue.version === 1 &&
      queue.consoleId === profile.id &&
      queue.psIp === profile.ip &&
      (terminalQueue || awaitingService)
    ))
      throw createError({
        statusCode: 409,
        message: 'У PS5 есть незавершённые задания. Дождитесь их завершения',
      });
  }
}
function servicePortConnects(ip: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: ip, port: 8095 });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (['ECONNREFUSED', 'ETIMEDOUT'].includes(error.code || '')) resolve(false);
      else reject(error);
    });
  });
}
function loader(ip: string, bytes: Buffer) {
  return new Promise<{ send(): Promise<void>; close(): void }>((resolve, reject) => {
    const socket = createConnection({ host: ip, port: 9021 });
    let connected = false;
    socket.setTimeout(4000, () =>
      socket.destroy(new Error('Загрузчик PS5 не ответил на порту 9021')),
    );
    socket.once('error', reject);
    socket.once('close', () => {
      if (!connected) reject(new Error('Загрузчик PS5 закрыл соединение'));
    });
    socket.once('connect', () => {
      connected = true;
      socket.setTimeout(15000, () => socket.destroy(new Error('Таймаут передачи ELF')));
      resolve({
        close: () => socket.destroy(),
        send: () =>
          new Promise<void>((done, fail) => {
            socket.once('error', fail);
            socket.once('close', () =>
              fail(new Error('Передача ELF прервана. Проверьте результат')),
            );
            socket.end(bytes, () => {
              socket.off('error', fail);
              done();
            });
          }),
      });
    });
  });
}
function publicOperation(flow: Ps5ServiceLaunchRecord) {
  const { id, consoleId, state, method, version, buildId, message, startedAt } = flow;
  return { id, consoleId, state, method, version, buildId, message, startedAt };
}

/** Read/reconcile only: this path never contacts the ELF loader or sends a launch. */
export async function ps5ServiceStartInfo(id: unknown): Promise<Ps5ServiceStartInfo> {
  const profile = target(id),
    previous = savedFlow(profile.id);
  if (
    previous &&
    previous.ip === profile.ip &&
    !terminal(previous.state) &&
    !previous.dispatched &&
    !running.has(profile.ip)
  ) {
    // Only a reclaimed shared lock proves that no other WEB/Windows runner owns
    // this pre-dispatch intent. A crash cannot leave the button polling forever.
    const unlock = claimConsoleWorker('bootstrap', profile.ip);
    if (unlock)
      try {
        const fresh = savedFlow(profile.id);
        assertTarget(profile);
        if (fresh?.id === previous.id && !fresh.dispatched && !terminal(fresh.state)) {
          previous.state = 'failed';
          previous.message = 'WEB остановился до отправки команды. Выполните новую проверку службы';
          persist(previous);
        }
      } finally {
        unlock();
      }
  }
  let artifact: Ps5ServiceRelease | undefined,
    artifactMessage = '';
  try {
    artifact = (await readPs5ServiceArtifact()).manifest;
  } catch (error) {
    artifactMessage = error instanceof Error ? error.message : 'Комплект службы PS5 не найден';
  }
  const release = artifact || (!artifactConfigured() ? storedReceipt(profile)?.release : undefined);
  let state: Ps5ServiceStartInfo['state'] = 'unknown',
    message = 'Связь со службой пока не подтверждена';
  try {
    const response = await health(profile.ip);
    if (!response) {
      state = 'stopped';
      message = 'Служба PackageFlow остановлена';
    } else if (release && ps5ServiceLaunchReceipt(release, response)) {
      state = 'running';
      message = 'Служба PackageFlow работает';
    } else {
      state = 'different-version';
      message = 'На PS5 уже отвечает служба. Проверьте версию и используйте обновление';
    }
    if (
      previous &&
      previous.ip === profile.ip &&
      !running.has(profile.ip) &&
      !terminal(previous.state) &&
      response &&
      ps5ServiceLaunchReceipt(previous, response)
    ) {
      previous.state = 'completed';
      previous.message = 'Запуск службы подтверждён';
      persist(previous);
    }
  } catch {
    // A GET never converts a timeout into permission to send another ELF.
  }
  let pm: Awaited<ReturnType<typeof manager>> = { available: false, known: false };
  let managerConflict = false;
  try {
    pm = await manager(profile, release);
  } catch (error) {
    managerConflict = true;
    message = error instanceof Error ? error.message : 'Не удалось проверить PLDMGR';
  }
  let eligible =
    !managerConflict &&
    (!artifactConfigured() || !!artifact) &&
    state === 'stopped' &&
    (!previous || terminal(previous.state));
  try {
    assertTarget(profile);
    assertIdle(profile);
  } catch (error) {
    eligible = false;
    message = error instanceof Error ? error.message : 'Устройство занято';
  }
  return {
    consoleId: profile.id,
    state,
    message: eligible && !release ? artifactMessage : message,
    canStart: eligible && !!release && (pm.known || (!!artifact && !pm.available)),
    canInstall: eligible && !!artifact && !pm.known,
    managerAvailable: pm.available,
    savedPayloadKnown: pm.known,
    artifact: release,
    operation: previous ? publicOperation(previous) : undefined,
  };
}

/** An explicit, idempotent intent. Only this path may save/start the bundled ELF. */
export async function beginPs5ServiceStart(
  input: {
    consoleId?: unknown;
    requestId?: unknown;
    action?: unknown;
  },
  options: { confirmedServiceStopped?: boolean } = {},
): Promise<Ps5ServiceStartInfo> {
  const profile = target(input?.consoleId);
  if (
    typeof input.requestId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(input.requestId) ||
    !['start', 'install'].includes(String(input.action))
  )
    throw createError({ statusCode: 400, message: 'Проверьте параметры запуска службы' });
  const requestId = input.requestId,
    previous = savedFlow(profile.id);
  if (previous && previous.ip !== profile.ip)
    throw createError({
      statusCode: 409,
      message: 'Прежний запуск относится к другому адресу PS5',
    });
  const replay = savedFlow(profile.id, requestPath(profile.id, requestId));
  if (replay || previous?.id === requestId) {
    const record = replay || previous!;
    if (record.ip !== profile.ip || record.action !== input.action)
      throw createError({ statusCode: 409, message: 'Номер запроса относится к другой операции' });
    return ps5ServiceStartInfo(profile.id);
  }
  if (running.has(profile.ip) || (previous && !terminal(previous.state)))
    throw createError({
      statusCode: 409,
      message: 'Проверьте результат прежнего запуска. Повтор не отправлен',
    });
  assertTarget(profile);
  assertIdle(profile);
  let artifact: Awaited<ReturnType<typeof readPs5ServiceArtifact>> | undefined;
  try {
    artifact = await readPs5ServiceArtifact();
  } catch (error) {
    if (artifactConfigured())
      throw createError({
        statusCode: 409,
        message: error instanceof Error ? error.message : 'Комплект службы повреждён',
      });
    /* A verified saved copy can start without a local bundle. */
  }
  const release = artifact?.manifest || storedReceipt(profile)?.release;
  if (!release || (input.action === 'install' && !artifact))
    throw createError({
      statusCode: 409,
      message: 'На WEB отсутствует проверенный комплект службы PS5',
    });
  // Re-check after reading files. The lock is shared with updates and the Windows master.
  assertTarget(profile);
  assertIdle(profile);
  const changed = savedFlow(profile.id);
  if (changed && !terminal(changed.state))
    throw createError({ statusCode: 409, message: 'Другой клиент уже запускает службу PS5' });
  const unlock = claimConsoleWorker('bootstrap', profile.ip);
  if (!unlock)
    throw createError({ statusCode: 409, message: 'Другой клиент уже работает с этой PS5' });
  try {
    const latest = savedFlow(profile.id);
    const repeated = savedFlow(profile.id, requestPath(profile.id, requestId));
    if (repeated || latest?.id === requestId) {
      unlock();
      return ps5ServiceStartInfo(profile.id);
    }
    if (latest && (!terminal(latest.state) || latest.ip !== profile.ip))
      throw createError({ statusCode: 409, message: 'Проверьте результат прежнего запуска PS5' });
  } catch (error) {
    unlock();
    throw error;
  }
  const flow: Ps5ServiceLaunchRecord = {
    id: requestId,
    consoleId: profile.id,
    ip: profile.ip,
    version: release.version,
    buildId: release.buildId,
    sha256: release.sha256,
    firmware: release.firmware,
    action: input.action as 'start' | 'install',
    state: 'checking',
    dispatched: false,
    message: 'Проверяем PS5 перед запуском службы',
    startedAt: Date.now(),
  };
  try {
    persist(flow);
  } catch (error) {
    unlock();
    throw error;
  }
  running.add(profile.ip);
  const done = trackDesktopRequest();
  const readHealth = () =>
    options.confirmedServiceStopped === true
      ? bootstrapHealth(
          () => ps5ServiceRequest(profile.ip, '/health'),
          () => servicePortConnects(profile.ip),
          true,
        )
      : health(profile.ip);
  void runPs5ServiceLaunch(flow, {
    assertTarget: () => assertTarget(profile),
    assertIdle: () => assertIdle(profile),
    health: readHealth,
    manager: () => manager(profile, release),
    register: async () => {
      if (!artifact) throw new Error('Проверенный ELF отсутствует');
      const entry = await storePs5ServicePayload(profile.ip, artifact, undefined, async () => {
        if (await readHealth()) throw new Error('Служба уже отвечает. Сохранение не отправлено');
        assertTarget(profile);
        assertIdle(profile);
      });
      writeDurableJson(receiptPath(profile.id), {
        consoleId: profile.id,
        ip: profile.ip,
        release,
        entry,
      });
      return entry;
    },
    launch: (entry) =>
      launchPs5StoredPayload(profile.ip, entry.slot || entry.path, undefined, async (fresh) => {
        const receipt = storedReceipt(profile);
        if (
          !receipt ||
          fresh.path !== receipt.entry.path ||
          fresh.slot !== receipt.entry.slot ||
          fresh.version !== receipt.entry.version ||
          fresh.buildId !== receipt.entry.buildId
        )
          throw new Error('Сохранённая нагрузка изменилась. Запуск не отправлен');
        if (await readHealth())
          throw new Error('Служба уже отвечает. Повторный запуск не отправлен');
        assertTarget(profile);
        assertIdle(profile);
      }),
    connect: async () => {
      if (!artifact) throw new Error('Загрузчик требует проверенный ELF на WEB');
      return loader(profile.ip, artifact.bytes);
    },
    save: persist,
    pause: () => new Promise((resolve) => setTimeout(resolve, 1000)),
  })
    .finally(() => {
      running.delete(profile.ip);
      unlock();
      done();
    })
    .catch(() => {
      console.error(
        'PS5 service launch journal could not be saved; automatic replay remains blocked',
      );
    });
  return {
    consoleId: profile.id,
    state: 'unknown',
    message: flow.message,
    canStart: false,
    canInstall: false,
    managerAvailable: false,
    savedPayloadKnown: false,
    artifact: release,
    operation: publicOperation(flow),
  };
}

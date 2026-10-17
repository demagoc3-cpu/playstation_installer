import { createError } from 'h3';
import { randomBytes } from 'node:crypto';
import { assertNoConsoleSpeedTest } from './console-speed-lock';
import {
  getConsoleProfile,
  getConsoleProfiles,
  ps5OperationRequest,
  ps5ServiceRequest,
} from './console-profiles';
import { claimConsoleWorker } from './console-worker-lock';
import { logEvent } from './event-log';
import { getPs5Queue } from './ps5-installation-queue';
import {
  PS5_SERVICE_SLOT,
  deletePs5ServicePayload,
  launchPs5StoredPayload,
  ownPs5ServicePayload,
  readPs5PayloadManager,
  readPs5PayloadManagerConfig,
  readPs5PayloadManagerEvents,
  readPs5PayloadManagerHistory,
  replacePs5ServicePayload,
  setPs5ServiceAutoload,
} from './ps5-payload-manager';
import { readPs5ServiceArtifact } from './ps5-service-artifact';
import { installPs5ServiceRelease, latestPs5ServiceRelease } from './ps5-service-github';
import { assertNoPs5ServiceUpdate } from './ps5-service-updates';

/* Devices → «Сервис»: one place to check and manage PackageFlowService-PS5
 * through PLDMGR (port of the hardware-tested Python lifecycle prototype). */

export const PS5_SERVICE_ACTIONS = [
  'start',
  'stop',
  'restart',
  'install',
  'update',
  'autoload-on',
  'autoload-off',
  'remove',
  'diagnostics',
] as const;
export type Ps5ServiceAction = (typeof PS5_SERVICE_ACTIONS)[number];
export interface Ps5ServiceOperation {
  id: string;
  action: Ps5ServiceAction | 'auto-start';
  state: 'running' | 'completed' | 'failed';
  message: string;
  steps: string[];
  details?: string[];
  startedAt: number;
  finishedAt?: number;
}
const operations = new Map<string, Ps5ServiceOperation>();
const autoStartAt = new Map<string, number>();
const AUTO_START_BACKOFF_MS = 5 * 60 * 1000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function profile(id: unknown) {
  const p = getConsoleProfile(id);
  if (p.platform !== 'ps5') throw createError({ statusCode: 400, message: 'Выберите PS5' });
  return p;
}

type Health =
  | { state: 'running'; version: string; buildId: string; pid: number }
  | { state: 'stopped' | 'unreachable' | 'other' };
/** refused → stopped (console up, service down); timeout → unreachable. */
async function health(ip: string): Promise<Health> {
  try {
    const r = await ps5ServiceRequest(ip, '/health');
    const report = r.body?.serviceReport;
    if (r.status !== 200 || report?.service !== 'PackageFlowService-PS5') return { state: 'other' };
    return {
      state: 'running',
      version: String(report.version || ''),
      buildId: String(report.buildId || ''),
      pid: Number(r.body.pid) || 0,
    };
  } catch (error: any) {
    const code = error?.cause?.code || error?.cause?.cause?.code;
    return { state: code === 'ECONNREFUSED' ? 'stopped' : 'unreachable' };
  }
}
async function waitHealth(ip: string, until: (h: Health) => boolean, seconds: number) {
  for (let elapsed = 0; elapsed < seconds; elapsed += 2) {
    const h = await health(ip);
    if (until(h)) return h;
    await pause(2000);
  }
  return undefined;
}

function busy(consoleId: string) {
  try {
    assertNoConsoleSpeedTest(consoleId);
    assertNoPs5ServiceUpdate(consoleId);
  } catch (error: any) {
    return error?.message || 'Устройство занято';
  }
  const queue = getPs5Queue(consoleId);
  if (
    queue.items.some((item) =>
      ['sending', 'verifying', 'installing', 'unconfirmed'].includes(item.state),
    )
  )
    return 'На приставке идёт установка. Дождитесь её окончания';
  return operations.get(consoleId)?.state === 'running' ? 'Служба уже обрабатывает команду' : '';
}

/** One status for Devices and for automatic checks; quick when the console is off. */
export async function ps5ServiceStatus(id: unknown, options: { checkRelease?: boolean } = {}) {
  const p = profile(id);
  const service = await health(p.ip);
  let manager: {
    available: boolean;
    version?: string;
    saved?: { slot: string; path: string };
    autoload?: boolean;
    message?: string;
  } = { available: false };
  if (service.state !== 'unreachable')
    try {
      const pm = await readPs5PayloadManager(p.ip);
      const saved = ownPs5ServicePayload(pm.payloads);
      let autoload: boolean | undefined;
      try {
        const config = await readPs5PayloadManagerConfig(p.ip);
        autoload = config.enabled && config.list.includes(saved?.slot || PS5_SERVICE_SLOT);
      } catch {
        autoload = undefined;
      }
      manager = {
        available: true,
        version: pm.version,
        saved: saved ? { slot: saved.slot, path: saved.path } : undefined,
        autoload,
      };
    } catch (error: any) {
      manager = { available: false, message: error?.message };
    }
  let bundle: { version: string; buildId: string } | undefined;
  try {
    const artifact = (await readPs5ServiceArtifact()).manifest;
    bundle = { version: artifact.version, buildId: artifact.buildId };
  } catch {
    bundle = undefined;
  }
  let release:
      | { tag: string; version: string; buildId: string; url: string; publishedAt: string }
      | null
      | undefined,
    releaseError = '';
  if (options.checkRelease)
    try {
      const latest = await latestPs5ServiceRelease(true);
      release = latest && {
        tag: latest.tag,
        version: latest.manifest.version,
        buildId: latest.manifest.buildId,
        url: latest.url,
        publishedAt: latest.publishedAt,
      };
    } catch (error: any) {
      releaseError = error?.message || 'GitHub недоступен';
    }
  const running = service.state === 'running' ? service : undefined;
  return {
    consoleId: p.id,
    ip: p.ip,
    service,
    manager,
    bundle,
    release,
    releaseError,
    updateAvailable: !!(release && running && release.buildId !== running.buildId),
    bundleDiffers: !!(bundle && running && bundle.buildId !== running.buildId),
    busy: busy(p.id),
    operation: operations.get(p.id),
  };
}

async function launchSaved(ip: string, op: Ps5ServiceOperation, expectBuild?: string) {
  const pm = await readPs5PayloadManager(ip);
  const saved = ownPs5ServicePayload(pm.payloads);
  if (!saved) throw new Error('Служба не сохранена в PLDMGR. Выберите «Установить службу»');
  op.steps.push(`Запускаем ${saved.slot || saved.path}`);
  await launchPs5StoredPayload(ip, saved.slot || saved.path);
  const up = await waitHealth(ip, (h) => h.state === 'running', 40);
  if (!up || up.state !== 'running') throw new Error('Служба запущена, но не ответила за 40 с');
  if (expectBuild && up.buildId !== expectBuild)
    throw new Error(`Отвечает другая сборка (${up.buildId}), ожидалась ${expectBuild}`);
  op.steps.push(`Служба работает: ${up.version} · ${up.buildId} · pid ${up.pid}`);
}
async function stopRunning(consoleId: string, ip: string, op: Ps5ServiceOperation) {
  const before = await health(ip);
  if (before.state !== 'running') return false;
  op.steps.push(`Останавливаем pid ${before.pid}`);
  const r = await ps5OperationRequest(consoleId, '/api/v1/shutdown');
  if (r.status === 409) throw new Error('Служба занята операцией и не остановлена');
  if (r.status !== 200 || r.body?.ok !== true)
    throw new Error(`Служба не подтвердила остановку (${r.status})`);
  const down = await waitHealth(ip, (h) => h.state !== 'running', 25);
  if (!down) throw new Error('Остановка подтверждена, но служба ещё отвечает');
  op.steps.push('Служба остановлена');
  return true;
}
async function installArtifact(
  consoleId: string,
  ip: string,
  op: Ps5ServiceOperation,
  artifact: Awaited<ReturnType<typeof readPs5ServiceArtifact>>,
) {
  op.steps.push(`Сборка ${artifact.manifest.version} · ${artifact.manifest.buildId}`);
  await stopRunning(consoleId, ip, op);
  const saved = await replacePs5ServicePayload(ip, artifact);
  op.steps.push(`Сохранено в PLDMGR: ${saved.slot || saved.path}`);
  await launchSaved(ip, op, artifact.manifest.buildId);
}

async function perform(consoleId: string, ip: string, op: Ps5ServiceOperation) {
  switch (op.action) {
    case 'auto-start':
    case 'start':
      return launchSaved(ip, op);
    case 'stop':
      if (!(await stopRunning(consoleId, ip, op))) op.steps.push('Служба уже остановлена');
      return;
    case 'restart':
      await stopRunning(consoleId, ip, op);
      return launchSaved(ip, op);
    case 'install':
      return installArtifact(consoleId, ip, op, await readPs5ServiceArtifact());
    case 'update': {
      const latest = await latestPs5ServiceRelease(true);
      if (!latest) throw new Error('В релизах GitHub нет службы PS5');
      op.steps.push(`Релиз ${latest.tag}: загружаем и проверяем SHA-256`);
      return installArtifact(consoleId, ip, op, await installPs5ServiceRelease(latest));
    }
    case 'autoload-on':
    case 'autoload-off': {
      const saved = ownPs5ServicePayload((await readPs5PayloadManager(ip)).payloads);
      if (op.action === 'autoload-on' && !saved)
        throw new Error('Сначала сохраните службу в PLDMGR');
      const list = await setPs5ServiceAutoload(
        ip,
        op.action === 'autoload-on',
        saved?.slot || PS5_SERVICE_SLOT,
      );
      op.steps.push(`Автозапуск: ${list.join(', ') || 'пусто'}`);
      return;
    }
    case 'remove':
      await stopRunning(consoleId, ip, op);
      await setPs5ServiceAutoload(ip, false);
      op.steps.push('Убрано из автозапуска');
      op.steps.push(
        (await deletePs5ServicePayload(ip)) ? 'Запись PLDMGR удалена' : 'Записи PLDMGR не было',
      );
      return;
    case 'diagnostics': {
      const [history, events] = await Promise.all([
        readPs5PayloadManagerHistory(ip),
        readPs5PayloadManagerEvents(ip),
      ]);
      op.details = [
        ...history.slice(0, 10).map((line) => `История: ${line}`),
        ...events
          .filter(
            (line) =>
              /^\[Autoload\]|Loader transfer|packageflow/i.test(line) ||
              (/error|fail|abort/i.test(line) && !/Error: 0\b/.test(line)),
          )
          .slice(-40),
      ];
      op.steps.push(`Прочитано: ${history.length} записей истории, ${events.length} событий`);
      return;
    }
  }
}

function run(consoleId: string, ip: string, action: Ps5ServiceOperation['action']) {
  const unlock = claimConsoleWorker('bootstrap', ip);
  if (!unlock)
    throw createError({ statusCode: 409, message: 'Другая операция уже управляет этой PS5' });
  const op: Ps5ServiceOperation = {
    id: randomBytes(16).toString('hex'),
    action,
    state: 'running',
    message: 'Выполняется',
    steps: [],
    startedAt: Date.now(),
  };
  operations.set(consoleId, op);
  void perform(consoleId, ip, op)
    .then(() => {
      op.state = 'completed';
      op.message = 'Готово';
      if (action === 'auto-start') logEvent('info', `PS5 ${ip}: служба запущена автоматически`);
    })
    .catch((error) => {
      op.state = 'failed';
      op.message = error instanceof Error ? error.message : 'Операция не выполнена';
      op.steps.push(op.message);
      logEvent('warn', `PS5 ${ip}: «${action}» не выполнено — ${op.message}`);
    })
    .finally(() => {
      op.finishedAt = Date.now();
      unlock();
    });
  return op;
}

export async function startPs5ServiceAction(id: unknown, action: unknown) {
  const p = profile(id);
  if (!PS5_SERVICE_ACTIONS.includes(action as Ps5ServiceAction))
    throw createError({ statusCode: 400, message: 'Неизвестное действие службы' });
  const reason = action === 'diagnostics' ? '' : busy(p.id);
  if (reason) throw createError({ statusCode: 409, message: reason });
  run(p.id, p.ip, action as Ps5ServiceAction);
  return ps5ServiceStatus(p.id);
}

/** When a paired PS5 answers but its service does not, start the saved record
 * once per 5 minutes. Never during an installation or another operation. */
export async function autoStartPs5Service(id: string) {
  const p = getConsoleProfile(id);
  const paired = getConsoleProfiles().consoles.find((item) => item.id === p.id)?.paired;
  if (p.platform !== 'ps5' || !paired) return;
  if (Date.now() - (autoStartAt.get(p.id) || 0) < AUTO_START_BACKOFF_MS) return;
  if (busy(p.id)) return;
  autoStartAt.set(p.id, Date.now());
  if ((await health(p.ip)).state !== 'stopped') return;
  try {
    const saved = ownPs5ServicePayload((await readPs5PayloadManager(p.ip)).payloads);
    if (!saved) return;
  } catch {
    return;
  }
  try {
    run(p.id, p.ip, 'auto-start');
  } catch {
    /* Another operation owns the console. */
  }
}

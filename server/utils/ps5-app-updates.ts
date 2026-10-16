import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createError } from 'h3';
import { getConsoleProfile } from './console-profiles';
import { consoleSetupBundle, type SetupBundle } from './console-setup-artifacts';
import {
  findDesktopPs5AppRequest,
  installDesktopPs5App,
  readDesktopPs5AppSetup,
} from './desktop-console-setup';
import { getPs5Queue } from './ps5-installation-queue';
import { ps5ConsoleGameInfo } from './ps5-console-games';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { ps5ServiceUpdateInfo } from './ps5-service-updates';

interface WebAppRequest {
  schemaVersion: 1;
  consoleId: string;
  ip: string;
  requestId: string;
  sha256: string;
  startedAt: number;
}
const dispatching = new Set<string>();
const requestPath = (id: string) => dataPath('console-setup', `app-web-${id}.json`);
const terminalRetries = ['installed', 'absent', 'different-version', 'different-build'];
const retryable = ['absent', 'different-version', 'different-build'];
function profile(id: unknown) {
  const p = getConsoleProfile(id);
  if (p.platform !== 'ps5')
    throw createError({ statusCode: 400, message: 'Для обновления приложения выберите PS5' });
  return p;
}
function saved(p: ReturnType<typeof profile>): WebAppRequest | null {
  if (!existsSync(requestPath(p.id))) return null;
  try {
    const value = JSON.parse(readFileSync(requestPath(p.id), 'utf8'));
    if (
      value.schemaVersion !== 1 ||
      value.consoleId !== p.id ||
      value.ip !== p.ip ||
      !/^[a-f0-9]{32}$/.test(value.requestId) ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.startedAt) ||
      value.startedAt <= 0
    )
      throw Error();
    return value;
  } catch {
    throw createError({
      statusCode: 503,
      message: 'Не удалось прочитать результат обновления приложения. Повтор не отправлен',
    });
  }
}
function publicRelease(app: SetupBundle['app']) {
  return {
    titleId: app.titleId,
    version: app.version,
    buildId: 'buildId' in app && typeof app.buildId === 'string' ? app.buildId : '',
    sha256: app.sha256,
    format: app.format,
    size: app.size,
  };
}
function compare(a: string, b: string) {
  const aa = a.split('.').map(Number),
    bb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++)
    if ((aa[i] || 0) !== (bb[i] || 0)) return Math.sign((aa[i] || 0) - (bb[i] || 0));
  return 0;
}
async function readWebRequest(
  consoleId: string,
  request: Pick<WebAppRequest, 'requestId' | 'sha256'>,
) {
  const result = await readDesktopPs5AppSetup(consoleId, request.requestId, true);
  if (result) return result;
  // A preflight can leave only this WEB marker. Windows may then complete the
  // same bundle under another ID. Reconcile that old SHA before rotating IDs
  // for a newer bundle; GET never adopts or rewrites either receipt.
  const shared = findDesktopPs5AppRequest(consoleId, request.sha256);
  return shared && shared !== request.requestId
    ? readDesktopPs5AppSetup(consoleId, shared, true)
    : null;
}

/** Regular WEB and Windows use the same bundled app installer and its durable receipt. */
export async function ps5AppUpdateInfo(id: unknown) {
  const p = profile(id);
  let request: Pick<WebAppRequest, 'requestId' | 'sha256'> | null = saved(p);
  let release: ReturnType<typeof publicRelease> | null = null,
    artifactMessage = '';
  try {
    release = publicRelease((await consoleSetupBundle({ verifyFiles: false })).manifest.app);
  } catch (error: any) {
    artifactMessage =
      error?.code === 'ENOENT'
        ? 'В этой сборке WEB нет комплекта приложения PS5'
        : error?.message || 'Не удалось проверить комплект приложения PS5';
  }
  if (!request && release) {
    const existing = findDesktopPs5AppRequest(p.id, release.sha256);
    if (existing) request = { requestId: existing, sha256: release.sha256 };
  }
  let serviceReady = false;
  try {
    const service = await ps5ServiceUpdateInfo(p.id);
    serviceReady =
      service.currentConfirmed === true &&
      /^\d+\.\d+\.\d+(?:-dev)?$/.test(service.current) &&
      compare(service.current.replace(/-dev$/, ''), '0.1.28') >= 0;
  } catch {
    /* A cached or unreachable ELF cannot authorize replacing the app source. */
  }
  const queue = getPs5Queue(p.id);
  let result: Awaited<ReturnType<typeof readDesktopPs5AppSetup>> = null,
    resultUnknown = false;
  if (request) {
    try {
      result = await readWebRequest(p.id, request);
    } catch {
      resultUnknown = true;
    }
  }
  let current = '',
    installed: boolean | null = null;
  try {
    const app = await ps5ConsoleGameInfo(p.id, 'PPSA95001');
    if (app.contentId === 'IV0000-PPSA95001_00-PACKAGEFLOWUI001') {
      current = app.version || '';
      installed = app.installed === true && app.sourceAvailable === true;
    }
  } catch {
    /* An unreachable console never proves absence. The installer checks it again before dispatch. */
  }
  const sameBundle = !!request && !!release && request.sha256 === release.sha256;
  const verified =
    !!release && result?.retry === 'installed' && result.receipt.sha256 === release.sha256;
  const attempt =
    result?.receipt &&
    queue.items.find(
      (item) =>
        item.packageId === result!.receipt.packageId &&
        (item.queueId || queue.id) === result!.receipt.queueId,
    );
  const retry = result?.retry || (resultUnknown ? 'unavailable' : null);
  const oldUnresolved = !!request && !sameBundle && (!retry || !terminalRetries.includes(retry));
  const queueBusy = queue.items.some(
    (item) => !['installed', 'failed', 'skipped', 'cancelled'].includes(item.state),
  );
  const blocked =
    !serviceReady ||
    dispatching.has(p.id) ||
    oldUnresolved ||
    ['active', 'unconfirmed', 'unavailable'].includes(retry || '') ||
    queueBusy;
  const newerInstalled =
    !!release && /^\d{2}\.\d{3}\.\d{3}$/.test(current) && compare(current, release.version) > 0;
  const updateAvailable = !!release && !verified && !newerInstalled;
  const state =
    resultUnknown || retry === 'unavailable'
      ? 'unavailable'
      : retry === 'unconfirmed'
        ? 'unconfirmed'
        : verified
          ? 'completed'
          : retry === 'active' || dispatching.has(p.id)
            ? 'active'
            : retry && retryable.includes(retry)
              ? 'failed'
              : 'prepared';
  const progress =
    attempt && attempt.size > 0
      ? Math.min(100, Math.floor((attempt.bytesSent / attempt.size) * 100))
      : verified
        ? 100
        : undefined;
  let message = !release
    ? artifactMessage
    : verified
      ? 'Установлена сборка приложения из этого комплекта'
      : newerInstalled
        ? 'На PS5 установлена более новая версия приложения'
        : installed
          ? 'Доступно обновление приложения. Сборку с тем же номером версии тоже можно обновить'
          : 'Установить или восстановить приложение из комплекта PackageFlow';
  if (oldUnresolved)
    message = 'Результат предыдущего обновления ещё неизвестен. Сначала проверьте его завершение';
  else if (retry === 'unconfirmed')
    message = 'PS5 пока не подтвердила установку приложения. Повторная передача не отправлена';
  else if (retry === 'unavailable')
    message =
      'Не удалось проверить установленное приложение. Восстановите связь и проверьте результат';
  else if (retry === 'active')
    message = attempt?.detail || 'Приложение передаётся и регистрируется на PS5';
  else if (updateAvailable && !serviceReady)
    message = 'Сначала обновите ELF службы PS5 до 0.1.28 или новее';
  else if (queueBusy) message = 'Дождитесь завершения текущих заданий PS5';
  return {
    consoleId: p.id,
    current,
    currentBuildId: verified ? release!.buildId : '',
    installed,
    release,
    updateAvailable,
    canUpdate: updateAvailable && !blocked,
    serviceReady,
    message,
    flow: request
      ? {
          requestId: request.requestId,
          state,
          message,
          ...(progress === undefined ? {} : { progress }),
        }
      : null,
  };
}

/** The browser supplies only a profile ID. File, title and request identity stay on WEB. */
export async function beginPs5AppUpdate(id: unknown) {
  const p = profile(id);
  if (dispatching.has(p.id)) return ps5AppUpdateInfo(p.id);
  dispatching.add(p.id);
  try {
    const bundle = await consoleSetupBundle(),
      previous = saved(p);
    let request = previous;
    if (!previous) {
      const existing = findDesktopPs5AppRequest(p.id, bundle.manifest.app.sha256);
      if (existing) {
        const result = await readDesktopPs5AppSetup(p.id, existing, true);
        if (!result)
          throw createError({
            statusCode: 409,
            message:
              'Не удалось проверить предыдущую установку приложения. Новый запрос не отправлен',
          });
        if (!retryable.includes(result.retry || '')) return ps5AppUpdateInfo(p.id);
      }
    }
    if (previous) {
      const result = await readWebRequest(p.id, previous);
      if (result && !terminalRetries.includes(result.retry || '')) return ps5AppUpdateInfo(p.id);
      if (previous.sha256 !== bundle.manifest.app.sha256 && !result)
        throw createError({
          statusCode: 409,
          message:
            'Сначала завершите проверку предыдущего комплекта приложения. Новый запрос не отправлен',
        });
      if (result?.retry === 'installed' && result.receipt.sha256 === bundle.manifest.app.sha256)
        return ps5AppUpdateInfo(p.id);
      if (
        result &&
        (retryable.includes(result.retry || '') || previous.sha256 !== bundle.manifest.app.sha256)
      )
        request = null;
    }
    if (!request) {
      request = {
        schemaVersion: 1,
        consoleId: p.id,
        ip: p.ip,
        requestId: randomBytes(16).toString('hex'),
        sha256: bundle.manifest.app.sha256,
        startedAt: Date.now(),
      };
      writeDurableJson(requestPath(p.id), request);
    }
    // Preserve the same request after a lost reply. The shared installer reconciles
    // its queue receipt or bound source-upgrade journal before any new command.
    await installDesktopPs5App(p.id, request.requestId, true);
  } finally {
    dispatching.delete(p.id);
  }
  return ps5AppUpdateInfo(p.id);
}

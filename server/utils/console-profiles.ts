import { randomUUID } from 'node:crypto';
import { logEvent } from './event-log';
import { ps5QueueContext } from './ps5-transfer-context';
import { existsSync } from 'node:fs';
import { createError } from 'h3';
import { assertNoConsoleSpeedTest } from './console-speed-lock';
import { dataPath } from './data-path';
import { captureLegacyConsole } from './console-scope';
import { readJsonFile, writeJsonFile } from './json-store';
import { writeDurableJson } from './durable-json';
import { getSavedPsIp, getGoldHenStatus } from './ps4-installer';
import { ps4ServiceIp, readPs4Service, getPs4SystemSnapshot } from './ps4-service';
import {
  getServiceInstallerStatus,
  serviceKeyConfigured,
  saveServiceKey,
  updatePairedServiceWebAddress,
} from './ps4-service-installer';
import { ps5WebAddressHeaders, ps5WebAddressAccepted } from './ps5-web-address';
import { ps5InstallCapabilities } from '../../shared/ps5-install-readiness';
import { readPs5QualifiedRoutes, withPs5QualifiedRoutes } from './ps5-qualified-routes';
import type {
  ConsoleProfile,
  ConsoleProfiles,
  ConsoleCapabilities,
  ConsolePlatform,
} from '../../shared/types/consoles';
import { ps5BuildQualified } from './ps5-qualified-builds';
import { reconcileStalePs5StartJournals } from './ps5-bootstrap-journal';
import { ps5PowerState } from './ps5-power';

const profilePath = () => dataPath('console-profiles.json');
const keyPath = () => dataPath('ps5-service-keys.json');
const emptyCapabilities = (): ConsoleCapabilities => ({
  formats: [],
  installPs4: false,
  installPs5: false,
  background: false,
});
type StoredProfile = Omit<
  ConsoleProfile,
  | 'online'
  | 'paired'
  | 'pairingConfigured'
  | 'capabilities'
  | 'freeBytes'
  | 'checkedAt'
  | 'transferFreeBytes'
  | 'totalBytes'
  | 'henName'
  | 'henVersion'
  | 'henSdk'
  | 'servicePid'
  | 'serviceBuild'
  | 'capabilitiesDeferred'
  | 'restMode'
>;
interface Store {
  version: 1;
  activeId: string | null;
  consoles: StoredProfile[];
}
interface EmbeddedRuntime {
  ip: string;
  pid: number;
  startedAt: number;
  buildId: string;
  version: string;
  firmware: string;
}
const snapshots = new Map<
  string,
  Pick<
    ConsoleProfile,
    | 'online'
    | 'paired'
    | 'capabilities'
    | 'freeBytes'
    | 'checkedAt'
    | 'transferFreeBytes'
    | 'totalBytes'
    | 'henName'
    | 'henVersion'
    | 'henSdk'
    | 'servicePid'
    | 'serviceBuild'
    | 'capabilitiesDeferred'
    | 'restMode'
  > & { runtimeIdentity?: EmbeddedRuntime; fullCheckedAt?: number }
>();

function store(): Store {
  captureLegacyConsole();
  const saved = readJsonFile<Store | null>(profilePath(), null);
  if (
    saved?.version === 1 &&
    Array.isArray(saved.consoles) &&
    saved.consoles.every(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        ps4ServiceIp(item.ip) &&
        ['ps4', 'ps5'].includes(item.platform),
    ) &&
    new Set(saved.consoles.map((item) => item.id)).size === saved.consoles.length &&
    new Set(saved.consoles.map((item) => item.ip)).size === saved.consoles.length &&
    (saved.activeId === null || saved.consoles.some((item) => item.id === saved.activeId))
  )
    return saved;
  if (existsSync(profilePath()))
    throw createError({
      statusCode: 500,
      message: 'Не удалось прочитать профили приставок. Сохранённый файл не изменён.',
    });
  const ip = ps4ServiceIp(getSavedPsIp());
  const consoles: StoredProfile[] = ip
    ? [{ id: randomUUID(), name: 'PS4', ip, platform: 'ps4', verified: false }]
    : [];
  const initial: Store = { version: 1, activeId: consoles[0]?.id || null, consoles };
  writeJsonFile(profilePath(), initial);
  return initial;
}

export function getConsoleProfile(id: unknown): StoredProfile {
  const value = store().consoles.find((item) => item.id === id);
  if (!value) throw createError({ statusCode: 404, message: 'Приставка не найдена' });
  return value;
}
export function consoleProfileForIp(ip: string) {
  return store().consoles.find((item) => item.ip === ip);
}
export function activeConsoleProfile() {
  const saved = store();
  return saved.consoles.find((item) => item.id === saved.activeId);
}
function ps5Token(ip: string) {
  const value = readJsonFile<Record<string, string>>(keyPath(), {})[ip];
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
const operationMethods = {
  '/api/v1/transfers/begin': 'POST',
  '/api/v1/transfers/status': 'GET',
  '/api/v1/transfers/chunk': 'POST',
  '/api/v1/transfers/batch': 'POST',
  '/api/v1/benchmark/info': 'GET',
  '/api/v1/transfers/commit': 'POST',
  '/api/v1/transfers/cancel': 'POST',
  '/api/v1/operations/status': 'GET',
  '/api/v1/install/staged': 'POST',
  '/api/v1/install/status': 'GET',
  '/api/v1/installer/job': 'GET',
  '/api/v1/install/verify': 'GET',
  '/api/v1/install/readiness': 'GET',
  '/api/v1/installer/status': 'GET',
  '/api/v1/app/status': 'GET',
  '/api/v1/app/launch': 'POST',
  '/api/v1/app/stop': 'POST',
  '/api/v1/app/stop/status': 'GET',
  '/api/v1/folder/commit': 'POST',
  '/api/v1/folder/status': 'GET',
  '/api/v1/images/commit': 'POST',
  '/api/v1/images/status': 'GET',
  '/api/v1/web/config': 'POST',
  '/api/v1/management/status': 'GET',
  '/api/v1/console/catalog': 'GET',
  '/api/v1/saves/list': 'GET',
  '/api/v1/saves/manifest': 'GET',
  '/api/v1/saves/restore': 'POST',
  '/api/v1/saves/restore/status': 'GET',
  '/api/v1/saves/rollback': 'POST',
  '/api/v1/saves/finalize': 'POST',
  '/api/v1/console/games': 'GET',
  '/api/v1/console/info': 'GET',
  '/api/v1/console/command': 'POST',
  '/api/v1/console/command/status': 'GET',
  '/api/v1/console/storage': 'GET',
  '/api/v1/console/activity': 'GET',
  '/api/v1/status': 'GET',
  '/api/v1/shutdown': 'POST',
  '/api/v1/update/prepare': 'POST',
  '/api/v1/update/status': 'GET',
} as const;
/** Diagnostics: record every request that reaches a PS5 while it receives
 * package data from someone other than its own installation queue. */
function notePs5RequestDuringTransfer(consoleId: string, path: string) {
  if (ps5QueueContext.getStore() === consoleId || !ps5TransferInProgress(consoleId)) return;
  logEvent('warn', `PS5: запрос ${path} во время передачи пакета`);
}
export class Ps5OperationValidationError extends Error {}
/** Hands a package body to the socket in 1 MiB slices and reports how much has
 * left WEB, so a long batch shows live progress. Same bytes, same Content-Length. */
function uploadStream(body: Uint8Array, onUpload: (bytes: number) => void) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= body.length) {
        controller.close();
        return;
      }
      const part = body.subarray(offset, Math.min(offset + 1048576, body.length));
      controller.enqueue(part);
      onUpload(offset);
      offset += part.length;
    },
  });
}
/** Fixed endpoints only. Callers cannot supply an address, credential or arbitrary path. */
export async function ps5OperationRequest(
  consoleId: string,
  path: keyof typeof operationMethods,
  headers: Record<string, string> = {},
  body?: Uint8Array,
  signal?: AbortSignal,
  onUpload?: (bytes: number) => void,
) {
  const profile = getConsoleProfile(consoleId),
    token = ps5Token(profile.ip);
  if (profile.platform !== 'ps5' || !ps4ServiceIp(profile.ip) || !token)
    throw createError({ statusCode: 409, message: 'Требуется сопряжение PS5' });
  if (
    !Object.hasOwn(operationMethods, path) ||
    Object.keys(headers).some(
      (key) =>
        !/^X-PackageFlow-(Transfer-Id|Size|Blake3|Stream|Offset|Installer-Job|Web-Host|Web-Port|Console-Id|Update-Id|Request-Id|UI-Title|UI-Metadata-Hash|Title|Content|Version|User|Save-Kind|Save-Path|File-Id|Action|Destination|Source-Identity|Confirm-Title|Expected-App-Id|Image-Protocol)$/.test(
          key,
        ),
    )
  )
    throw new Ps5OperationValidationError('Invalid PS5 operation');
  notePs5RequestDuringTransfer(profile.id, path);
  if (operationMethods[path] === 'POST') assertNoConsoleSpeedTest(consoleId);
  const timeout = path === '/api/v1/transfers/batch' ? 90000 : 15000;
  const upload = body && onUpload ? uploadStream(body, onUpload) : undefined;
  const response = await fetch(`http://${profile.ip}:8095${path}`, {
    method: operationMethods[path],
    headers: {
      ...headers,
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
      // A streamed body keeps the exact length; the service never accepts chunked bodies.
      ...(upload ? { 'Content-Length': String(body!.length) } : {}),
      // Do not race the ELF's short idle lifetime while WEB saves progress.
      ...(path === '/api/v1/transfers/batch' ? { Connection: 'close' } : {}),
    },
    body: (upload ?? body) as BodyInit | undefined,
    ...(upload ? { duplex: 'half' } : {}),
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
  }).catch((error) => {
    if (!signal?.aborted) {
      const code = error?.cause?.code || error?.name;
      logEvent(
        'warn',
        `PS5: запрос ${path} прерван (${typeof code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'transport'}). Состояние сверяется с приставкой.`,
      );
    }
    throw error;
  });
  if (!response.body) throw new Error('Empty service response');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) throw new Error('Response too large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}
/** Bounded binary reads only inside the service's validated savedata roots. */
export async function ps5SaveChunk(consoleId: string, headers: Record<string, string>) {
  const profile = getConsoleProfile(consoleId),
    token = ps5Token(profile.ip);
  if (profile.platform !== 'ps5' || !token)
    throw createError({ statusCode: 409, message: 'Требуется сопряжение PS5' });
  if (
    Object.keys(headers).some(
      (key) => !/^X-PackageFlow-(User|Title|Save-Kind|Save-Path|File-Id|Offset|Size)$/.test(key),
    )
  )
    throw Error('Invalid save headers');
  const size = Number(headers['X-PackageFlow-Size']);
  if (!Number.isSafeInteger(size) || size < 0 || size > 1048576) throw Error('Invalid chunk size');
  notePs5RequestDuringTransfer(profile.id, '/api/v1/saves/read');
  const response = await fetch(`http://${profile.ip}:8095/api/v1/saves/read`, {
    headers: { ...headers, Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (
    response.status !== 200 ||
    response.headers.get('content-type') !== 'application/octet-stream' ||
    response.headers.get('content-length') !== String(size)
  ) {
    await response.body?.cancel();
    throw createError({
      statusCode: 409,
      message: 'PS5 не подтвердила чтение сохранения. Закройте игру и повторите создание копии.',
    });
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Empty save response');
  const chunks: Uint8Array[] = [];
  let used = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      used += part.value.length;
      if (used > size) throw Error('Save chunk overflow');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (used !== size)
    throw createError({
      statusCode: 409,
      message: 'Чтение сохранения прервано; неполная копия не опубликована',
    });
  return Buffer.concat(chunks);
}
function publicProfile(item: StoredProfile): ConsoleProfile {
  const cached = snapshots.get(item.id);
  const {
    runtimeIdentity: _runtimeIdentity,
    fullCheckedAt: _fullCheckedAt,
    ...snapshot
  } = cached || {};
  return {
    ...item,
    paired: false,
    capabilities: emptyCapabilities(),
    ...snapshot,
    pairingConfigured:
      item.platform === 'ps5' ? !!ps5Token(item.ip) : serviceKeyConfigured(item.ip),
    online: !!cached?.online && Date.now() - (cached.checkedAt || 0) < 60000,
  };
}
export function getConsoleProfiles(): ConsoleProfiles {
  const saved = store();
  return { activeId: saved.activeId, consoles: saved.consoles.map(publicProfile) };
}
export function consolePairConfigured(id: string) {
  const p = getConsoleProfile(id);
  return p.platform === 'ps5' ? !!ps5Token(p.ip) : serviceKeyConfigured(p.ip);
}

export function saveConsoleProfile(input: {
  id?: unknown;
  name?: unknown;
  ip?: unknown;
  platform?: unknown;
  model?: unknown;
  transport?: unknown;
}) {
  if (!input || typeof input !== 'object')
    throw createError({ statusCode: 400, message: 'Укажите параметры приставки' });
  const ip = ps4ServiceIp(input.ip);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (
    (input.model !== undefined &&
      (typeof input.model !== 'string' ||
        input.model.length > 64 ||
        /[\x00-\x1f]/.test(input.model))) ||
    (input.transport !== undefined && !['service', 'payload'].includes(String(input.transport)))
  )
    throw createError({ statusCode: 400, message: 'Проверьте модель и способ установки' });
  if (
    !ip ||
    !name ||
    name.length > 64 ||
    /[\x00-\x1f]/.test(name) ||
    !['ps4', 'ps5'].includes(String(input.platform))
  )
    throw createError({
      statusCode: 400,
      message: 'Укажите имя, IPv4-адрес и платформу приставки',
    });
  const saved = store(),
    previous =
      input.id === undefined ? undefined : saved.consoles.find((item) => item.id === input.id);
  if (input.id !== undefined && !previous)
    throw createError({ statusCode: 404, message: 'Приставка не найдена' });
  if (saved.consoles.some((item) => item.ip === ip && item.id !== previous?.id))
    throw createError({ statusCode: 409, message: 'Этот адрес уже добавлен' });
  if (previous && (previous.ip !== ip || previous.platform !== input.platform))
    throw createError({
      statusCode: 409,
      message: 'Для другой приставки создайте отдельный профиль',
    });
  const profile: StoredProfile = {
    ...previous,
    id: previous?.id || randomUUID(),
    name,
    ip,
    platform: input.platform as ConsolePlatform,
    verified: previous?.verified || false,
  };
  profile.model = input.model === undefined ? previous?.model : String(input.model).trim();
  profile.transport =
    profile.platform === 'ps5'
      ? 'service'
      : (input.transport as 'service' | 'payload') || previous?.transport || 'service';
  saved.consoles = [...saved.consoles.filter((item) => item.id !== profile.id), profile];
  saved.activeId ||= profile.id;
  snapshots.delete(profile.id);
  writeJsonFile(profilePath(), saved);
  return getConsoleProfiles();
}
export function selectConsoleProfile(id: unknown) {
  const profile = getConsoleProfile(id);
  const saved = store();
  saved.activeId = profile.id;
  writeJsonFile(profilePath(), saved);
  return getConsoleProfiles();
}
export function removeConsoleProfile(id: unknown) {
  const profile = getConsoleProfile(id),
    saved = store();
  // Remove only this client's stored credentials. Never revoke another WEB's access implicitly.
  for (const file of ['ps5-service-keys.json', 'ps4-service-keys.json']) {
    const path = dataPath(file);
    if (!existsSync(path)) continue;
    const keys = readJsonFile<Record<string, string> | null>(path, null);
    if (!keys || typeof keys !== 'object' || Array.isArray(keys))
      throw createError({
        statusCode: 503,
        message: 'Не удалось прочитать ключи сопряжения. Устройство не удалено',
      });
    delete keys[profile.ip];
    writeDurableJson(path, keys);
  }
  if (getSavedPsIp() === profile.ip) writeDurableJson(dataPath('ps4.json'), { ip: '' });
  saved.consoles = saved.consoles.filter((item) => item.id !== profile.id);
  if (saved.activeId === profile.id) saved.activeId = saved.consoles[0]?.id || null;
  snapshots.delete(profile.id);
  writeDurableJson(profilePath(), saved);
  return getConsoleProfiles();
}

/** Only the fixed PackageFlow port/path can be contacted. Credentials stay on WEB. */
export async function ps5ServiceRequest(
  ip: string,
  path:
    | '/health'
    | '/api/v1/capabilities'
    | '/api/v1/system'
    | '/api/v1/pair'
    | '/api/v1/install/readiness',
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!ps4ServiceIp(ip))
    throw createError({ statusCode: 400, message: 'Неверный адрес приставки' });
  for (const c of getConsoleProfiles().consoles)
    if (c.ip === ip && c.platform === 'ps5') notePs5RequestDuringTransfer(c.id, path);
  const headers: Record<string, string> = {};
  if (path === '/api/v1/pair') headers['X-PackageFlow-Pairing-Mode'] = 'automatic';
  else if (path !== '/health') {
    const token = ps5Token(ip);
    if (!token)
      throw createError({ statusCode: 409, message: 'Подключите PS5 в разделе «Устройства»' });
    headers.Authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    // Readiness includes synchronous installer/ShadowMount checks. Give an
    // explicit preflight the operation deadline; keep basic status probes quick.
    response = await fetch(`http://${ip}:8095${path}`, {
      method: path === '/api/v1/pair' ? 'POST' : 'GET',
      headers,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(path === '/api/v1/install/readiness' ? 15000 : 3500),
          ])
        : AbortSignal.timeout(path === '/api/v1/install/readiness' ? 15000 : 3500),
    });
  } catch (error: any) {
    // Preserve the transport cause: update/bootstrap must distinguish a refused
    // listener from a timeout before deciding whether another ELF may be sent.
    throw createError({
      statusCode: 503,
      message: `Нагрузка PackageFlow на PS5 ${ip}:8095 не отвечает. Проверьте сеть и состояние нагрузки. Сохранённый ключ подключения не удалён.`,
      cause: error?.cause || error,
    });
  }
  if (!response.body) throw new Error('Empty service response');
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 16384) throw new Error('Response too large');
      chunks.push(part.value);
    }
  } catch {
    throw createError({
      statusCode: 503,
      message:
        'Ответ нагрузки PS5 прервался. Проверьте связь и подключитесь снова. Сохранённый ключ подключения не удалён.',
    });
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    throw createError({
      statusCode: 502,
      message:
        'Нагрузка PS5 вернула некорректный ответ. Проверьте состояние PackageFlow на приставке.',
    });
  }
}

function validPs5Health(response: { status: number; body: any }) {
  const report = response.body?.serviceReport;
  return (
    response.status === 200 &&
    response.body?.apiVersion === 'v1' &&
    report?.service === 'PackageFlowService-PS5' &&
    (!report.platform || report.platform === 'ps5') &&
    report.consoleVerified === true
  );
}
const claimsKnownEmbeddedBuild = (response: { status: number; body: any }) =>
  ps5BuildQualified(response.body?.serviceReport?.buildId);

function embeddedRuntime(
  response: { status: number; body: any },
  ip: string,
): EmbeddedRuntime | undefined {
  const body = response.body,
    report = body?.serviceReport;
  if (
    !validPs5Health(response) ||
    report.platform !== 'ps5' ||
    report.consoleVerified !== true ||
    report.version !== '0.1.29-dev' ||
    !ps5BuildQualified(report.buildId) ||
    body.backend !== 'embedded' ||
    body.pkgBackendVersion !== '1.4.0-embedded-029' ||
    body.firmwareRead !== true ||
    String(body.firmwareRaw).toLowerCase() !== '0x13600007' ||
    !Number.isSafeInteger(body.pid) ||
    body.pid <= 0 ||
    !Number.isSafeInteger(body.startedAt) ||
    body.startedAt <= 0
  )
    return;
  return {
    ip,
    pid: body.pid,
    startedAt: body.startedAt,
    buildId: report.buildId,
    version: report.version,
    firmware: '13.60',
  };
}
const sameEmbeddedRuntime = (a?: EmbeddedRuntime, b?: EmbeddedRuntime) =>
  !!a &&
  !!b &&
  a.ip === b.ip &&
  a.pid === b.pid &&
  a.startedAt === b.startedAt &&
  a.buildId === b.buildId &&
  a.version === b.version &&
  a.firmware === b.firmware;

async function activatedRuntimeStillCurrent(
  consoleId: string,
  before: EmbeddedRuntime,
  signal?: AbortSignal,
) {
  const current = getConsoleProfile(consoleId);
  if (current.ip !== before.ip || current.platform !== 'ps5') return false;
  const after = embeddedRuntime(await ps5ServiceRequest(before.ip, '/health', signal), before.ip);
  signal?.throwIfAborted();
  const latest = getConsoleProfile(consoleId);
  return latest.ip === before.ip && latest.platform === 'ps5' && sameEmbeddedRuntime(before, after);
}

/** Worker admission for explicitly activated, previously tested content routes.
 * No PKG initialization or synchronous mount scan is required for these routes. */
export async function readPs5ActivatedRouteCapabilities(consoleId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const profile = getConsoleProfile(consoleId);
  if (profile.platform !== 'ps5') return;
  const activation = readPs5QualifiedRoutes(profile.id, profile.ip);
  if (!activation) return;
  try {
    const health = await ps5ServiceRequest(profile.ip, '/health', signal);
    const current = getConsoleProfile(consoleId);
    if (current.ip !== profile.ip || current.platform !== 'ps5') return emptyCapabilities();
    const before = embeddedRuntime(health, profile.ip);
    if (!before)
      return validPs5Health(health) && !claimsKnownEmbeddedBuild(health)
        ? undefined
        : emptyCapabilities();
    const auth = await ps5ServiceRequest(profile.ip, '/api/v1/capabilities', signal);
    if (
      auth.status !== 200 ||
      auth.body?.service !== 'PackageFlowService-PS5' ||
      !(await activatedRuntimeStillCurrent(consoleId, before, signal))
    )
      return emptyCapabilities();
    return withPs5QualifiedRoutes(emptyCapabilities(), activation);
  } catch {
    signal?.throwIfAborted();
    return emptyCapabilities();
  }
}

function embeddedPkgCapabilities(reason: string) {
  const ready = reason === 'ready';
  return ps5InstallCapabilities(
    200,
    {
      service: 'PackageFlowService-PS5',
      schemaVersion: 1,
      route: 'staged-pkg',
      exactVersionReceipt: false,
      ready,
      reason,
      formats: ready ? ['pkg'] : [],
      platforms: ready ? ['ps4', 'ps5'] : [],
    },
    '13.60',
  );
}
async function readEmbeddedPkgCapabilities(
  consoleId: string,
  before: EmbeddedRuntime,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (getConsoleProfile(consoleId).ip !== before.ip) throw Error('PS5 profile address changed');
  const hello = await ps5OperationRequest(
    consoleId,
    '/api/v1/installer/status',
    {},
    undefined,
    signal,
  );
  if (getConsoleProfile(consoleId).ip !== before.ip) throw Error('PS5 profile address changed');
  const after = embeddedRuntime(await ps5ServiceRequest(before.ip, '/health', signal), before.ip);
  signal?.throwIfAborted();
  if (getConsoleProfile(consoleId).ip !== before.ip) throw Error('PS5 profile address changed');
  if (!sameEmbeddedRuntime(before, after)) throw Error('PS5 runtime changed during PKG readiness');
  if (hello.status !== 200) return embeddedPkgCapabilities('readiness_unavailable');
  const body = hello.body;
  if (
    !body ||
    Object.keys(body).sort().join(',') !== 'escalated,fw,init_rc,ok,state,version' ||
    body.ok !== true ||
    body.version !== '1.4.0' ||
    body.fw !== '13' ||
    !Number.isSafeInteger(body.init_rc) ||
    body.init_rc < 0 ||
    body.init_rc > 0xffffffff ||
    typeof body.escalated !== 'boolean' ||
    ![
      'ready',
      'unverified',
      'initializing',
      'stopped',
      'context_unavailable',
      'init_failed',
    ].includes(body.state)
  )
    return embeddedPkgCapabilities('unrecognized_installer');
  if (body.state === 'unverified') return embeddedPkgCapabilities('embedded_backend_not_verified');
  return embeddedPkgCapabilities(
    body.state === 'ready' && body.init_rc === 0 && body.escalated === true
      ? 'ready'
      : 'initialization_failed',
  );
}

/** Only the measured embedded build may replace full SMP readiness with hello.
 * Other builds retain the existing full readiness contract. */
export async function readPs5PkgInstallCapabilities(consoleId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const profile = getConsoleProfile(consoleId);
  let health: { status: number; body: any };
  try {
    health = await ps5ServiceRequest(profile.ip, '/health', signal);
  } catch {
    signal?.throwIfAborted();
    return embeddedPkgCapabilities('readiness_unavailable');
  }
  const runtime = embeddedRuntime(health, profile.ip);
  if (runtime) {
    try {
      return await readEmbeddedPkgCapabilities(consoleId, runtime, signal);
    } catch {
      signal?.throwIfAborted();
      return embeddedPkgCapabilities('readiness_unavailable');
    }
  }
  if (!validPs5Health(health) || claimsKnownEmbeddedBuild(health))
    return embeddedPkgCapabilities('unrecognized_installer');
  const readiness = await ps5OperationRequest(
    consoleId,
    '/api/v1/install/readiness',
    {},
    undefined,
    signal,
  );
  return ps5InstallCapabilities(
    readiness.status,
    readiness.body,
    getConsoleProfile(consoleId).firmware,
  );
}

/** The polling path must not run the installer's synchronous hello while data
 * occupies the PS5's single HTTP handler. Explicit preflight remains fresh. */
/** The last probe found this PS5 asleep (rest mode). */
export function ps5RestMode(id: string) {
  return snapshots.get(id)?.restMode === true;
}

export function ps5TransferInProgress(id: string) {
  const path = dataPath('consoles', id, 'ps5-installation-queue.json');
  if (!existsSync(path)) return false;
  const queue = readJsonFile<any>(path, null);
  if (!queue || !Array.isArray(queue.items)) return true;
  return (
    queue.status === 'running' &&
    queue.items.some(
      (item: any) =>
        item.state === 'sending' ||
        item.state === 'receiving' ||
        (item.format === 'folder' && item.state === 'verifying' && item.bytesSent < item.size),
    )
  );
}
/** PS4 counterpart of ps5TransferInProgress: package data is being sent to the
 * service right now (queue file per console, or the legacy single-console file). */
function ps4TransferInProgress(ip: string) {
  const scoped = dataPath('consoles', ip, 'installation-queue.json'),
    legacy = dataPath('installation-queue.json');
  const queue = existsSync(scoped)
    ? readJsonFile<any>(scoped, null)
    : readJsonFile<any>(legacy, null)?.psIp === ip
      ? readJsonFile<any>(legacy, null)
      : null;
  return (
    queue?.status === 'running' &&
    Array.isArray(queue.items) &&
    queue.items.some((item: any) => item.state === 'sending' || item.state === 'receiving')
  );
}
/** A console receiving package data serves every request in line with the data
 * (PS5: one synchronous HTTP handler). Nothing automatic may delay it, not even
 * a /health round trip: background checks keep the last snapshot until it ends.
 * Explicit checks and install admission stay full and fresh. */
function consoleTransferInProgress(profile: Pick<StoredProfile, 'id' | 'ip' | 'platform'>) {
  return profile.platform === 'ps5'
    ? ps5TransferInProgress(profile.id)
    : profile.platform === 'ps4' && ps4TransferInProgress(profile.ip);
}
export type Ps5ProbeScope = 'full' | 'pkg';
const ps5Probes = new Map<
  string,
  { ip: string; background: boolean; scope: Ps5ProbeScope; pending: Promise<ConsoleProfiles> }
>();
const ps5ProbeGenerations = new Map<string, number>();

/** One PS5 has one synchronous HTTP listener. Join status callers and let a
 * foreground check follow a deferred background check, rather than race it. */
export async function probeConsoleProfile(
  id: unknown,
  background = false,
  scope: Ps5ProbeScope = 'full',
) {
  const profile = getConsoleProfile(id);
  if (profile.platform !== 'ps5') return runConsoleProfileProbe(profile, background);
  const existing = ps5Probes.get(profile.id);
  if (
    existing?.ip === profile.ip &&
    (background || (!existing.background && (existing.scope === 'full' || scope === 'pkg')))
  )
    return existing.pending;
  const run = () => {
    const current = store().consoles.find((item) => item.id === profile.id);
    if (!current || current.ip !== profile.ip || current.platform !== profile.platform)
      return Promise.resolve(getConsoleProfiles());
    const generation = (ps5ProbeGenerations.get(profile.id) || 0) + 1;
    ps5ProbeGenerations.set(profile.id, generation);
    return runConsoleProfileProbe(profile, background, generation, scope);
  };
  const pending = (existing?.ip === profile.ip ? existing.pending.then(run) : run()).finally(() => {
    if (ps5Probes.get(profile.id)?.pending === pending) ps5Probes.delete(profile.id);
  });
  ps5Probes.set(profile.id, { ip: profile.ip, background, scope, pending });
  return pending;
}

async function runConsoleProfileProbe(
  profile: StoredProfile,
  background = false,
  generation?: number,
  scope: Ps5ProbeScope = 'full',
) {
  const previous = snapshots.get(profile.id);
  if (background && previous?.online && consoleTransferInProgress(profile)) {
    // Marked deferred: a later explicit (non-background) check never reuses it.
    snapshots.set(profile.id, { ...previous, checkedAt: Date.now(), capabilitiesDeferred: true });
    return getConsoleProfiles();
  }
  let online = false,
    paired = false,
    verified = false,
    version: string | undefined,
    pkgVersion: string | undefined,
    firmware: string | undefined;
  let capabilities = emptyCapabilities();
  let freeBytes: number | undefined,
    totalBytes: number | undefined,
    transferFreeBytes: number | undefined;
  let model = profile.model,
    henName: string | undefined,
    henVersion: string | undefined,
    henSdk: string | undefined;
  let servicePid: number | undefined,
    serviceBuild: string | undefined,
    capabilitiesDeferred = false,
    runtimeIdentity: EmbeddedRuntime | undefined,
    fullCheckedAt: number | undefined;
  try {
    if (profile.platform === 'ps4' && profile.transport === 'payload') {
      online = (await getGoldHenStatus(profile.ip)).ready;
      capabilities = {
        formats: online ? ['pkg'] : [],
        installPs4: online,
        installPs5: false,
        background: false,
      };
      // PyLoader has no storage API. A stored service key must not make
      // this transport wait on the service's disk/system probe.
      firmware = profile.firmware;
    } else if (profile.platform === 'ps4') {
      const ping = await readPs4Service(profile.ip, '/ping');
      if (
        ping.status !== 200 ||
        (ping.body as any)?.service !== 'PackegeFlowService' ||
        (ping.body as any)?.status !== 'ok'
      )
        throw new Error('Unexpected service');
      online = verified = true;
      version = String((ping.body as any).version || '');
      const status = await getServiceInstallerStatus(profile.ip);
      paired = status.paired === true;
      capabilities = {
        formats: status.ready ? ['pkg'] : [],
        installPs4: status.ready,
        installPs5: false,
        background: false,
        contentTypes: status.contentTypes,
      };
      const system = await getPs4SystemSnapshot(profile.ip);
      pkgVersion = system.pkgVersion || undefined;
      firmware = system.system?.firmware || undefined;
      model = system.system?.model || model;
      henName = system.system?.henName || undefined;
      henVersion = system.system?.henVersion || undefined;
      henSdk = system.system?.henSdk || undefined;
      servicePid = system.runtime?.processId ?? undefined;
      const storage = system.storage?.find((volume) => volume.available && volume.path === '/user');
      freeBytes = storage?.availableBytes ?? undefined;
      totalBytes = storage?.totalBytes ?? undefined;
    } else {
      const health = await ps5ServiceRequest(profile.ip, '/health'),
        report = health.body?.serviceReport;
      if (
        health.status !== 200 ||
        health.body?.apiVersion !== 'v1' ||
        report?.service !== 'PackageFlowService-PS5' ||
        (report.platform && report.platform !== 'ps5') ||
        report.consoleVerified !== true
      )
        throw new Error('Unexpected service');
      online = verified = true;
      version = String(report.version || '');
      servicePid =
        Number.isSafeInteger(health.body.pid) && health.body.pid > 0 ? health.body.pid : undefined;
      serviceBuild = typeof report.buildId === 'string' ? report.buildId : undefined;
      // A verified service answers: close old unconfirmed launch journals of this IP.
      reconcileStalePs5StartJournals(profile.ip, serviceBuild || '');
      runtimeIdentity = embeddedRuntime(health, profile.ip);
      const raw = /^0x([0-9a-f]{2})([0-9a-f]{2})[0-9a-f]{4}$/i.exec(health.body.firmwareRaw || '');
      if (health.body.firmwareRead && raw && /^\d{2}$/.test(raw[1]!) && /^\d{2}$/.test(raw[2]!))
        firmware = `${Number(raw[1])}.${raw[2]}`;
      if (ps5Token(profile.ip)) {
        const response = await ps5ServiceRequest(profile.ip, '/api/v1/capabilities');
        paired = response.status === 200 && response.body?.service === 'PackageFlowService-PS5';
        if (paired) {
          const activation = runtimeIdentity && readPs5QualifiedRoutes(profile.id, profile.ip);
          const pkgScope = claimsKnownEmbeddedBuild(health) && (background || scope === 'pkg');
          const transferDeferred = background && ps5TransferInProgress(profile.id);
          capabilitiesDeferred = pkgScope || transferDeferred;
          if (transferDeferred) {
            // The data path retains its existing polling guard: no hello or
            // SMP request competes with receiving/verifying chunks.
            const sameProcess = runtimeIdentity
              ? sameEmbeddedRuntime(runtimeIdentity, previous?.runtimeIdentity)
              : !claimsKnownEmbeddedBuild(health) &&
                servicePid !== undefined &&
                !!serviceBuild &&
                previous?.servicePid === servicePid &&
                previous?.serviceBuild === serviceBuild;
            if (sameProcess && previous?.online && previous.paired) {
              capabilities = structuredClone(previous.capabilities);
              fullCheckedAt = previous.fullCheckedAt;
            }
          } else if (activation) {
            // Activated content routes are independent of PKG initialization.
            // Keep PKG's fresh hello proof, but a failed PKG hello cannot remove
            // explicitly enabled Folder/image routes from the same live service.
            try {
              capabilities = await readEmbeddedPkgCapabilities(profile.id, runtimeIdentity!);
            } catch {
              capabilities = embeddedPkgCapabilities('readiness_unavailable');
            }
            try {
              if (!(await activatedRuntimeStillCurrent(profile.id, runtimeIdentity!)))
                throw Error('PS5 runtime changed during activated route admission');
              capabilities = withPs5QualifiedRoutes(capabilities, activation);
              capabilitiesDeferred = false;
              fullCheckedAt = Date.now();
            } catch {
              capabilities = emptyCapabilities();
              runtimeIdentity = undefined;
            }
          } else if (pkgScope) {
            try {
              if (!runtimeIdentity) throw Error('Embedded PKG health is not recognized');
              capabilities = await readEmbeddedPkgCapabilities(profile.id, runtimeIdentity);
              if (sameEmbeddedRuntime(runtimeIdentity, previous?.runtimeIdentity)) {
                const formats = previous!.capabilities.formats.filter((format) => format !== 'pkg');
                capabilities.formats.push(...formats);
                capabilities.installPs5 ||= formats.length > 0;
                if (previous!.capabilities.folder)
                  capabilities.folder = structuredClone(previous!.capabilities.folder);
                if (previous!.capabilities.images)
                  capabilities.images = structuredClone(previous!.capabilities.images);
                fullCheckedAt = previous?.fullCheckedAt;
              }
            } catch {
              capabilities = embeddedPkgCapabilities('readiness_unavailable');
              runtimeIdentity = undefined;
            }
          } else {
            try {
              const readiness = await ps5ServiceRequest(profile.ip, '/api/v1/install/readiness');
              capabilities = ps5InstallCapabilities(readiness.status, readiness.body, firmware);
            } catch {
              capabilities = ps5InstallCapabilities(503, null, firmware);
            }
            // A completed full check may truthfully deny a route. Retain its
            // short cache independently of later basic status snapshots.
            fullCheckedAt = Date.now();
          }
          capabilities.background = response.body.capabilities?.backgroundService === true;
          const system = await ps5ServiceRequest(profile.ip, '/api/v1/system');
          if (
            system.status === 200 &&
            system.body?.service === 'PackageFlowService-PS5' &&
            system.body.storageRead === true &&
            Number.isSafeInteger(system.body.freeBytes) &&
            system.body.freeBytes >= 0 &&
            Number.isSafeInteger(system.body.totalBytes) &&
            system.body.totalBytes > 0 &&
            system.body.freeBytes <= system.body.totalBytes
          ) {
            freeBytes = system.body.freeBytes;
            totalBytes = system.body.totalBytes;
          }
          if (
            system.status === 200 &&
            system.body?.service === 'PackageFlowService-PS5' &&
            system.body.transferStorageRead === true &&
            Number.isSafeInteger(system.body.transferFreeBytes) &&
            system.body.transferFreeBytes >= 0
          )
            transferFreeBytes = system.body.transferFreeBytes;
        }
      }
    }
  } catch {
    /* A stored token is not proof that the current service accepts it. */
  }
  const latest = store(),
    current = latest.consoles.find((item) => item.id === profile.id);
  if (
    !current ||
    current.ip !== profile.ip ||
    current.platform !== profile.platform ||
    (generation !== undefined && ps5ProbeGenerations.get(profile.id) !== generation)
  )
    return getConsoleProfiles();
  if (verified) {
    current.verified = true;
    current.model = model;
    current.version = version;
    current.pkgVersion = pkgVersion;
    current.firmware = firmware;
    writeJsonFile(profilePath(), latest);
  }
  snapshots.set(profile.id, {
    online,
    paired,
    capabilities,
    freeBytes,
    totalBytes,
    transferFreeBytes,
    henName,
    henVersion,
    henSdk,
    checkedAt: Date.now(),
    servicePid,
    serviceBuild,
    capabilitiesDeferred,
    runtimeIdentity,
    fullCheckedAt,
    // Kept while offline until the discovery reply below says otherwise.
    restMode: online ? false : previous?.restMode,
  });
  if (profile.platform === 'ps5' && !online)
    // Asleep or off? Rest mode is shown as such, and nothing is started on a
    // sleeping console: the service is started again once it is awake.
    void ps5PowerState(profile.ip).then((power) => {
      const latestSnapshot = snapshots.get(profile.id);
      if (latestSnapshot && !latestSnapshot.online)
        snapshots.set(profile.id, { ...latestSnapshot, restMode: power === 'rest' });
      // A paired PS5 that answers on the network but not with its service: try
      // to start the saved service through PLDMGR (backed off, never during installs).
      if (power !== 'rest' && previous?.paired && ps5AutoStart)
        void ps5AutoStart(profile.id).catch(() => {});
    });
  return getConsoleProfiles();
}

const probes = new Map<string, Promise<ConsoleProfiles>>();
export async function refreshConsoleProfile(
  id: string,
  force = false,
  background = false,
  scope: Ps5ProbeScope = 'full',
) {
  const profile = getConsoleProfile(id);
  if (profile.platform === 'ps5' && ps5Probes.has(id))
    return probeConsoleProfile(id, background, scope);
  const snapshot = snapshots.get(id);
  if (
    !force &&
    snapshot?.checkedAt &&
    Date.now() - snapshot.checkedAt < 15000 &&
    (background || !snapshot.capabilitiesDeferred)
  )
    return Promise.resolve(getConsoleProfiles());
  if (profile.platform === 'ps5') return probeConsoleProfile(id, background, scope);
  const probeKey = `${id}:${background ? 'background' : 'full'}`;
  const existing = probes.get(probeKey);
  if (existing) return existing;
  const pending = probeConsoleProfile(id, background).finally(() => probes.delete(probeKey));
  probes.set(probeKey, pending);
  return pending;
}
const OFFLINE_RECHECK_MS = 60000;
let ps5AutoStart: ((id: string) => Promise<void>) | undefined;
/** Registered by the service-control plugin; console checks stay independent of it. */
export function setPs5ServiceAutoStart(handler: (id: string) => Promise<void>) {
  ps5AutoStart = handler;
}
/** No device-count limit; bound the number of simultaneous network probes. */
/** Install review and adding to a queue while this PS5 receives our own
 * package: reuse its last verified state. A full probe would compete with the
 * package data on the PS5's single handler and time out; a manual check still
 * probes it. */
export function refreshConsoleProfileForInstall(id: string, scope: Ps5ProbeScope = 'full') {
  const profile = getConsoleProfile(id),
    previous = snapshots.get(profile.id);
  if (
    profile.platform === 'ps5' &&
    previous?.online &&
    previous.paired &&
    ps5TransferInProgress(profile.id)
  ) {
    snapshots.set(profile.id, { ...previous, checkedAt: Date.now(), capabilitiesDeferred: true });
    return Promise.resolve(getConsoleProfiles());
  }
  return refreshConsoleProfile(id, true, false, scope);
}
export async function refreshConsoleProfiles(
  freshPs5 = false,
  scope: Ps5ProbeScope = 'full',
  includeRecentOffline = false,
  installReview = false,
) {
  // A console found offline in the last minute is not waited on again by bulk
  // checks (install review, periodic refresh); explicit per-device checks and
  // install targets still probe it.
  const profiles = getConsoleProfiles().consoles.filter((profile) => {
    const snapshot = snapshots.get(profile.id);
    return (
      includeRecentOffline ||
      !snapshot ||
      snapshot.online ||
      !snapshot.checkedAt ||
      Date.now() - snapshot.checkedAt >= OFFLINE_RECHECK_MS
    );
  });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, profiles.length) }, async () => {
      while (next < profiles.length) {
        const profile = profiles[next++]!,
          foreground = freshPs5 && profile.platform === 'ps5';
        await (
          installReview && foreground
            ? refreshConsoleProfileForInstall(profile.id, scope)
            : refreshConsoleProfile(profile.id, foreground, !foreground, scope)
        ).catch(() => {});
      }
    }),
  );
  return getConsoleProfiles();
}

/** Native catalogs must learn real Folder/image routes before the 044 client
 * applies its local format gate. Pagination shares a completed full check. */
export async function refreshPs5NativeCatalogProfile(id: string) {
  await refreshConsoleProfile(id, false, true);
  const snapshot = snapshots.get(id);
  if (
    !snapshot?.runtimeIdentity ||
    !snapshot.online ||
    !snapshot.paired ||
    ps5TransferInProgress(id) ||
    (snapshot.fullCheckedAt !== undefined && Date.now() - snapshot.fullCheckedAt < 15000)
  )
    return getConsoleProfiles();
  return refreshConsoleProfile(id, true, false, 'full');
}

/** The app obtains the paired server from its local service, as on PS4. */
export async function updatePairedConsoleWebAddress(id: unknown, webUrl: string) {
  const profile = getConsoleProfile(id);
  if (profile.platform === 'ps4') return updatePairedServiceWebAddress(profile.ip, webUrl);
  const headers = ps5WebAddressHeaders(webUrl, profile.id);
  const response = await ps5OperationRequest(profile.id, '/api/v1/web/config', headers);
  if (response.status === 404)
    throw createError({
      statusCode: 409,
      message: 'Обновите службу PS5 для автоматического адреса WEB',
    });
  if (response.status !== 200 || !ps5WebAddressAccepted(response.body, headers))
    throw createError({
      statusCode: 502,
      message: 'Служба PS5 не подтвердила сохранение адреса WEB',
    });
  return { updated: true, configured: true, message: 'Адрес WEB на PS5 обновлён' };
}

export async function pairConsoleProfile(id: unknown, webUrl: string) {
  const profile = getConsoleProfile(id);
  if (profile.platform === 'ps4') await saveServiceKey(profile.ip, webUrl);
  else {
    const health = await ps5ServiceRequest(profile.ip, '/health');
    if (
      health.status !== 200 ||
      health.body?.apiVersion !== 'v1' ||
      health.body?.serviceReport?.service !== 'PackageFlowService-PS5' ||
      (health.body.serviceReport.platform && health.body.serviceReport.platform !== 'ps5') ||
      health.body.serviceReport.consoleVerified !== true
    )
      throw createError({ statusCode: 409, message: 'По этому адресу не подтверждён сервис PS5' });
    if (health.body.pairingMode !== 'automatic')
      throw createError({
        statusCode: 409,
        message: 'Обновите нагрузку PackageFlow для подключения без кода',
      });
    const response = await ps5ServiceRequest(profile.ip, '/api/v1/pair');
    if (
      response.status !== 200 ||
      response.body?.apiVersion !== 'v1' ||
      response.body?.pairingMode !== 'automatic' ||
      !/^[0-9a-f]{64}$/.test(response.body?.token || '')
    )
      throw createError({
        statusCode: response.status === 401 ? 401 : 409,
        message: 'PS5 не подтвердила подключение. Проверьте связь и версию нагрузки PackageFlow.',
      });
    writeDurableJson(keyPath(), {
      ...readJsonFile(keyPath(), {}),
      [profile.ip]: response.body.token,
    });
    try {
      await updatePairedConsoleWebAddress(profile.id, webUrl);
    } catch {
      // Older services still pair. Keep the saved token and report only the
      // missing address synchronization, so the user does not pair again.
      const profiles = await probeConsoleProfile(profile.id);
      return {
        ...profiles,
        webAddress: {
          updated: false,
          message:
            'Сопряжение сохранено. Для автоматического адреса WEB обновите службу PS5 и обновите адрес WEB в подключении.',
        },
      };
    }
  }
  return probeConsoleProfile(profile.id);
}

/** Icons only from /user/appmeta/<validated title>/icon0.png; credentials stay in WEB. */
export async function ps5ConsoleIcon(consoleId: string, titleId: string) {
  const p = getConsoleProfile(consoleId),
    token = ps5Token(p.ip);
  if (p.platform !== 'ps5' || !token || !/^(PPSA|CUSA)\d{5}$/.test(titleId))
    throw createError({ statusCode: 404, message: 'Значок недоступен' });
  notePs5RequestDuringTransfer(p.id, '/api/v1/console/icon');
  const r = await fetch(`http://${p.ip}:8095/api/v1/console/icon`, {
    headers: { Authorization: `Bearer ${token}`, 'X-PackageFlow-Title': titleId },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const expected = Number(r.headers.get('content-length'));
  if (
    r.status !== 200 ||
    r.headers.get('content-type') !== 'image/png' ||
    !Number.isSafeInteger(expected) ||
    expected < 8 ||
    expected > 1048576
  ) {
    await r.body?.cancel();
    throw createError({ statusCode: 404, message: 'Значок недоступен' });
  }
  const reader = r.body?.getReader();
  if (!reader) throw Error('Empty icon');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > expected) throw Error('Icon overflow');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = Buffer.concat(chunks);
  if (
    bytes !== expected ||
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw createError({ statusCode: 404, message: 'Значок повреждён' });
  return data;
}

/** Synthetic test endpoints only. The service credential never leaves WEB. */
export async function ps5SpeedRequest(
  consoleId: string,
  mode: 'upload' | 'download' | 'disk',
  size: number,
  signal: AbortSignal,
) {
  const profile = getConsoleProfile(consoleId),
    token = ps5Token(profile.ip);
  if (profile.platform !== 'ps5' || !token)
    throw createError({ statusCode: 409, message: 'Требуется подключение PS5' });
  if (
    !['upload', 'download', 'disk'].includes(mode) ||
    !Number.isInteger(size) ||
    size < 1048576 ||
    size > 268435456
  )
    throw new Ps5OperationValidationError('Invalid speed test');
  const { Readable } = await import('node:stream');
  const block = Buffer.alloc(1048576, 0x5a);
  async function* bytes() {
    for (let n = 0; n < size; n += block.length) {
      signal.throwIfAborted();
      yield block.subarray(0, Math.min(block.length, size - n));
    }
  }
  return fetch(`http://${profile.ip}:8095/api/v1/benchmark/${mode}`, {
    method: mode === 'download' ? 'GET' : 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-PackageFlow-Size': String(size),
      ...(mode === 'download'
        ? {}
        : { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) }),
    },
    ...(mode === 'download' ? {} : { body: Readable.from(bytes()) as any, duplex: 'half' as any }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
  });
}

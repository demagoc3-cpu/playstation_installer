import { authenticatedServiceRequest, serviceKeyConfigured } from './ps4-service-installer';
import { contentFormat } from '../../shared/content-platform';
import type { ContentFormat } from '../../shared/types/consoles';
import { readPs5Installed, withPs5InstalledReview } from './ps5-installed-read-coordinator';
// Lazy loading keeps the PS4 queue independent of PS5 profile/runtime helpers.
async function readPs5(
  ...args: Parameters<typeof import('./console-profiles').ps5OperationRequest>
) {
  const { ps5OperationRequest } = await import('./console-profiles');
  return ps5OperationRequest(...args);
}

export interface InstalledCandidate {
  id: string;
  titleId: string;
  contentId?: string;
  appVersion?: string;
  installOrder: number;
  type?: string;
  format?: ContentFormat;
  contentType?: string;
}
export interface InstalledCheck {
  transient?: boolean;
  /** PS5 lists the title as registered but has no Folder/image source for it. */
  sourceMissing?: boolean;
  revision?: string;
  components?: Array<{
    id: string;
    kind: string;
    version: string;
    contentId: string;
    canRemove: boolean;
    title?: string;
  }>;
  state: 'absent' | 'installed' | 'base-present' | 'unavailable';
  detail: string;
}
const unavailable = (transient = false): InstalledCheck => ({
  state: 'unavailable',
  ...(transient ? { transient: true } : {}),
  detail:
    'Не удалось проверить установленные пакеты на приставке. Ожидаем связь; повторная установка не отправлена',
});
const transientStatus = (status: number) => [408, 425, 429, 500, 502, 503, 504].includes(status);
class DeferredPs5InstalledRead extends Error {}
interface Ps5InstalledReadOptions {
  background?: boolean;
  backgroundReadAllowed?: (consoleId: string) => boolean;
}
function transientReadError(error: unknown) {
  if (error instanceof DeferredPs5InstalledRead) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError') return true;
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return (
    typeof code === 'string' &&
    /^(?:UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE)$/.test(
      code,
    )
  );
}
const sameVersion = (a?: string, b?: string) =>
  !!a &&
  !!b &&
  /^\d+(?:\.\d+)+$/.test(a) &&
  /^\d+(?:\.\d+)+$/.test(b) &&
  a.split('.').map(Number).join('.') === b.split('.').map(Number).join('.');
const newerVersion = (a?: string, b?: string) => {
  if (!a || !b || !/^\d+(?:\.\d+)+$/.test(a) || !/^\d+(?:\.\d+)+$/.test(b)) return false;
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const delta = (x[i] || 0) - (y[i] || 0);
    if (delta) return delta > 0;
  }
  return false;
};
const newerPresent = (): InstalledCheck => ({
  state: 'base-present',
  detail:
    'На приставке уже установлена более новая версия патча; автоматическое понижение версии пропущено',
});
const absent = (): InstalledCheck => ({ state: 'absent', detail: '' });
const installed = (): InstalledCheck => ({
  state: 'installed',
  detail: 'Пакет уже установлен на этой приставке; повторная установка пропущена',
});
const basePresent = (): InstalledCheck => ({
  state: 'base-present',
  detail:
    'Базовая игра уже установлена на этой приставке. Повторная установка пропущена; переустановку выберите вручную',
});

// Title ID alone identifies a game, never an individual patch or DLC.
export function matchInstalledComponent(
  pkg: InstalledCandidate,
  components: Array<{ kind: string; version: string; contentId: string }>,
): InstalledCheck {
  const kind =
    pkg.installOrder === 0 ? 'base' : pkg.type === 'DLC' || pkg.installOrder >= 2 ? 'dlc' : 'patch';
  const exact = components.some(
    (row) =>
      row.kind === kind &&
      !!pkg.contentId &&
      row.contentId === pkg.contentId &&
      (kind === 'dlc' || sameVersion(row.version, pkg.appVersion)),
  );
  if (exact) return installed();
  if (
    kind === 'patch' &&
    components.some(
      (row) =>
        row.kind === kind &&
        row.contentId === pkg.contentId &&
        newerVersion(row.version, pkg.appVersion),
    )
  )
    return newerPresent();
  return kind === 'base' &&
    components.some((row) => row.kind === 'base' && row.contentId.includes(`-${pkg.titleId}_`))
    ? basePresent()
    : absent();
}
export async function checkPs4InstalledPackage(
  ip: string,
  pkg: InstalledCandidate,
  requiresPairing = false,
  read = authenticatedServiceRequest,
): Promise<InstalledCheck> {
  // PS4 can also register PS2 Classics (SLES/SLUS) and homebrew IDs. The
  // service uses nine uppercase alphanumeric characters, not only CUSA.
  if (!/^[A-Z0-9]{9}$/.test(pkg.titleId)) return unavailable();
  if (requiresPairing && !serviceKeyConfigured(ip))
    return {
      ...unavailable(),
      detail:
        'Для проверки установленных пакетов PyLoader требуется сопряжённый PackageFlowService. Отметки WEB не подтверждают наличие на PS4',
    };
  try {
    let offset = 0,
      revision: string | undefined,
      total: number | undefined;
    const components: NonNullable<InstalledCheck['components']> = [];
    for (let page = 0; page < 17; page++) {
      const v: any = await read(
        ip,
        `/apps/title/${pkg.titleId}?offset=${offset}${revision ? `&revision=${revision}` : ''}`,
        'GET',
      );
      if (
        v?.service !== 'PackegeFlowService' ||
        v.complete !== true ||
        v.app?.titleId !== pkg.titleId ||
        typeof v.app.installed !== 'boolean' ||
        !/^[a-f0-9]{16}$/.test(v.revision) ||
        (revision !== undefined && revision !== v.revision) ||
        !Number.isInteger(v.total) ||
        v.total < 0 ||
        v.total > 130 ||
        (total !== undefined && total !== v.total) ||
        !Array.isArray(v.components) ||
        v.components.length !== Math.min(8, v.total - offset) ||
        v.next !== (offset + v.components.length === v.total ? null : offset + v.components.length)
      )
        return unavailable();
      revision = v.revision;
      total = v.total;
      if (!v.app.installed) return v.total === 0 ? absent() : unavailable();
      if (v.total === 0) return unavailable();
      for (const row of v.components) {
        if (
          !row ||
          !['base', 'patch', 'dlc'].includes(row.kind) ||
          typeof row.version !== 'string' ||
          typeof row.contentId !== 'string' ||
          !row.contentId.includes(`-${pkg.titleId}_`)
        )
          return unavailable();
        components.push(row);
      }
      if (v.next === null) {
        if (!components.some((row) => row.kind === 'base')) return unavailable();
        return { ...matchInstalledComponent(pkg, components), revision, components };
      }
      offset = v.next;
    }
  } catch (error: any) {
    if (error?.statusCode === 404 && error?.data?.serviceError === 'component_not_found')
      return absent();
    // A missing endpoint or interrupted snapshot never proves absence.
  }
  return unavailable();
}
export function matchPs5InstalledGame(
  pkg: InstalledCandidate,
  row: { installed: boolean; version: string; content_id: string },
  _legacyRecord = false,
): InstalledCheck {
  if (!row.installed) return absent();
  if (pkg.installOrder === 0)
    return row.content_id === pkg.contentId && sameVersion(row.version, pkg.appVersion)
      ? installed()
      : basePresent();
  // The live current version can prove a patch, but cannot identify a DLC.
  if (
    pkg.type !== 'DLC' &&
    pkg.installOrder === 1 &&
    row.content_id === pkg.contentId &&
    sameVersion(row.version, pkg.appVersion)
  )
    return installed();
  if (
    pkg.type !== 'DLC' &&
    pkg.installOrder === 1 &&
    row.content_id === pkg.contentId &&
    newerVersion(row.version, pkg.appVersion)
  )
    return newerPresent();
  if (pkg.type === 'DLC')
    return {
      ...unavailable(),
      detail:
        'Служба PS5 пока не подтверждает состав DLC с устройства. Локальные отметки WEB не используются',
    };
  return absent();
}
async function readPs5InstalledPackage(
  consoleId: string,
  ip: string,
  pkg: InstalledCandidate,
  signal?: AbortSignal,
  read = readPs5,
): Promise<InstalledCheck> {
  try {
    const status = await read(consoleId, '/api/v1/management/status', {}, undefined, signal);
    if (
      status.status !== 200 ||
      status.body?.protocol !== 'ps5-management-v1' ||
      status.body.ready !== true ||
      status.body.catalog !== true
    )
      return unavailable(transientStatus(status.status));
    let offset = 0,
      revision: string | undefined;
    let found: { installed: boolean; version: string; content_id: string } | undefined;
    for (let page = 0; page < 4096; page++) {
      const r = await read(
        consoleId,
        '/api/v1/console/catalog',
        { 'X-PackageFlow-Offset': String(offset) },
        undefined,
        signal,
      );
      const v = r.body;
      if (r.status !== 200) return unavailable(transientStatus(r.status));
      if (
        !/^[a-f0-9]{64}$/.test(v?.revision) ||
        !Array.isArray(v.entries) ||
        v.entries.length > 1 ||
        v.next !== offset + v.entries.length ||
        typeof v.done !== 'boolean' ||
        (!v.done && !v.entries.length)
      )
        return unavailable();
      for (const row of v.entries) {
        if (
          !/^(PPSA|CUSA)\d{5}$/.test(row?.titleId) ||
          typeof row.contentId !== 'string' ||
          typeof row.metadata !== 'string' ||
          row.metadata.length > 32768
        )
          return unavailable();
        if (row.titleId === pkg.titleId) {
          let meta: any = {};
          try {
            meta = JSON.parse(row.metadata);
          } catch {
            if (pkg.format === 'pkg' && pkg.installOrder === 0) return unavailable();
          }
          if (
            pkg.format === 'pkg' &&
            pkg.installOrder === 0 &&
            (!meta || typeof meta !== 'object' || Array.isArray(meta))
          )
            return unavailable();
          const version = meta.contentVersion || meta.CONTENT_VERSION || '';
          if (typeof version !== 'string') return unavailable();
          const value = { installed: true, version, content_id: row.contentId };
          if (!found || row.contentId === pkg.contentId) found = value;
        }
      }
      if (revision !== undefined && revision !== v.revision) return unavailable(true);
      revision = v.revision;
      offset = v.next;
      if (v.done) {
        if (!found) return absent();
        if (pkg.format === 'pkg' && pkg.installOrder === 0) {
          // A complete native catalog proves base registration, not that its
          // files or the selected version are present. Keep manual overwrite.
          return {
            ...basePresent(),
            detail:
              'Игра зарегистрирована на PS5; наличие файлов и версия выбранного пакета не подтверждены. Для замены выберите переустановку',
            revision,
          };
        }
        const info = await read(
          consoleId,
          '/api/v1/console/info',
          { 'X-PackageFlow-Title': pkg.titleId },
          undefined,
          signal,
        );
        const row = info.body;
        if (info.status !== 200) return unavailable(transientStatus(info.status));
        if (
          row?.title_id !== pkg.titleId ||
          typeof row.installed !== 'boolean' ||
          typeof row.source_available !== 'boolean' ||
          typeof row.content_id !== 'string' ||
          typeof row.version !== 'string'
        )
          return unavailable();
        // A built-in/system-installed game may have an app.db registration
        // without a Folder/image source. That is live evidence of a base title,
        // not proof of the selected package/version and not a network outage.
        if (!row.source_available)
          return pkg.installOrder === 0 && row.installed
            ? {
                ...basePresent(),
                detail:
                  'Игра зарегистрирована на PS5; версия выбранного пакета не подтверждена. Для замены выберите переустановку',
                revision: row.sourceIdentity,
                sourceMissing: true,
              }
            : {
                ...unavailable(),
                detail:
                  'PS5 отвечает, но версия установленного пакета не подтверждена. Передача этого пакета не отправлена',
              };
        return {
          ...matchPs5InstalledGame(pkg, row, false),
          revision: row.sourceIdentity || JSON.stringify([row.content_id, row.version, row.path]),
        };
      }
    }
    return unavailable();
  } catch (error) {
    signal?.throwIfAborted();
    return unavailable(transientReadError(error));
  }
}

export async function checkPs5InstalledPackage(
  consoleId: string,
  ip: string,
  pkg: InstalledCandidate,
  signal?: AbortSignal,
  read = readPs5,
  { background = false, backgroundReadAllowed }: Ps5InstalledReadOptions = {},
): Promise<InstalledCheck> {
  const request: typeof readPs5 = (...args) =>
    readPs5Installed(
      consoleId,
      background ? 'background' : 'foreground',
      () => {
        // The queue can start after a background check queued this read.
        // Recheck at dispatch so no delayed inventory poll competes with data.
        if (background && backgroundReadAllowed?.(consoleId) === false)
          throw new DeferredPs5InstalledRead('Background lookup deferred while PS5 is busy');
        return read(...args);
      },
      signal,
    );
  const check = () => readPs5InstalledPackage(consoleId, ip, pkg, signal, request);
  return background ? check() : withPs5InstalledReview([consoleId], check, signal);
}

/** Share a single read-only snapshot within one preview, never across submissions. */
export function installedPackagePreviewChecker({
  background = false,
  backgroundReadAllowed,
}: Ps5InstalledReadOptions = {}) {
  const snapshots = new Map<string, Promise<any>>();
  const memo = (key: string, call: () => Promise<any>) => {
    let value = snapshots.get(key);
    if (!value) {
      value = call();
      snapshots.set(key, value);
    }
    return value;
  };
  const ps4: typeof authenticatedServiceRequest = (ip, path, method, body) =>
    memo(JSON.stringify(['ps4', ip, path]), () =>
      authenticatedServiceRequest(ip, path, method, body),
    );
  const ps5: typeof readPs5 = (id, path, headers, body, signal) =>
    memo(JSON.stringify(['ps5', id, path, headers]), () =>
      readPs5(id, path, headers, body, signal),
    );
  return (
    profile: { id: string; ip: string; platform: string; transport?: string },
    pkg: InstalledCandidate,
  ) =>
    profile.platform === 'ps5'
      ? checkPs5InstalledPackage(
          profile.id,
          profile.ip,
          { ...pkg, format: contentFormat(pkg) },
          undefined,
          ps5,
          { background, backgroundReadAllowed },
        )
      : checkPs4InstalledPackage(profile.ip, pkg, profile.transport === 'payload', ps4);
}

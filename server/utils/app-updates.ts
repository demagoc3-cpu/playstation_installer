import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createError } from 'h3';
import { dataPath } from './data-path';
import { readJsonFile, writeJsonFile } from './json-store';

/* PackageFlow (WEB with the Windows or Linux shell) updates: the installed
 * version comes from release.json that both installers place four folders
 * above the WEB server entry (<root>/{server|web}/.output/server/index.mjs);
 * the newest version is the latest GitHub release. Only a notice: nothing is
 * downloaded or installed from here. */

const VERSION = /^\d+\.\d+\.\d+$/;
const repository = () =>
  /^[\w.-]+\/[\w.-]+$/.test(process.env.PACKAGEFLOW_RELEASE_REPOSITORY || '')
    ? process.env.PACKAGEFLOW_RELEASE_REPOSITORY!
    : 'demagoc3-cpu/playstation_installer';
const settingsPath = () => dataPath('app-update-settings.json');
const AUTO_INTERVAL = 6 * 60 * 60 * 1000;

export interface AppUpdateState {
  installed: string | null;
  latest?: { version: string; url: string; publishedAt: string };
  available: boolean;
  checkedAt?: number;
  error?: string;
  autoCheck: boolean;
}

let installedCache: string | null | undefined;
/** The installed PackageFlow version, or null in development and Docker. */
export function installedAppVersion() {
  if (installedCache !== undefined) return installedCache;
  const fromEnv = process.env.PACKAGEFLOW_VERSION;
  if (fromEnv && VERSION.test(fromEnv)) return (installedCache = fromEnv);
  installedCache = null;
  const entry = process.argv[1];
  if (entry) {
    const file = resolve(dirname(dirname(dirname(dirname(resolve(entry))))), 'release.json');
    try {
      if (existsSync(file)) {
        const version = JSON.parse(readFileSync(file, 'utf8'))?.version;
        if (typeof version === 'string' && VERSION.test(version)) installedCache = version;
      }
    } catch {
      /* Unknown version: no comparison is made. */
    }
  }
  return installedCache;
}

/** -1, 0 or 1 for two x.y.z versions. */
export function compareVersions(a: string, b: string) {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

export function getAppUpdateSettings() {
  const saved = readJsonFile<{ autoCheck?: unknown }>(settingsPath(), {});
  return { autoCheck: saved.autoCheck !== false };
}
export function saveAppUpdateSettings(input: unknown) {
  if (!input || typeof input !== 'object' || typeof (input as any).autoCheck !== 'boolean')
    throw createError({
      statusCode: 400,
      message: 'Укажите, проверять ли обновления автоматически',
    });
  const settings = { autoCheck: (input as any).autoCheck as boolean };
  writeJsonFile(settingsPath(), settings);
  if (settings.autoCheck) void checkAppUpdates().catch(() => {});
  return appUpdateState();
}

let last: Omit<AppUpdateState, 'installed' | 'available' | 'autoCheck'> = {};
let running: Promise<void> | undefined;

export function appUpdateState(): AppUpdateState {
  const installed = installedAppVersion();
  return {
    installed,
    ...last,
    available: !!installed && !!last.latest && compareVersions(last.latest.version, installed) > 0,
    autoCheck: getAppUpdateSettings().autoCheck,
  };
}

/** Ask GitHub for the latest release. Concurrent calls share one request. */
export function checkAppUpdates() {
  running ??= (async () => {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository()}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PackageFlow' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`GitHub не ответил (${response.status})`);
      const release = (await response.json()) as any;
      const version = String(release?.tag_name || '').replace(/^v/, '');
      if (!VERSION.test(version) || typeof release.html_url !== 'string')
        throw new Error('GitHub вернул неизвестный формат релиза');
      last = {
        latest: { version, url: release.html_url, publishedAt: String(release.published_at || '') },
        checkedAt: Date.now(),
      };
    } catch (error) {
      last = {
        ...last,
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : 'Не удалось проверить обновления',
      };
    } finally {
      running = undefined;
    }
  })();
  return running.then(appUpdateState);
}

/** Automatic checks: soon after start, then every 6 hours, while enabled. */
export function startAppUpdateChecks() {
  const tick = () => {
    // Without a known installed version (development, Docker) there is nothing to compare.
    if (installedAppVersion() && getAppUpdateSettings().autoCheck)
      void checkAppUpdates().catch(() => {});
  };
  const first = setTimeout(tick, 30 * 1000);
  first.unref?.();
  const timer = setInterval(tick, AUTO_INTERVAL);
  timer.unref?.();
}

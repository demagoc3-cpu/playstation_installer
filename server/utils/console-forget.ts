import { createError } from 'h3';
import { getConsoleProfile, removeConsoleProfile } from './console-profiles';
import { getInstallationQueue } from './installation-queue';
import { getPs5Queue, pausePs5Queue } from './ps5-installation-queue';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dataPath } from './data-path';

// An unfinished record blocks removal only while it is fresh: a record left
// behind by a crash or an old service must not keep a device forever.
const RECENT_MS = 15 * 60 * 1000;

function pendingPs5Journal(id: string) {
  for (const [folder, terminal] of [
    ['ps5-save-restores', ['failed', 'confirmed', 'rolled-back']],
    ['ps5-save-jobs', ['failed', 'complete']],
    ['ps5-game-commands', ['failed', 'accepted']],
    ['ps5-service-updates', ['failed', 'completed']],
  ] as const) {
    const path = dataPath(folder);
    if (!existsSync(path)) continue;
    for (const file of readdirSync(path).filter((name) => /^[a-f0-9]{32}\.json$/.test(name))) {
      let record: any;
      try {
        record = JSON.parse(readFileSync(dataPath(folder, file), 'utf8'));
      } catch {
        throw createError({
          statusCode: 503,
          message: 'Не удалось проверить незавершённые операции. Устройство не удалено',
        });
      }
      if (
        record.consoleId === id &&
        !(terminal as readonly string[]).includes(record.state) &&
        Date.now() - statSync(dataPath(folder, file)).mtimeMs < RECENT_MS
      )
        return true;
    }
  }
  return false;
}

function maintenanceRunning(ip: string) {
  const path = dataPath('console-maintenance.json');
  if (!existsSync(path)) return false;
  try {
    const flow = JSON.parse(readFileSync(path, 'utf8'))?.[ip];
    return !!flow && !['completed', 'failed'].includes(flow.state);
  } catch {
    return false;
  }
}

/** What still works with this device right now; '' when it can be forgotten. */
export function forgetBlocker(id: unknown) {
  const p = getConsoleProfile(id);
  if (p.platform === 'ps5') {
    // A paused queue and its waiting or unconfirmed items stay with the
    // dropped profile; forgetConsole pauses a running queue first.
    if (getPs5Queue(p.id).status === 'running')
      return 'Приставка уже выполняет системную установку. Дождитесь результата или снимите ожидание в «Заданиях», затем удалите устройство';
    if (pendingPs5Journal(p.id))
      return 'С этой PS5 сейчас выполняется операция с сохранениями, играми или службой. Дождитесь её окончания';
    return '';
  }
  const queue = getInstallationQueue(p.ip);
  if (['running', 'cancelling'].includes(queue.status))
    return 'На этом устройстве идёт установка. Остановите или отмените её в «Заданиях», затем удалите устройство';
  if (maintenanceRunning(p.ip))
    return 'На этой PS4 идёт обновление службы. Дождитесь его окончания';
  return '';
}

/** Forget this WEB/Windows client; console-side trust and files are preserved. */
export async function forgetConsole(id: unknown, confirmed: unknown) {
  if (confirmed !== true)
    throw createError({ statusCode: 400, message: 'Подтвердите удаление устройства' });
  const p = getConsoleProfile(id);
  // A PS5 queue may wait for an offline console forever: stop sending first.
  // Pausing is refused once the console runs the system installation.
  if (p.platform === 'ps5') {
    const queue = getPs5Queue(p.id);
    if (queue.status === 'running' && queue.id)
      await pausePs5Queue(p.id, queue.id).catch(() => undefined);
  }
  const blocker = forgetBlocker(p.id);
  if (blocker) throw createError({ statusCode: 409, message: blocker });
  const profiles = removeConsoleProfile(p.id);
  return {
    profiles,
    remotePairing: 'unchanged',
    message:
      'Устройство и ключ удалены из этого Windows/WEB. Данные приставки сохранены. Для нового подключения выберите найденную приставку и нажмите «Подключить».',
  };
}

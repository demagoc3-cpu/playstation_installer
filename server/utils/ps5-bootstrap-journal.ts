import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createError } from 'h3';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';

/** An old launch/bootstrap journal is reconciled only after this long untouched. */
export const STALE_PS5_START_MS = 10 * 60 * 1000;

/** Unfinished launch/bootstrap journals of this IP that nothing has touched
 * for a while are closed once a verified PS5 service answers on that IP. The
 * old attempt stays unconfirmed (state «failed» with an explanation), never a
 * success, and nothing is sent again. */
export function reconcileStalePs5StartJournals(ip: string, build: string, now = Date.now()) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return 0;
  const paths = [dataPath('consoles', ip, 'service-start.json')];
  const directory = dataPath('console-setup');
  if (existsSync(directory))
    for (const name of readdirSync(directory))
      if (/^bootstrap-[a-zA-Z0-9_-]{1,64}\.json$/.test(name))
        paths.push(dataPath('console-setup', name));
  let closed = 0;
  for (const path of paths) {
    try {
      if (!existsSync(path) || now - statSync(path).mtimeMs < STALE_PS5_START_MS) continue;
      const record = JSON.parse(readFileSync(path, 'utf8'));
      if (record?.ip !== ip || ['completed', 'failed'].includes(record.state)) continue;
      writeDurableJson(path, {
        ...record,
        state: 'failed',
        previousState: record.state,
        reconciledAt: now,
        message: `Прежний запуск не подтверждён; на приставке уже работает служба ${build || 'PS5'}. Повтор не отправлялся`,
      });
      closed++;
    } catch {
      /* Unreadable journals stay untouched and keep blocking, as before. */
    }
  }
  return closed;
}

/** Neither ordinary installation nor service update may race an uncertain bootstrap. */
export function assertNoPs5Bootstrap(id: string, ip?: string) {
  const paths = [{ path: dataPath('console-setup', `bootstrap-${id}.json`), own: true }];
  if (ip && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    paths.push({ path: dataPath('consoles', ip, 'service-start.json'), own: false });
    const directory = dataPath('console-setup');
    if (existsSync(directory))
      for (const name of readdirSync(directory)) {
        if (!/^bootstrap-[a-zA-Z0-9_-]{1,64}\.json$/.test(name) || name === `bootstrap-${id}.json`)
          continue;
        const path = dataPath('console-setup', name);
        try {
          if (JSON.parse(readFileSync(path, 'utf8'))?.ip === ip) paths.push({ path, own: false });
        } catch {
          /* An unrelated legacy profile must not block every console. */
        }
      }
  }
  for (const { path, own } of paths) {
    if (!existsSync(path)) continue;
    try {
      const f = JSON.parse(readFileSync(path, 'utf8'));
      if ((own ? f.consoleId === id : f.ip === ip) && ['completed', 'failed'].includes(f.state))
        continue;
    } catch {
      /* Unknown journals are not safe to replay. */
    }
    throw createError({
      statusCode: 409,
      message:
        'Запуск ELF пока не подтверждён. Проверьте результат в разделе «Устройства» или Windows-мастере; новая операция не отправлена',
    });
  }
}

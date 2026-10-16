import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createError } from 'h3';
import { dataPath } from './data-path';

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

import { isIP } from 'node:net';
import { getConsoleProfile } from '../../utils/console-profiles';

/** Read-only bootstrap for the native PS5 app. Contains no pairing credentials. */
export default defineEventHandler((event) => {
  const query = getQuery(event),
    profile = getConsoleProfile(query.consoleId);
  if (profile.platform !== 'ps5')
    throw createError({ statusCode: 400, message: 'Выберите профиль PS5' });
  const url = getRequestURL(event);
  const host = typeof query.host === 'string' ? query.host : url.hostname;
  const port = Number(query.port ?? (url.port || 3000));
  const privateHost =
    isIP(host) === 4 &&
    (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  if (!privateHost || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw createError({
      statusCode: 400,
      message: 'Укажите локальный IPv4 и порт компьютера с WEB',
    });
  }
  setHeader(event, 'Content-Type', 'text/plain; charset=utf-8');
  setHeader(event, 'Content-Disposition', 'attachment; filename="packageflow-ui.conf"');
  setHeader(event, 'Cache-Control', 'no-store');
  return `PFUI2\n${host}\n${port}\n${profile.id}\n10\n`;
});

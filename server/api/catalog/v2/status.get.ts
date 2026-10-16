import { getConsoleProfile, refreshConsoleProfile } from '../../../utils/console-profiles';
export default defineEventHandler(async (event) => {
  const profile = getConsoleProfile(getQuery(event).consoleId);
  if (profile.platform !== 'ps5')
    throw createError({ statusCode: 400, message: 'Выберите профиль PS5' });
  // Native clients also work while no WEB tab is open. The shared probe cache
  // coalesces concurrent callers and refreshes at most once every 15 seconds.
  const current = (await refreshConsoleProfile(profile.id)).consoles.find(
    (item) => item.id === profile.id,
  );
  if (!current) throw createError({ statusCode: 404, message: 'Профиль удалён' });
  setHeader(event, 'Cache-Control', 'no-store');
  return {
    schemaVersion: 2,
    consoleId: current.id,
    platform: current.platform,
    ip: current.ip,
    paired: current.paired,
    online: current.online,
    version: current.version || '',
    firmware: current.firmware || '',
    capabilities: current.capabilities,
  };
});

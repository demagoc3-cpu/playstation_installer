import { refreshConsoleProfiles } from '../../utils/console-profiles';
import { assertInstallationOrigin } from '../../utils/installation-origin';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const body = await readBody(event).catch(() => undefined);
  // «Обновить подключения» checks every device; periodic refreshes skip
  // consoles that were offline a moment ago.
  return refreshConsoleProfiles(false, 'full', body?.all === true);
});

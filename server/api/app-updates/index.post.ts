import { assertInstallationOrigin } from '../../utils/installation-origin';
import { checkAppUpdates, saveAppUpdateSettings } from '../../utils/app-updates';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const body = await readBody(event);
  if (body?.action === 'check') return checkAppUpdates();
  return saveAppUpdateSettings(body);
});

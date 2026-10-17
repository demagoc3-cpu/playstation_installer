import { assertInstallationOrigin } from '../../utils/installation-origin';
import { startPs5ServiceAction } from '../../utils/ps5-service-control';

export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const body = await readBody(event);
  return startPs5ServiceAction(body?.consoleId, body?.action);
});

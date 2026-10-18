import { forgetConsole } from '../../utils/console-forget';
import { assertInstallationOrigin } from '../../utils/installation-origin';
/** WEB «Удалить устройство»: the same rule as the Windows/Linux desktop removal. */
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const body = await readBody(event);
  return (await forgetConsole(body?.id, body?.confirmed)).profiles;
});

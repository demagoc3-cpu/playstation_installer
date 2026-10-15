import { previewDeviceInstall } from '../../utils/device-installation';
import { assertInstallationOrigin } from '../../utils/installation-origin';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  return previewDeviceInstall(await readBody(event));
});

import { assertInstallationOrigin } from '../../utils/installation-origin';
import { savePs4InstallSettings } from '../../utils/ps4-install-settings';

export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  return savePs4InstallSettings(await readBody(event));
});

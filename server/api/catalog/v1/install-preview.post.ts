import { assertInstallationOrigin } from '../../../utils/installation-origin';
import { previewNativeInstall } from '../../../utils/native-install-review';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  setHeader(event, 'Cache-Control', 'no-store');
  return previewNativeInstall(await readBody(event), 'ps4');
});

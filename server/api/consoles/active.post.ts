import { selectConsoleProfile } from '../../utils/console-profiles';
import { assertInstallationOrigin } from '../../utils/installation-origin';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  return selectConsoleProfile((await readBody(event))?.id);
});

import { beginPs5ServiceStart } from '../../utils/ps5-service-start';
import { assertInstallationOrigin } from '../../utils/installation-origin';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const input = await readBody(event);
  // Admission failures precede the background runner. No automatic retry is made.
  return beginPs5ServiceStart(input).catch((error) => {
    if (error?.statusCode >= 400 && error.statusCode < 500) error.data = { dispatched: false };
    throw error;
  });
});

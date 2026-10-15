import { previewDeviceInstall } from '../../utils/device-installation';
import { assertInstallationOrigin } from '../../utils/installation-origin';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const body = await readBody(event);
  if (body?.refresh !== undefined && typeof body.refresh !== 'boolean')
    throw createError({ statusCode: 400, message: 'Неверный режим обновления устройств' });
  return previewDeviceInstall(body, undefined, body?.refresh === true);
});

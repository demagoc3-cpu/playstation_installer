import { assertInstallationOrigin } from '../../../utils/installation-origin';
import { listSaveBackups } from '../../../utils/save-backup-store';
import { pendingSaveRestores } from '../../../utils/save-restore-store';
import { ps4ManagementIp } from '../../../utils/console-management-target';

export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const body = await readBody(event);
  const ip = ps4ManagementIp(body?.ip);
  if (
    !ip ||
    typeof body?.userId !== 'string' ||
    !/^[0-9a-f]{8}$/i.test(body.userId) ||
    typeof body?.titleId !== 'string' ||
    !/^[A-Z0-9]{9}$/.test(body.titleId)
  )
    throw createError({ statusCode: 400, message: 'Неверная игра или профиль PS4' });
  return {
    backups: listSaveBackups(body.userId, body.titleId, ip),
    unassignedBackups: listSaveBackups(body.userId, body.titleId, null),
    restores: pendingSaveRestores(ip, body.userId, body.titleId),
  };
});

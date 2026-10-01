import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { listSaveBackups } from '../../../utils/save-backup-store'
import { pendingSaveRestores } from '../../../utils/save-restore-store'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  if (typeof body?.userId !== 'string' || !/^[0-9a-f]{8}$/i.test(body.userId) ||
      typeof body?.titleId !== 'string' || !/^[A-Z0-9]{9}$/.test(body.titleId))
    throw createError({ statusCode: 400, message: 'Неверная игра или профиль PS4' })
  return { backups: listSaveBackups(body.userId, body.titleId),
    restores: typeof body?.ip === 'string' ? pendingSaveRestores(body.ip, body.userId, body.titleId) : [] }
})

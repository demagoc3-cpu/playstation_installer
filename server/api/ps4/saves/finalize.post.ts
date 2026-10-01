import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { authenticatedServiceRequest } from '../../../utils/ps4-service-installer'
import { readSaveRestore, writeSaveRestore } from '../../../utils/save-restore-store'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const record = readSaveRestore(body?.id)
  if (body?.ip !== record.ip || record.state !== 'pending')
    throw createError({ statusCode: 409, message: 'Это восстановление уже закрыто или относится к другой PS4' })
  const result = await authenticatedServiceRequest(record.ip, '/saves/restore/finalize', 'POST',
    { id: record.rollbackId, userId: record.userId, titleId: record.titleId, slot: record.slot }) as { finalized?: boolean }
  if (result?.finalized !== true) throw createError({ statusCode: 502, message: 'PS4 не подтвердила завершение восстановления' })
  writeSaveRestore({ ...record, state: 'accepted' })
  return { accepted: true }
})

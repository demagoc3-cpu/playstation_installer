import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { consoleRuntime } from '../../../utils/console-control'
import { createSaveBackup } from '../../../utils/ps4-saves'
import { authenticatedServiceRequest } from '../../../utils/ps4-service-installer'
import { readSaveBackup } from '../../../utils/save-backup-store'
import { readSaveRestore, writeSaveRestore } from '../../../utils/save-restore-store'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const record = readSaveRestore(body?.id)
  if (body?.ip !== record.ip || !['pending', 'uncertain'].includes(record.state))
    throw createError({ statusCode: 409, message: 'Это восстановление уже закрыто или относится к другой PS4' })
  if ((await consoleRuntime(record.ip, record.titleId)).running)
    throw createError({ statusCode: 409, message: 'Закройте игру перед возвратом предыдущего сейва' })
  const safety = readSaveBackup(record.safetyBackupId, true).manifest.files
    .filter(file => !file.path.startsWith('sce_sys/')).sort((a, b) => a.path.localeCompare(b.path))
  const request = { id: record.rollbackId, userId: record.userId, titleId: record.titleId, slot: record.slot }
  const result = await authenticatedServiceRequest(record.ip, '/saves/restore/rollback', 'POST', request) as { rolledBack?: boolean }
  if (result?.rolledBack !== true) throw createError({ statusCode: 502, message: 'PS4 не подтвердила откат сейва' })
  writeSaveRestore({ ...record, state: 'uncertain' })
  try {
    const verified = await createSaveBackup(record.ip, record.userId, record.titleId, record.slot, true)
    const actual = readSaveBackup(verified.id, true).manifest.files
      .filter(file => !file.path.startsWith('sce_sys/')).sort((a, b) => a.path.localeCompare(b.path))
    if (actual.length !== safety.length || actual.some((file, index) => file.path !== safety[index]?.path || file.sha256 !== safety[index]?.sha256))
      throw new Error('Save checksum changed')
    await authenticatedServiceRequest(record.ip, '/saves/restore/finalize', 'POST', request)
    writeSaveRestore({ ...record, state: 'rolledBack' })
    return { rolledBack: true, verifiedBackupId: verified.id }
  } catch {
    writeSaveRestore({ ...record, state: 'uncertain' })
    throw createError({ statusCode: 503, message: 'PS4 выполнила откат, но проверка результата не завершилась. Не запускайте игру до повторной проверки.' })
  }
})

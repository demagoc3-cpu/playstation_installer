import { createError } from 'h3'
import { readPs4Service } from './ps4-service'
import { authenticatedServiceRequest } from './ps4-service-installer'
import { comparePkgVersions } from './service-updates'
import { restoreSaveBackup } from './ps4-saves'
import { readSaveBackup } from './save-backup-store'
import { pendingSaveRestores, writeSaveRestore } from './save-restore-store'

const active = new Set<string>()

export async function startSaveRestore(ip: string, id: unknown) {
  const info = await readPs4Service(ip, '/system/info')
  const version = (info.body as { pkgVersion?: string } | null)?.pkgVersion
  if (info.status !== 200 || !version || comparePkgVersions(version, '1.37') < 0)
    throw createError({ statusCode: 503, message: 'Для безопасной записи сохранения требуется служба 1.37' })
  const source = readSaveBackup(id)
  const key = `${ip}:${source.manifest.userId}:${source.manifest.titleId}:${source.manifest.slot}`
  if (active.has(key)) throw createError({ statusCode: 409, message: 'Восстановление этого слота уже выполняется' })
  active.add(key)
  try {
    if (pendingSaveRestores(ip, source.manifest.userId, source.manifest.titleId).some(item => item.slot === source.manifest.slot))
      throw createError({ statusCode: 409, message: 'Сначала подтвердите или откатите предыдущее восстановление этого слота' })
    const result = await restoreSaveBackup(ip, id)
    const record = { rollbackId: result.rollbackId, ip, userId: result.userId, titleId: result.titleId, slot: result.slot,
      sourceBackupId: result.sourceBackupId, safetyBackupId: result.safetyBackupId, verifiedBackupId: result.verifiedBackupId,
      createdAt: new Date().toISOString(), state: 'pending' as const }
    try { writeSaveRestore(record) }
    catch {
      const request = { id: result.rollbackId, userId: result.userId, titleId: result.titleId, slot: result.slot }
      try {
        const rolled = await authenticatedServiceRequest(ip, '/saves/restore/rollback', 'POST', request) as { rolledBack?: boolean }
        if (rolled?.rolledBack !== true) throw new Error('Rollback not confirmed')
        await authenticatedServiceRequest(ip, '/saves/restore/finalize', 'POST', request).catch(() => {})
      } catch { throw createError({ statusCode: 503, message: `Не удалось записать журнал восстановления и подтвердить откат. Код отката: ${result.rollbackId}` }) }
      throw createError({ statusCode: 503, message: 'Журнал восстановления не записан; PS4 вернула исходный сейв' })
    }
    return { ...result, record }
  } finally { active.delete(key) }
}

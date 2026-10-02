import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { fileCapabilities, fileIp, startFileJob, resumeFileJob, pauseFileJob } from '../../../utils/console-files'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event), ip = fileIp(body?.ip)
  const cap = await fileCapabilities(ip) as { fileApi: number; permanentDelete?: boolean }
  if (cap.fileApi !== 2) throw createError({ statusCode: 409, message: 'Для новых операций обновите PackageFlowService до PKG 1.52' })
  if (['delete', 'purge'].includes(body?.action) && cap.permanentDelete !== true) throw createError({ statusCode: 409, message: 'Для удаления обновите PackageFlowService до PKG 1.55' })
  if (body?.action === 'pause') return pauseFileJob(ip, body.id)
  return body?.action === 'resume' ? resumeFileJob(ip, body.id) : startFileJob(ip, body)
})

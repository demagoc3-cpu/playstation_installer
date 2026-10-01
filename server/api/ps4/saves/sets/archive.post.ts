import { createReadStream } from 'node:fs'
import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { ensureSaveSetArchive } from '../../../../utils/save-set-store'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const result = await ensureSaveSetArchive(body?.id)
  setHeader(event, 'Content-Type', 'application/zip')
  setHeader(event, 'Content-Length', result.size)
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Content-Disposition', `attachment; filename="PackageFlow-saves-${result.set.id}.zip"; filename*=UTF-8''${encodeURIComponent(result.set.name)}-${result.set.id}.zip`)
  return sendStream(event, createReadStream(result.path))
})

import { createReadStream } from 'node:fs'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { ensureSaveArchive } from '../../../utils/save-backup-store'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const { archivePath, manifest, size } = await ensureSaveArchive(body?.id)
  setHeader(event, 'Content-Type', 'application/zip')
  setHeader(event, 'Content-Length', size)
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Content-Disposition', `attachment; filename="${manifest.titleId}-${manifest.slot}-${manifest.id}.zip"`)
  return sendStream(event, createReadStream(archivePath))
})

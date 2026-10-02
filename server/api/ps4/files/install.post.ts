import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { previewConsolePackage, installConsolePackage, listConsolePackageInstallations, cancelConsolePackageInstallation } from '../../../utils/console-file-install'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  if (body?.action === 'preview') return previewConsolePackage(body.ip, body.path)
  if (body?.action === 'start') return installConsolePackage(body.ip, body.path, body.revision)
  if (body?.action === 'list') return { jobs: await listConsolePackageInstallations(body.ip) }
  if (body?.action === 'cancel') return cancelConsolePackageInstallation(body.ip, body.id)
  throw createError({ statusCode: 400, message: 'Неизвестная команда установки' })
})

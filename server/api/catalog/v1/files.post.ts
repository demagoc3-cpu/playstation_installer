import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { fileIp, startFileJob, fileJobs, fileCapabilities, readConsoleText, saveConsoleText, userFilePath } from '../../../utils/console-files'
import { consoleFileRequest } from '../../../utils/ps4-service-installer'
import { previewConsolePackage, installConsolePackage, listConsolePackageInstallations, cancelConsolePackageInstallation } from '../../../utils/console-file-install'

// Native UI uses the same workflows, revision checks and durable ledgers as WEB.
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const b = await readBody(event), ip = fileIp(b?.ip)
  setHeader(event, 'Cache-Control', 'no-store')
  if (b.action === 'roots') return consoleFileRequest(ip, 'roots', {})
  if (b.action === 'list') {
    const path = userFilePath(b.path), offset = Number(b.offset ?? 0)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw createError({ statusCode: 400, message: 'Неверная страница папки' })
    const page = await consoleFileRequest(ip, 'list', { path, offset }) as any
    return { ...page, hasMore: Number(page.hasMore), entries: page.entries.filter((e: any) => e.name !== 'web-key') }
  }
  if (b.action === 'read') {
    const file = await readConsoleText(ip, b.path)
    return { ...file, writable: Number(file.writable) }
  }
  if (b.action === 'save') {
    const result = await saveConsoleText(ip, b)
    return 'unchanged' in result ? { unchanged: 1 } : result
  }
  if (b.action === 'preview') {
    const pkg = await previewConsolePackage(ip, b.path)
    return { ...pkg, canInstall: Number(pkg.canInstall) }
  }
  if (b.action === 'install') return installConsolePackage(ip, b.path, b.revision, b.requestId)
  if (b.action === 'cancel-install') return cancelConsolePackageInstallation(ip, b.id)
  if (b.action === 'status') {
    const files = fileJobs(ip).jobs.find(j => j.id === b.id)
    if (files) return { id: files.id, state: files.state, message: files.error, progress: files.state === 'completed' ? 100 : Math.min(99, Math.floor(files.totalBytes ? files.bytes * 100 / files.totalBytes : files.total ? files.done * 100 / files.total : 0)) }
    const install = (await listConsolePackageInstallations(ip)).find(j => j.id === b.id)
    if (!install) return { id: b.id, state: 'unknown', progress: 0, message: 'Проверьте историю операций в WEB. Повторная команда не отправлена.' }
    const j = install.job
    return { id: install.id, state: install.rejected ? 'failed' : j?.state || 'uncertain', message: install.error || '', progress: j?.state === 'installed' ? 100 : Math.min(99, j?.localCopyPercent ?? (j?.totalBytes ? Math.floor(j.downloadedBytes * 100 / j.totalBytes) : 0)) }
  }
  const capabilities = await fileCapabilities(ip) as { fileApi: number; permanentDelete?: boolean }
  if (capabilities.fileApi !== 2 || (b.action === 'delete' && capabilities.permanentDelete !== true))
    throw createError({ statusCode: 409, message: 'Обновите PackageFlowService для файловых операций' })
  return startFileJob(ip, b)
})

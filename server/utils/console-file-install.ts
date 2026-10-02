import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { createError } from 'h3'
import { consoleFileRequest, consoleFileRead, getServiceInstallerStatus, getServiceInstallJob, getActiveServiceInstallJob, cancelServiceInstallJob, submitServiceLocalPackage, uploadServiceInstallIcon } from './ps4-service-installer'
import { readPackageMetadataFromReader } from './package-library'
import { fileIp, userFilePath, fileJobs } from './console-files'
import { assertNoInstallation, assertNoRemoval } from './console-operation-store'
import { assertNoMaintenance } from './maintenance-store'
import { checkPs4Firmware } from './installation-firmware'
import { checkPs4InstallSpace, installSpaceMessage } from './installation-space'
import { readFileInstallations, saveFileInstallations, localInstallActive, assertNoFileInstallation } from './console-file-install-store'
import type { ConsolePackagePreview } from '../../shared/types/console-file-install'
import type { ConsoleFileStat } from '../../shared/types/console-files'
const starting = new Set<string>()
const fail = (message: string, statusCode = 409): never => { throw createError({ statusCode, message }) }
const issue = (cause: any) => cause?.data?.message || cause?.message || 'Нет ответа от PS4'
async function inspect(value: unknown, source: unknown) {
  const ip = fileIp(value), path = userFilePath(source)
  if (!/^\/(?:data\/|user\/data\/|mnt\/usb[0-7]\/)/.test(path) || !/\.pkg$/i.test(path) || path.split('/').some(p => ['PackegeFlowService', 'PackageFlowService'].includes(p))) fail('Выберите PKG в /data, /user/data или на USB', 400)
  const cap = await getServiceInstallerStatus(ip)
  if (!cap.ready) fail(cap.message || 'Нет связи с PackageFlowService на PS4. Проверьте, что консоль и служба запущены', 503)
  if (!('localInstall' in cap) || cap.localInstall !== true) fail('Для установки с диска PS4 обновите PackageFlowService до PKG 1.54')
  const stat = await consoleFileRequest(ip, 'stat', { path }) as ConsoleFileStat
  if (stat.type !== 'file' || stat.size < 0x1000 || !/^[0-9a-f]{16}$/.test(stat.revision)) fail('Выбранный файл не является доступным PKG', 400)
  const read = async (position: number, length: number) => {
    const available = Math.min(length, Math.max(0, stat.size - position))
    return available ? consoleFileRead(ip, path, position, available) : Buffer.alloc(0)
  }
  const header = await read(0, 0x1000)
  if (header.length !== 0x1000 || !header.subarray(0, 4).equals(Buffer.from('7f434e54', 'hex'))) fail('Не удалось прочитать заголовок PKG', 422)
  const declaredSize = header.readBigUInt64BE(0x430)
  // License-only packages may have a zero package size; their data section still covers the file.
  const sizeMatches = declaredSize !== 0n ? declaredSize === BigInt(stat.size)
    : header.readUInt32BE(0x74) === 0x1c && header.readBigUInt64BE(0x20) + header.readBigUInt64BE(0x28) === BigInt(stat.size)
  if (!sizeMatches) fail('PKG повреждён или загружен не полностью: размер не совпадает с заголовком', 422)
  let pkg
  try {
    pkg = await readPackageMetadataFromReader({ stat: async () => ({ size: stat.size }), read: async (buffer, offset, length, position) => { const part = await read(position, length); part.copy(buffer, offset); return { bytesRead: part.length } } }, posix.basename(path))
  } catch (cause) { fail(`Не удалось прочитать сведения PKG: ${issue(cause)}`, 422) }
  if (!['PS4GD', 'PS4GP', 'PS4AC', 'PS4AL'].includes(pkg!.contentType) || !/^[A-Z0-9]{9}$/.test(pkg!.titleId) || /^(?:PFLS|NPXS)/.test(pkg!.titleId)) fail('Этот тип PKG нельзя установить через файловый менеджер', 400)
  const after = await consoleFileRequest(ip, 'stat', { path }) as ConsoleFileStat
  if (after.revision !== stat.revision || after.size !== stat.size) fail('Файл изменился во время проверки. Выберите его снова')
  const [firmware, space] = await Promise.all([checkPs4Firmware(ip, pkg!), checkPs4InstallSpace(ip, stat.size)])
  const preview: ConsolePackagePreview = { path, revision: stat.revision, size: stat.size, title: pkg!.title, titleId: pkg!.titleId, contentId: pkg!.contentId, contentType: pkg!.contentType, type: pkg!.type, appVersion: pkg!.appVersion,
    requiredFirmware: pkg!.requiredFirmware, sdkFirmware: pkg!.sdkFirmware, compatible: firmware.state === 'compatible', firmwareMessage: firmware.detail, spaceMessage: installSpaceMessage(space), canInstall: firmware.state === 'compatible' && space.state === 'enough' }
  return { ip, preview, pkg: pkg!, read }
}
export async function previewConsolePackage(ip: unknown, path: unknown) { return (await inspect(ip, path)).preview }
export async function listConsolePackageInstallations(value: unknown) {
  const ip = fileIp(value), records = readFileInstallations(), updates = []
  for (const record of records.filter(j => j.ip === ip && localInstallActive(j))) {
    try { const job = await getServiceInstallJob(ip, record.id); updates.push({ id: record.id, job, pending: false, error: '' }) }
    catch (cause: any) {
      const absent = cause.statusCode === 404 && record.pending && !record.job
      updates.push({ id: record.id, error: absent ? record.error || 'PS4 не зарегистрировала новую установку. Можно повторить команду' : issue(cause), ...(absent ? { pending: false, rejected: true } : {}) })
    }
  }
  // Read again after network calls so simultaneous submissions are preserved.
  const current = readFileInstallations()
  for (const update of updates) { const record = current.find(j => j.ip === ip && j.id === update.id); if (record) Object.assign(record, update) }
  if (updates.length) saveFileInstallations(current)
  return current.filter(j => j.ip === ip).reverse()
}
export async function installConsolePackage(value: unknown, path: unknown, revision: unknown) {
  const ip = fileIp(value)
  if (starting.has(ip)) fail('Установка уже подготавливается')
  starting.add(ip)
  try {
    await listConsolePackageInstallations(ip)
    assertNoMaintenance(ip); assertNoInstallation(ip); assertNoRemoval(ip); assertNoFileInstallation(ip)
    if (fileJobs(ip).jobs.some(j => ['planning', 'running'].includes(j.state))) fail('Дождитесь файловой операции')
    const inspected = await inspect(ip, path), p = inspected.preview
    if (p.revision !== revision) fail('PKG изменился после выбора. Откройте сведения снова')
    if (!p.canInstall) fail(!p.compatible ? p.firmwareMessage : p.spaceMessage)
    if (await getActiveServiceInstallJob(ip)) fail('На PS4 уже выполняется установка. Дождитесь её завершения')
    const id = randomUUID()
    if (inspected.pkg.icon.size) {
      const chunks = []
      for (let offset = 0; offset < inspected.pkg.icon.size; offset += 256 * 1024) chunks.push(await inspected.read(inspected.pkg.icon.offset + offset, Math.min(256 * 1024, inspected.pkg.icon.size - offset)))
      await uploadServiceInstallIcon(ip, p.titleId, id, Buffer.concat(chunks))
    }
    // Recheck conflicts after metadata/icon reads, before durable intent.
    assertNoMaintenance(ip); assertNoInstallation(ip); assertNoRemoval(ip); assertNoFileInstallation(ip)
    const record = { id, ip, path: p.path, title: p.title, createdAt: new Date().toISOString(), pending: true }
    const records = readFileInstallations().filter(j => localInstallActive(j) || Date.now() - Date.parse(j.createdAt) < 30 * 86400000)
    records.push(record); saveFileInstallations(records)
    try {
      const job = await submitServiceLocalPackage(ip, { requestId: id, contentId: p.contentId, titleId: p.titleId, title: p.title, url: p.path, contentType: p.contentType, size: p.size, revision: p.revision })
      const latest = readFileInstallations(), saved = latest.find(j => j.id === id)!
      Object.assign(saved, { job, pending: false }); saveFileInstallations(latest); return saved
    } catch (cause: any) {
      const latest = readFileInstallations(), saved = latest.find(j => j.id === id)!
      saved.error = issue(cause)
      // An explicit rejection has no native task; a lost response remains pending.
      // A structured native rejection means registration did not start, even
      // if an older service incorrectly maps its 422 response to HTTP 500.
      if (cause.data?.serviceError) { Object.assign(saved, { pending: false, rejected: true }); saveFileInstallations(latest); return saved }
      if (cause.statusCode && cause.statusCode < 500) { latest.splice(latest.indexOf(saved), 1); saveFileInstallations(latest); throw cause }
      saveFileInstallations(latest); return saved
    }
  } finally { starting.delete(ip) }
}
export async function cancelConsolePackageInstallation(value: unknown, id: unknown) {
  const ip = fileIp(value), record = readFileInstallations().find(j => j.ip === ip && j.id === id)
  if (!record) fail('Задание не найдено', 404)
  const job = await cancelServiceInstallJob(ip, record.id), latest = readFileInstallations(), saved = latest.find(j => j.ip === ip && j.id === id)!
  Object.assign(saved, { job, pending: false, error: '' }); saveFileInstallations(latest); return saved
}

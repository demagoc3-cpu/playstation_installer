import { assessContentFirmware, type FirmwareAssessment } from '../../shared/installation-firmware'
import { contentFormat } from '../../shared/content-platform'
import { readPs5FolderParam, readPs5ImageMetadata } from './ps5-content-metadata'
import { getConsoleProfile, ps5ServiceRequest } from './console-profiles'
import type { LocalPackage } from './package-library'

/** Small bounded PARAM reads, never a full folder scan or a second hash pass.
 * Read the selected source instead of trusting a possibly outdated index. */
export async function assessPs5SourceFirmware(consoleVersion: string | undefined, source: LocalPackage & { path: string }): Promise<FirmwareAssessment> {
  let metadata
  try {
    metadata = contentFormat(source) === 'folder' ? await readPs5FolderParam(source.path) : await readPs5ImageMetadata(source.path, false)
  } catch {
    return { state: 'unverified', detail: 'Не удалось прочитать PARAM выбранного файла PS5. Установка не отправлена; проверьте источник и пересканируйте библиотеку' }
  }
  if (metadata.titleId !== source.titleId || metadata.contentId !== source.contentId || metadata.appVersion !== source.appVersion)
    return { state: 'unverified', detail: 'PARAM источника изменился после сканирования. Установка не отправлена; пересканируйте библиотеку' }
  return assessContentFirmware(consoleVersion, metadata, 'ps5')
}

/** A stored profile is not evidence of the currently connected console's FW. */
export async function checkPs5SourceFirmware(consoleId: string, source: LocalPackage & { path: string }, signal: AbortSignal) {
  signal.throwIfAborted()
  let version: string | undefined
  try {
    const response = await ps5ServiceRequest(getConsoleProfile(consoleId).ip, '/health'), body = response.body
    const raw = /^0x(\d{2})(\d{2})[0-9a-f]{4}$/i.exec(body?.firmwareRaw || '')
    if (response.status === 200 && body?.apiVersion === 'v1' && body.serviceReport?.service === 'PackageFlowService-PS5' && body.serviceReport.consoleVerified === true && (!body.serviceReport.platform || body.serviceReport.platform === 'ps5') && body.firmwareRead === true && raw)
      version = `${Number(raw[1])}.${raw[2]}`
  } catch { signal.throwIfAborted() }
  signal.throwIfAborted()
  if (!version) return { state: 'unavailable' as const, detail: 'Не удалось узнать текущую прошивку PS5; ждём ответа службы. Передача не началась' }
  const assessment = await assessPs5SourceFirmware(version, source)
  signal.throwIfAborted()
  return assessment
}

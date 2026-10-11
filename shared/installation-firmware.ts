import type { ContentPlatform } from './types/consoles'

export interface FirmwareMetadata {
  contentType: string
  requiredFirmware?: string
  sdkFirmware?: string
}
export type FirmwareAssessment = { state: 'compatible' | 'incompatible' | 'unverified' | 'unavailable'; detail: string }

export function firmwareNumber(value?: string) {
  const match = /^(\d{1,2})\.(\d{2})$/.exec(value || '')
  return match ? Number(match[1]) * 100 + Number(match[2]) : undefined
}

/** Compare versions within one platform only. Title IDs and release names
 * never certify compatibility, and SDK is independent of the PARAM minimum. */
export function assessContentFirmware(consoleVersion: string | undefined, pkg: FirmwareMetadata, platform: ContentPlatform): FirmwareAssessment {
  const consoleName = platform === 'ps5' ? 'PS5' : 'PS4'
  const installed = firmwareNumber(consoleVersion)
  if (installed === undefined) return { state: 'unavailable', detail: `Версия прошивки ${consoleName} не определена; ждём данные службы` }
  const required = firmwareNumber(pkg.requiredFirmware), sdk = firmwareNumber(pkg.sdkFirmware)
  const tooNew = [required !== undefined && required > installed ? `${platform === 'ps5' ? 'PARAM' : 'SYSTEM_VER'} ${pkg.requiredFirmware}` : '', sdk !== undefined && sdk > installed ? `SDK ${pkg.sdkFirmware}` : ''].filter(Boolean)
  if (tooNew.length) return { state: 'incompatible', detail: `Пропущен: ${tooNew.join(' и ')} выше прошивки ${consoleName} ${consoleVersion}` }
  if (required === undefined && sdk === undefined) {
    if (platform === 'ps4' && ['PS4AC', 'PS4AL'].includes(pkg.contentType)) return { state: 'compatible', detail: `DLC не задаёт собственную прошивку; PS4 ${consoleVersion} проверит совместимость с игрой` }
    return { state: 'unverified', detail: `Пропущен: в PARAM нет читаемых требований прошивки и SDK; совместимость с ${consoleName} не подтверждена` }
  }
  return { state: 'compatible', detail: `Проверка прошивки пройдена: ${consoleName} ${consoleVersion}, ${[required !== undefined && `PARAM ${pkg.requiredFirmware}`, sdk !== undefined && `SDK ${pkg.sdkFirmware}`].filter(Boolean).join(', ')}` }
}

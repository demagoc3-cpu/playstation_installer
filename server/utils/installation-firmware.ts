import { readPs4Service } from './ps4-service'

export interface PackageFirmware {
  contentType: string
  requiredFirmware?: string
  sdkFirmware?: string
}

export type FirmwareAssessment =
  | { state: 'compatible' | 'incompatible' | 'unverified'; detail: string }
  | { state: 'unavailable'; detail: string }

function versionParts(value: string | undefined): [number, number] | null {
  const match = /^(\d{1,2})\.(\d{2})$/.exec(value || '')
  return match ? [Number(match[1]), Number(match[2])] : null
}

function newer(required: string, consoleVersion: string) {
  const requested = versionParts(required)!
  const installed = versionParts(consoleVersion)!
  return requested[0] > installed[0] || requested[0] === installed[0] && requested[1] > installed[1]
}

/** SYSTEM_VER and SDK_VER are independent checks. A backport may lower only one. */
export function assessPackageFirmware(consoleVersion: string, pkg: PackageFirmware): FirmwareAssessment {
  if (!versionParts(consoleVersion)) return { state: 'unavailable', detail: 'Версия прошивки PS4 не определена; ждём данные службы' }
  const required = versionParts(pkg.requiredFirmware) ? pkg.requiredFirmware : undefined
  const sdk = versionParts(pkg.sdkFirmware) ? pkg.sdkFirmware : undefined
  const tooNew = [required && newer(required, consoleVersion) ? `SYSTEM_VER ${required}` : '', sdk && newer(sdk, consoleVersion) ? `SDK ${sdk}` : ''].filter(Boolean)
  if (tooNew.length) return { state: 'incompatible', detail: `Пропущен: ${tooNew.join(' и ')} выше прошивки PS4 ${consoleVersion}` }
  if (!required && !sdk && !['PS4AC', 'PS4AL'].includes(pkg.contentType))
    return { state: 'unverified', detail: 'Пропущен: в PKG нет читаемых SYSTEM_VER и SDK_VER; совместимость с прошивкой не подтверждена' }
  if (!required && !sdk) return { state: 'compatible', detail: `DLC не задаёт собственную прошивку; PS4 ${consoleVersion} проверит совместимость с игрой` }
  return { state: 'compatible', detail: `Проверка прошивки пройдена: PS4 ${consoleVersion}, PKG ${[required && `SYSTEM_VER ${required}`, sdk && `SDK ${sdk}`].filter(Boolean).join(', ')}` }
}

export async function checkPs4Firmware(ip: string, pkg: PackageFirmware,
  read: typeof readPs4Service = readPs4Service): Promise<FirmwareAssessment> {
  try {
    const reply = await read(ip, '/system/info')
    const body = reply.body as { service?: unknown; firmware?: { version?: unknown } } | null
    const version = body?.firmware?.version
    if (reply.status !== 200 || body?.service !== 'PackegeFlowService' || typeof version !== 'string')
      return { state: 'unavailable', detail: 'Не удалось узнать прошивку PS4; ждём ответа службы' }
    return assessPackageFirmware(version, pkg)
  } catch {
    return { state: 'unavailable', detail: 'Служба PS4 недоступна для проверки прошивки; ждём подключения' }
  }
}

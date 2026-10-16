import { readPs4Service } from './ps4-service';
import {
  assessContentFirmware,
  type FirmwareMetadata,
  type FirmwareAssessment,
} from '../../shared/installation-firmware';
export type { FirmwareAssessment } from '../../shared/installation-firmware';

export type PackageFirmware = FirmwareMetadata;

/** SYSTEM_VER and SDK_VER are independent checks. A backport may lower only one. */
export function assessPackageFirmware(
  consoleVersion: string,
  pkg: PackageFirmware,
): FirmwareAssessment {
  return assessContentFirmware(consoleVersion, pkg, 'ps4');
}

export async function checkPs4Firmware(
  ip: string,
  pkg: PackageFirmware,
  read: typeof readPs4Service = readPs4Service,
): Promise<FirmwareAssessment> {
  try {
    const reply = await read(ip, '/system/info');
    const body = reply.body as { service?: unknown; firmware?: { version?: unknown } } | null;
    const version = body?.firmware?.version;
    if (
      reply.status !== 200 ||
      body?.service !== 'PackegeFlowService' ||
      typeof version !== 'string'
    )
      return { state: 'unavailable', detail: 'Не удалось узнать прошивку PS4; ждём ответа службы' };
    return assessPackageFirmware(version, pkg);
  } catch {
    return {
      state: 'unavailable',
      detail: 'Служба PS4 недоступна для проверки прошивки; ждём подключения',
    };
  }
}

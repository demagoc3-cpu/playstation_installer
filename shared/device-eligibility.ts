import {
  contentForConsole,
  contentFormat,
  contentPlatform,
  type ContentIdentity,
} from './content-platform';
import type { ConsoleProfile } from './types/consoles';
import { ps5PkgInstallMessage } from './ps5-install-readiness';
import { assessContentFirmware } from './installation-firmware';

export function installationSpaceSupported(
  profile: Pick<ConsoleProfile, 'platform' | 'transport'>,
) {
  return !(profile.platform === 'ps4' && profile.transport === 'payload');
}

/** Admission is an installation intent, not proof that the backend has started.
 * The existing worker checks live PKG readiness before reading or sending data. */
export function ps5PkgQueueSupported(
  profile: Pick<ConsoleProfile, 'platform' | 'verified' | 'firmware' | 'capabilities'>,
  item: ContentIdentity,
) {
  return (
    profile.platform === 'ps5' &&
    profile.verified &&
    profile.firmware === '13.60' &&
    profile.capabilities.installation?.reason === 'installer_unavailable' &&
    contentFormat(item) === 'pkg' &&
    contentForConsole(item, 'ps5')
  );
}

/** Validate the entire selection. Compatibility is never inferred from filenames. */
export function deviceInstallReason(
  profile: ConsoleProfile,
  items: Array<
    ContentIdentity & {
      size: number;
      requiredFirmware?: string;
      sdkFirmware?: string;
      installOrder?: number;
    }
  >,
  requiredBytes: number,
  verifyPs4Pkg = true,
) {
  if (!items.length) return 'Нет файлов для установки';
  if (items.some((item) => !contentForConsole(item, profile.platform)))
    return 'В наборе есть игры для другой платформы';
  if (!profile.online) return 'Нет связи с приставкой';
  if (profile.transport !== 'payload' && !profile.paired) return 'Требуется сопряжение';
  if (
    items.some(
      (item) =>
        contentFormat(item) !== 'pkg' &&
        !(
          profile.platform === 'ps5' &&
          contentPlatform(item) === 'ps5' &&
          ['folder', 'ufs2', 'exfat', 'pfs', 'ffpfsc'].includes(contentFormat(item)) &&
          profile.capabilities.formats.includes(contentFormat(item)) &&
          (contentFormat(item) === 'folder' || profile.capabilities.images?.ready === true)
        ),
    )
  )
    return 'Установка этого формата ещё не подтверждена сервисом';
  if (
    items.some(
      (item) =>
        ['ufs2', 'exfat', 'pfs', 'ffpfsc'].includes(contentFormat(item)) &&
        item.installOrder !== undefined &&
        item.installOrder !== 0,
    )
  )
    return 'Образы PS5 поддерживаются только для базовых игр. Набор не отправлен';
  if (
    profile.platform === 'ps5' &&
    profile.capabilities.installation?.ready === false &&
    items.some((item) => contentFormat(item) === 'pkg' && !ps5PkgQueueSupported(profile, item))
  )
    return ps5PkgInstallMessage(profile.capabilities);
  if (
    profile.transport !== 'payload' &&
    items.some(
      (item) =>
        !ps5PkgQueueSupported(profile, item) &&
        (!profile.capabilities.formats.includes(contentFormat(item)) ||
          !(contentPlatform(item) === 'ps4'
            ? profile.capabilities.installPs4
            : profile.capabilities.installPs5)),
    )
  )
    return 'Сервис ещё не поддерживает установку выбранных файлов';
  if (
    profile.platform === 'ps4' &&
    profile.transport !== 'payload' &&
    items.some(
      (item) => !['PS4GD', 'PS4GP', 'PS4AC', 'PS4AL', 'PS4GDE'].includes(item.contentType || ''),
    )
  )
    return 'Тип пакета не поддерживается сервисом PS4';
  if (
    profile.platform === 'ps4' &&
    profile.transport !== 'payload' &&
    profile.capabilities.contentTypes &&
    items.some((item) => !profile.capabilities.contentTypes!.includes(item.contentType || ''))
  )
    return 'Обновите сервис PS4 для установки выбранного типа пакета';
  // PS4 compatibility-mode requirements use a different version scale from PS5.
  for (const item of items.filter((item) => contentPlatform(item) === profile.platform)) {
    if (profile.platform === 'ps4' && !verifyPs4Pkg) continue;
    const assessment = assessContentFirmware(
      profile.firmware,
      { ...item, contentType: item.contentType || '' },
      profile.platform,
    );
    if (assessment.state === 'incompatible') return assessment.detail;
    if (profile.platform === 'ps5' && assessment.state === 'unavailable') return assessment.detail;
  }
  if (
    installationSpaceSupported(profile) &&
    profile.freeBytes !== undefined &&
    profile.freeBytes < requiredBytes
  )
    return 'Недостаточно свободного места';
  return '';
}

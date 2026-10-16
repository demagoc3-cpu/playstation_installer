import { normalizeNativeInstallReview } from './native-task-contract';
import { createHash } from 'node:crypto';
import { createError } from 'h3';
import { consoleProfileForIp, getConsoleProfile } from './console-profiles';
import { getLibraryPackages } from './package-library';
import { consoleSelection } from './console-app-data';
import { resolveConsoleFavorites } from './console-catalog';
import { filterContent, contentBranchKey, contentForConsole } from '../../shared/content-platform';
import { inConsoleScope } from './console-scope';
import { presetSelection, resolvePreset, getPreset } from './presets';
import { previewDeviceInstall, installDeviceBatch } from './device-installation';

export const nativeInstallReviewCapability = () => ({
  version: 1,
  previewPath: 'install-preview',
  submitAction: 'install-reviewed',
});
export function nativeReviewProfile(body: any, platform: 'ps4' | 'ps5') {
  const profile =
    platform === 'ps4' ? consoleProfileForIp(body?.ip) : getConsoleProfile(body?.consoleId);
  if (
    !profile ||
    profile.platform !== platform ||
    (platform === 'ps4' && body.consoleId !== undefined && profile.id !== body.consoleId)
  )
    throw createError({
      statusCode: 409,
      message: 'Профиль приставки изменился. Обновите подключение и проверку установки',
    });
  return profile;
}
function selection(body: any, platform: 'ps4' | 'ps5') {
  const profile = nativeReviewProfile(body, platform);
  if (
    !['all', 'selected', 'patches', 'dlc', 'install-preset', 'install-favorites'].includes(
      body?.action,
    ) ||
    typeof body.gameId !== 'string'
  )
    throw createError({ statusCode: 400, message: 'Выберите действие и набор для проверки' });
  const library = getLibraryPackages(profile.ip).filter((pkg) => contentForConsole(pkg, platform));
  let packages: typeof library;
  if (body.action === 'install-preset')
    packages = inConsoleScope(profile.ip, () => presetSelection(body.presetId || body.gameId));
  else if (body.action === 'install-favorites') {
    if (
      !Array.isArray(body.favoriteIds) ||
      !body.favoriteIds.length ||
      body.favoriteIds.length > 1024 ||
      body.favoriteIds.some(
        (id: unknown) => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id),
      )
    )
      throw createError({ statusCode: 400, message: 'Некорректное избранное' });
    if (platform === 'ps4') {
      const { groups } = resolveConsoleFavorites(filterContent(library, 'ps4'), body.favoriteIds);
      packages = library.filter((pkg) => groups.has(pkg.titleId || pkg.id));
    } else {
      const branches = body.favoriteIds.map((id: string) => {
        const pkg = library.find(
          (pkg) =>
            contentBranchKey(pkg) === id ||
            pkg.id === id ||
            pkg.titleId === id ||
            pkg.sourceIds?.includes(id),
        );
        if (!pkg)
          throw createError({
            statusCode: 409,
            message: 'Избранная игра больше не доступна. Обновите библиотеку',
          });
        return contentBranchKey(pkg);
      });
      packages = library.filter((pkg) => branches.includes(contentBranchKey(pkg)));
    }
  } else {
    if (
      body.packageIds !== undefined &&
      (!Array.isArray(body.packageIds) ||
        body.packageIds.length > 10000 ||
        body.packageIds.some(
          (id: unknown) => typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id),
        ))
    )
      throw createError({ statusCode: 400, message: 'Некорректный выбор пакетов' });
    const available = body.presetId
      ? inConsoleScope(profile.ip, () => resolvePreset(getPreset(body.presetId))).flatMap(
          (entry) => (entry.pkg ? [entry.pkg] : []),
        )
      : library;
    if (platform === 'ps4')
      packages = consoleSelection(available, body.gameId, body.action, body.packageIds);
    else {
      const branch = available.filter((pkg) => contentBranchKey(pkg) === body.gameId);
      if (
        !branch.length ||
        (body.action === 'selected' &&
          (!body.packageIds?.length ||
            body.packageIds.some((id: string) => !branch.some((pkg) => pkg.id === id))))
      )
        throw createError({ statusCode: 409, message: 'Выбранные пакеты больше не входят в игру' });
      packages = branch.filter((pkg) =>
        body.action === 'selected'
          ? body.packageIds.includes(pkg.id)
          : body.action === 'patches'
            ? pkg.installOrder === 1
            : body.action === 'dlc'
              ? pkg.type === 'DLC'
              : true,
      );
    }
  }
  if (!packages.length || packages.some((pkg) => !contentForConsole(pkg, platform)))
    throw createError({
      statusCode: 409,
      message: 'Выбранный набор не поддерживается этой приставкой',
    });
  return { profile, packageIds: [...new Set(packages.map((pkg) => pkg.id))].sort() };
}

/** Read-only preflight; no installation command or maintenance worker is started. */
export async function previewNativeInstall(body: any, platform: 'ps4' | 'ps5') {
  const { profile, packageIds } = selection(body, platform);
  const preview = await previewDeviceInstall({ packageIds }, [profile.id]);
  const device = preview.devices.find((device) => device.profile.id === profile.id);
  if (!device) throw createError({ statusCode: 409, message: 'Приставка больше не доступна' });
  const { profile: current, ...review } = device;
  return {
    schemaVersion: platform === 'ps4' ? 1 : 2,
    consoleId: profile.id,
    consolePlatform: platform,
    selection: preview.selection,
    files: preview.files,
    size: preview.size,
    packages: preview.packages,
    device: {
      ...review,
      consoleId: current.id,
      name: current.name,
      ip: current.ip,
      platform: current.platform,
      online: current.online,
      paired: current.paired,
      firmware: current.firmware,
      freeBytes: current.freeBytes,
    },
  };
}

export async function submitNativeInstallReview(body: any, platform: 'ps4' | 'ps5', host: string) {
  const confirmed = normalizeNativeInstallReview(body),
    profile = nativeReviewProfile(body, platform);
  // Each native receipt owns a distinct internal batch, including its destination.
  const id = createHash('sha256')
    .update(JSON.stringify(['native-review-v1', platform, profile.id, body.requestId]))
    .digest('hex')
    .slice(0, 32);
  const result = await installDeviceBatch(
    id,
    { packageIds: confirmed.packageIds },
    [profile.id],
    host,
    { [profile.id]: confirmed.overwritePackageIds },
    { [profile.id]: confirmed.reviewToken },
  );
  const receipt = result.results.find((item) => item.consoleId === profile.id);
  if (!receipt)
    throw createError({
      statusCode: 502,
      message: 'WEB не вернул результат для выбранной приставки',
    });
  return receipt;
}

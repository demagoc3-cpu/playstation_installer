import type { ConsoleCapabilities } from './types/consoles';

export const ps5InstallReasons: Record<string, string> = {
  installer_unavailable: 'Установщик PS5 не запущен или недоступен',
  unrecognized_installer: 'Обновите установщик PS5 до согласованной версии',
  initialization_failed: 'Установщик PS5 не готов: системная инициализация не завершилась',
  embedded_backend_not_verified: 'Встроенная установка PKG ещё не проверена на этой PS5',
  unsupported_firmware: 'Этот маршрут установки ещё не проверен на данной прошивке PS5',
  readiness_unavailable: 'Не удалось проверить готовность установки PS5',
  service_update_required: 'Обновите службу PS5 для проверки готовности установки',
};

/** The service admits a specific tested route. No image support is inferred
 * from a package installer or from the console being paired. Firmware does not
 * gate it: the running service reports what it can do on its own firmware. */
export function ps5InstallCapabilities(
  status: number,
  body: any,
  _firmware?: string,
): ConsoleCapabilities {
  let reason = status === 404 ? 'service_update_required' : 'readiness_unavailable';
  let platforms: string[] = [];
  if (
    status === 200 &&
    body?.service === 'PackageFlowService-PS5' &&
    body.schemaVersion === 1 &&
    body.route === 'staged-pkg' &&
    body.exactVersionReceipt === false
  ) {
    if (
      body.ready === false &&
      Object.hasOwn(ps5InstallReasons, body.reason) &&
      Array.isArray(body.formats) &&
      !body.formats.length &&
      Array.isArray(body.platforms) &&
      !body.platforms.length
    )
      reason = body.reason;
    else if (
      body.ready === true &&
      body.reason === 'ready' &&
      Array.isArray(body.formats) &&
      body.formats.length === 1 &&
      body.formats[0] === 'pkg' &&
      // The service reports what it installs on its own firmware.
      ['["ps4"]', '["ps5"]', '["ps4","ps5"]'].includes(JSON.stringify(body.platforms))
    ) {
      reason = 'ready';
      platforms = body.platforms;
    }
  }
  const ready = reason === 'ready';
  const folder =
    status === 200 &&
    body?.service === 'PackageFlowService-PS5' &&
    body.schemaVersion === 1 &&
    body.folder?.schemaVersion === 1 &&
    body.folder.route === 'staged-folder' &&
    body.folder.ready === true &&
    JSON.stringify(body.folder.platforms) === '["ps5"]';
  const images =
    status === 200 &&
    body?.service === 'PackageFlowService-PS5' &&
    body.schemaVersion === 1 &&
    body.images?.schemaVersion === 1 &&
    body.images.route === 'staged-image' &&
    body.images.ready === true &&
    body.images.reason === 'ready' &&
    body.images.protocol === 'image-registration-v1' &&
    // The service checks the ShadowMount API it talks to; any version it accepts.
    /^ShadowMountPlus-[A-Za-z0-9._-]{1,32}$/.test(body.images.backend || '') &&
    body.images.registrationReceipt === true &&
    JSON.stringify(body.images.platforms) === '["ps5"]' &&
    JSON.stringify(body.images.formats) === '["ufs2","exfat","pfs","ffpfsc"]';
  // ShadowMount is configured (prepared) but its API does not answer.
  const shadowMountUnavailable =
    status === 200 &&
    body?.service === 'PackageFlowService-PS5' &&
    body.images?.route === 'staged-image' &&
    body.images.prepared === true &&
    body.images.ready === false &&
    /^ShadowMountPlus-[A-Za-z0-9._-]{1,32}$/.test(body.images.backend || '');
  return {
    ...(shadowMountUnavailable ? { shadowMountUnavailable: true as const } : {}),
    formats: [
      ...(ready ? ['pkg' as const] : []),
      ...(folder ? ['folder' as const] : []),
      ...(images ? ['ufs2' as const, 'exfat' as const, 'pfs' as const, 'ffpfsc' as const] : []),
    ],
    installPs4: platforms.includes('ps4'),
    installPs5: platforms.includes('ps5') || folder || images,
    background: false,
    ...(folder
      ? {
          folder: {
            route: 'staged-folder' as const,
            ready: true as const,
            ...(body.folder.streamProtocol === 'folder-stream-v2' &&
            body.folder.storageCopies === 1 &&
            body.folder.streamingHash === true
              ? { streamProtocol: 'folder-stream-v2' as const, storageCopies: 1 as const }
              : {}),
            ...(body.folder.verificationWindow === 2 ? { verificationWindow: 2 as const } : {}),
          },
        }
      : {}),
    ...(images
      ? {
          images: {
            route: 'staged-image' as const,
            ready: true as const,
            protocol: 'image-registration-v1' as const,
            backend: String(body.images.backend),
            registrationReceipt: true as const,
          },
        }
      : {}),
    installation: { route: 'staged-pkg', ready, reason, exactVersionReceipt: false },
  };
}

export const ps5ShadowMountMessage =
  'ShadowMount на PS5 не отвечает, поэтому Folder и образы сейчас не ставятся. Перезапустите ShadowMount или PS5, затем нажмите «Обновить» в окне установки. PKG ставятся как обычно';

export function ps5InstallMessage(capabilities: ConsoleCapabilities) {
  if (capabilities.images?.ready && !capabilities.installation?.ready)
    return 'Установка образов PS5 доступна через ShadowMount+';
  return capabilities.installation?.ready
    ? 'Установка PKG доступна. Подтверждение точной установленной версии пока недоступно'
    : ps5InstallReasons[capabilities.installation?.reason || ''] ||
        'Просмотр библиотеки доступен. Готовность установки ещё не проверена';
}

/** A PKG rejection must describe its own route, never the independent image backend. */
export function ps5PkgInstallMessage(capabilities: ConsoleCapabilities) {
  return capabilities.installation?.ready
    ? 'Установка PKG доступна'
    : ps5InstallReasons[capabilities.installation?.reason || ''] ||
        'Не удалось проверить готовность установки PKG на PS5';
}

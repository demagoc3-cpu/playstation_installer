import type { ConsoleCapabilities } from './types/consoles'

export const ps5InstallReasons: Record<string, string> = {
  installer_unavailable: 'Установщик PS5 не запущен или недоступен',
  unrecognized_installer: 'Обновите установщик PS5 до согласованной версии',
  initialization_failed: 'Установщик PS5 не готов: системная инициализация не завершилась',
  unsupported_firmware: 'Этот маршрут установки ещё не проверен на данной прошивке PS5',
  readiness_unavailable: 'Не удалось проверить готовность установки PS5',
  service_update_required: 'Обновите службу PS5 для проверки готовности установки',
}

/** The service admits a specific tested route. No image support is inferred
 * from a package installer or from the console being paired. */
export function ps5InstallCapabilities(status: number, body: any, firmware?: string): ConsoleCapabilities {
  let reason = status === 404 ? 'service_update_required' : 'readiness_unavailable'
  let platforms: string[] = []
  if (status === 200 && body?.service === 'PackageFlowService-PS5' && body.schemaVersion === 1 &&
      body.route === 'staged-pkg' && body.exactVersionReceipt === false) {
    if (body.ready === false && Object.hasOwn(ps5InstallReasons, body.reason) &&
        Array.isArray(body.formats) && !body.formats.length && Array.isArray(body.platforms) && !body.platforms.length) reason = body.reason
    else if (body.ready === true && body.reason === 'ready' && Array.isArray(body.formats) &&
        body.formats.length === 1 && body.formats[0] === 'pkg' &&
        JSON.stringify(body.platforms) === JSON.stringify(firmware === '13.60' ? ['ps4', 'ps5'] : firmware === '12.60' ? ['ps4'] : null)) {
      reason = 'ready'; platforms = body.platforms
    }
  }
  const ready = reason === 'ready'
  return { formats: ready ? ['pkg'] : [], installPs4: platforms.includes('ps4'), installPs5: platforms.includes('ps5'), background: false,
    installation: { route: 'staged-pkg', ready, reason, exactVersionReceipt: false } }
}

export function ps5InstallMessage(capabilities: ConsoleCapabilities) {
  return capabilities.installation?.ready ? 'Установка PKG доступна. Подтверждение точной установленной версии пока недоступно' :
    ps5InstallReasons[capabilities.installation?.reason || ''] || 'Просмотр библиотеки доступен. Готовность установки ещё не проверена'
}

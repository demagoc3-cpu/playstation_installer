import { activeConsoleProfile, consoleProfileForIp, getConsoleProfile } from './console-profiles'
import { legacyConsoleIp } from './console-scope'
import { ps4ServiceIp } from './ps4-service'

/** Capture the destination when enabling automation, never at completion. */
export function torrentInstallTarget(consoleId?: unknown) {
  const profile = consoleId === undefined ? activeConsoleProfile() : getConsoleProfile(consoleId)
  const ip = profile?.ip || ps4ServiceIp(legacyConsoleIp())
  if (!ip) throw createError({ statusCode: 409, message: 'Выберите приставку для автоустановки' })
  assertTorrentInstallTarget(ip)
  return ip
}
export function assertTorrentInstallTarget(ip: string) {
  if (!ps4ServiceIp(ip)) throw createError({ statusCode: 400, message: 'Неверный адрес автоустановки' })
  if (consoleProfileForIp(ip)?.platform === 'ps5') throw createError({ statusCode: 409, message: 'Автоустановка на PS5 станет доступна после подключения собственного backend. Торрент можно скачать без автоустановки.' })
}

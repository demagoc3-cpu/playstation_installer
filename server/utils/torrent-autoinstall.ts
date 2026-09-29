import { logEvent } from './event-log'
import { getInstallationQueue, startInstallationQueue } from './installation-queue'
import { getLibraryPackages, scanPackageFolder } from './package-library'
import { getGoldHenStatus, getLocalIp, getSavedPsIp } from './ps4-installer'
import { getCompletedTorrentDirectory, getQbitSettings, getTorrents } from './qbittorrent'
import { getIndexedTorrentPackageIds, markAutoInstallHandled, markTorrentIndexed, wasAutoInstallHandled } from './torrent-library'

// qBittorrent may report 100 % while it is still verifying or moving files.
const UNSETTLED_STATE = /checking|moving|allocating|metadl/i
const WAIT_LOG_EVERY_MS = 5 * 60 * 1000
let lastWaitLog = 0

function serverPort() { return process.env.NITRO_PORT || process.env.PORT || '3000' }

function logWait(text: string) {
  if (Date.now() - lastWaitLog < WAIT_LOG_EVERY_MS) return
  lastWaitLog = Date.now()
  logEvent('warn', text)
}

/**
 * One pass of the automatic installer: finds finished torrents tagged
 * "packageflow-auto-install", adds their PKGs to the library and hands them to
 * the installation queue (game → patches → DLC). Handles one torrent per pass
 * and never interrupts a queue that is already running.
 */
export async function runTorrentAutoInstall() {
  if (!getQbitSettings().configured) return
  let torrents: Awaited<ReturnType<typeof getTorrents>>
  try { torrents = await getTorrents() } catch { return } // qBittorrent is offline: try again later
  const ready = torrents.filter((torrent) => torrent.autoInstall && torrent.progress >= 1 && !UNSETTLED_STATE.test(torrent.state) && !wasAutoInstallHandled(torrent.hash))
  if (!ready.length) return

  const psIp = getSavedPsIp()
  if (!psIp) return logWait('Автоустановка ждёт: не указан IP PS4. Подключите приставку на странице PackageFlow.')
  if (['running', 'cancelling'].includes(getInstallationQueue().status)) return // the current queue finishes first

  const torrent = ready[0]!
  try {
    let packageIds = getIndexedTorrentPackageIds(torrent.hash)
    if (!packageIds) {
      const result = await scanPackageFolder(await getCompletedTorrentDirectory(torrent.hash))
      packageIds = result.packages.map((item) => item.id)
      markTorrentIndexed(torrent.hash, packageIds)
    }
    const ids = new Set(packageIds)
    const packages = getLibraryPackages().filter((item) => ids.has(item.id) && !item.installedAt)
      .sort((a, b) => a.installOrder - b.installOrder || a.title.localeCompare(b.title))
    if (!packages.length) {
      markAutoInstallHandled(torrent.hash)
      logEvent('warn', `Торрент «${torrent.name}» загружен, но новых PKG для установки в нём нет`)
      return
    }

    const status = await getGoldHenStatus(psIp)
    if (!status.ready) return logWait(`Автоустановка «${torrent.name}» ждёт PS4 ${psIp}: загрузчик на порту 9090 не отвечает`)

    const pcIp = await getLocalIp(psIp)
    const port = serverPort()
    const packageUrls = Object.fromEntries(packages.map((item) => [item.id, `http://${pcIp}:${port}/json/${item.id}.json`]))
    startInstallationQueue({ psIp, packageIds: packages.map((item) => item.id), packageUrls })
    markAutoInstallHandled(torrent.hash)
    lastWaitLog = 0
    logEvent('info', `Торрент «${torrent.name}» загружен: автоустановка на PS4 запущена (пакетов — ${packages.length})`)
  } catch (error: any) {
    // Do not retry forever: re-enabling "Автоустановка" on the torrent allows another attempt.
    markAutoInstallHandled(torrent.hash)
    logEvent('error', `Автоустановка «${torrent.name}» не удалась: ${error?.message || error}. Включите «Автоустановку» заново, чтобы повторить.`)
  }
}

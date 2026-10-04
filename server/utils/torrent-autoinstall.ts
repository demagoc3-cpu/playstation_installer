import { logEvent } from './event-log'
import { selectAutomaticPackages } from './automatic-package-selection'
import { getInstallationQueue, startInstallationQueue } from './installation-queue'
import { getInstallationPreference } from './installation-preference'
import { getLibraryPackages, scanPackageFolder } from './package-library'
import { getConsoleCatalog, getConsoleDetails } from './ps4-console-apps'
import { getGoldHenStatus, getLocalIp, getSavedPsIp } from './ps4-installer'
import { getServiceInstallerStatus } from './ps4-service-installer'
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
    const library = getLibraryPackages()
    const candidates = library.filter((item) => ids.has(item.id) || item.sourceIds?.some(id => ids.has(id)))
    const transport = getInstallationPreference()
    let consoleSnapshot: Parameters<typeof selectAutomaticPackages>[2]
    if (transport === 'service') {
      const status = await getServiceInstallerStatus(psIp)
      if (!status.ready) return logWait(`Автоустановка «${torrent.name}» ждёт PackageFlowService на PS4 ${psIp}: ${status.message}`)
      try {
        const catalog = await getConsoleCatalog(psIp)
        if (!catalog.complete) return logWait(`Автоустановка «${torrent.name}» ждёт полного списка игр с PS4`)
        const baseTitleIds = new Set(catalog.apps.filter((app) => app.installed).map((app) => app.titleId))
        const patchTitleIds = new Set<string>()
        const dlcContentIds = new Set<string>()
        const detailsIds = new Set(candidates.filter((item) => ['PS4GP', 'PS4AC', 'PS4AL'].includes(item.contentType)).map((item) => item.titleId).filter((id) => baseTitleIds.has(id)))
        for (const titleId of detailsIds) {
          const details = await getConsoleDetails(psIp, titleId)
          if (!details.complete) return logWait(`Автоустановка «${torrent.name}» ждёт полного состава ${titleId} с PS4`)
          for (const component of details.components) {
            if (component.kind === 'patch') patchTitleIds.add(titleId)
            if (component.kind === 'dlc') dlcContentIds.add(component.contentId)
          }
        }
        consoleSnapshot = { baseTitleIds, patchTitleIds, dlcContentIds }
      } catch (error: any) { return logWait(`Автоустановка «${torrent.name}» ждёт списка PS4: ${error?.message || error}`) }
    } else {
      const status = await getGoldHenStatus(psIp)
      if (!status.ready) return logWait(`Автоустановка «${torrent.name}» ждёт PS4 ${psIp}: загрузчик на порту 9090 не отвечает`)
    }

    const packages = selectAutomaticPackages(candidates, library, consoleSnapshot)
    if (!packages.length) {
      markAutoInstallHandled(torrent.hash)
      logEvent('warn', `Торрент «${torrent.name}» загружен, но новых PKG для установки в нём нет`)
      return
    }

    const pcIp = await getLocalIp(psIp)
    const port = serverPort()
    const packageUrls = Object.fromEntries(packages.map((item) => [item.id, `http://${pcIp}:${port}/json/${item.id}.json`]))
    startInstallationQueue({ psIp, packageIds: packages.map((item) => item.id), packageUrls, transport })
    markAutoInstallHandled(torrent.hash)
    lastWaitLog = 0
    logEvent('info', `Торрент «${torrent.name}» загружен: автоустановка через ${transport === 'service' ? 'PackageFlowService' : 'PyLoader'} запущена (пакетов — ${packages.length})`)
  } catch (error: any) {
    // Do not retry forever: re-enabling "Автоустановка" on the torrent allows another attempt.
    markAutoInstallHandled(torrent.hash)
    logEvent('error', `Автоустановка «${torrent.name}» не удалась: ${error?.message || error}. Включите «Автоустановку» заново, чтобы повторить.`)
  }
}

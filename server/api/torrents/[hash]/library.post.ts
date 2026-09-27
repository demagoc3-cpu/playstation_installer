import { logEvent } from '../../../utils/event-log'
import { getLibraryPackages, scanPackageFolder } from '../../../utils/package-library'
import { getCompletedTorrentDirectory } from '../../../utils/qbittorrent'
import { getIndexedTorrentPackageIds, markTorrentIndexed } from '../../../utils/torrent-library'
import { getLocalIp } from '../../../utils/ps4-installer'

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash') || ''
  const body = await readBody<{ psIp?: string }>(event)
  const pcIp = await getLocalIp(body?.psIp || '')
  const host = getHeader(event, 'host') || 'localhost:3000'
  const port = host.match(/:(\d+)$/)?.[1] || '3000'
  const indexedPackageIds = getIndexedTorrentPackageIds(hash)
  if (indexedPackageIds) {
    const indexed = getLibraryPackages().filter((item) => indexedPackageIds.includes(item.id))
    return { alreadyIndexed: true, packages: indexed.map((item) => ({ ...item, url: `http://${pcIp}:${port}/json/${item.id}.json` })) }
  }
  const result = await scanPackageFolder(await getCompletedTorrentDirectory(hash))
  markTorrentIndexed(hash, result.packages.map((item) => item.id))
  logEvent('info', `Торрент загружен: в библиотеку добавлено пакетов — ${result.packages.length}`)
  return { alreadyIndexed: false, packages: result.packages.map((item) => ({ ...item, url: `http://${pcIp}:${port}/json/${item.id}.json` })) }
})

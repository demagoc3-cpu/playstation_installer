import { getInstallationQueue } from '../../../utils/installation-queue'
import { getLibraryPackages } from '../../../utils/package-library'
import { getMaintenance } from '../../../utils/console-maintenance'
import { getTorrents, getQbitSettings } from '../../../utils/qbittorrent'
import { consoleQueueTasks } from '../../../utils/console-app-data'
import { ps4ServiceIp } from '../../../utils/ps4-service'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const q = getQuery(event), ip = ps4ServiceIp(q.ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' })
  if (q.source === 'local') return { tasks: [], message: q.lang === 'en' ? 'The native PS4 torrent client is planned. No local torrent jobs yet.' : 'Встроенный торрент-клиент PS4 запланирован. Локальных торрент-заданий пока нет.' }
  if (q.source === 'web') {
    if (!getQbitSettings().configured) return { tasks: [], message: q.lang === 'en' ? 'Configure qBittorrent in WEB to see its downloads here.' : 'Настройте qBittorrent в WEB, чтобы видеть его загрузки здесь.' }
    try {
      return { tasks: (await getTorrents()).slice(0, 256).map(t => ({ id: t.hash, title: t.name, kind: 'torrent', state: t.state,
        progress: Math.max(0, Math.min(100, Math.floor(t.progress * 100))), detail: `${(t.speed / 1048576).toFixed(1)} MB/s` })), message: '' }
    } catch { return { tasks: [], message: q.lang === 'en' ? 'WEB torrent client is unavailable.' : 'Торрент-клиент WEB недоступен.' } }
  }
  // This also advances the existing maintenance flow after a reinstall.
  const maintenance = await getMaintenance(ip)
  const queue = getInstallationQueue()
  return { tasks: consoleQueueTasks(queue, ip, getLibraryPackages(), q.lang === 'en' ? 'en' : 'ru'), message: maintenance?.kind === 'reinstall' && !['completed', 'failed'].includes(maintenance.state) ? maintenance.message : '',
    currentPackageId: queue.psIp === ip && queue.status === 'running' ? queue.items.find(i => ['pending','sending','waiting','receiving','installing','verifying'].includes(i.state))?.packageId || '' : '',
    queueStatus: queue.psIp === ip ? queue.status : 'idle', queueId: queue.psIp === ip ? queue.id || '' : '' }
})

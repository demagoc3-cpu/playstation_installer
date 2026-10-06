import { getInstallationTasks } from '../../../utils/installation-tasks'
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
  if (q.source === 'tasks') {
    await getMaintenance(ip)
    const mask = Math.max(0, Math.min(15, Number(q.mask ?? 15))), names = ['active','queued','completed','failed']
    const data = getInstallationTasks({ ip, page: q.page, view: 'table', categories: names.filter((_,i) => mask & (1 << i)).join(',') }), queue = getInstallationQueue()
    const active = data.active // Active jobs remain pinned above filtered history.
    return { tasks: [...active, ...data.items].map(task => ({ id: task.packageId, queueId: task.queueId, title: task.title, groupTitle: task.groupTitle, titleId: task.titleId, fileName: task.fileName, size: task.size, kind: ({'Игра':'game','Патч':'patch','Бэкпорт':'backport','DLC':'dlc'} as Record<string,string>)[task.type] || 'game', state: task.state, detail: task.detail, canCancel: task.canCancel, progress: task.state === 'installed' ? 100 : task.size ? Math.max(0, Math.min(99, Math.floor(task.bytesSent/task.size*100))) : 0 })),
      currentPackageId: queue.psIp === ip && queue.status === 'running' ? active[0]?.packageId || '' : '', queueStatus: queue.psIp === ip ? queue.status : 'idle', queueId: queue.psIp === ip ? queue.id || '' : '', taskPage: data.page, taskPages: data.pages, taskTotal: data.total, counts: data.counts, message: '' }
  }
  // This also advances the existing maintenance flow after a reinstall.
  const maintenance = await getMaintenance(ip)
  const queue = getInstallationQueue()
  return { tasks: consoleQueueTasks(queue, ip, getLibraryPackages(), q.lang === 'en' ? 'en' : 'ru'), message: maintenance?.kind === 'reinstall' && !['completed', 'failed'].includes(maintenance.state) ? maintenance.message : '',
    currentPackageId: queue.psIp === ip && queue.status === 'running' ? queue.items.find(i => ['pending','sending','waiting','receiving','installing','verifying'].includes(i.state))?.packageId || '' : '',
    queueStatus: queue.psIp === ip ? queue.status : 'idle', queueId: queue.psIp === ip ? queue.id || '' : '' }
})

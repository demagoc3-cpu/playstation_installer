import { controlTorrent, setTorrentAutoInstall } from '../../../utils/qbittorrent'
import { clearAutoInstallHandled, forgetTorrentIndex } from '../../../utils/torrent-library'
import { torrentInstallTarget } from '../../../utils/torrent-console'

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash') || ''
  const action = getRouterParam(event, 'action')
  if (action === 'auto-install') {
    const body = await readBody<{ enabled?: boolean; consoleId?: string }>(event)
    const ip = body?.enabled === true ? torrentInstallTarget(body.consoleId) : undefined
    await setTorrentAutoInstall(hash, body?.enabled === true, ip)
    // Re-enabling allows another automatic attempt for an already finished torrent.
    if (body?.enabled === true) clearAutoInstallHandled(hash)
    return { ok: true }
  }
  if (action !== 'pause' && action !== 'resume' && action !== 'delete') throw createError({ statusCode: 404, message: 'Неизвестное действие torrent-задачи' })
  await controlTorrent(hash, action)
  if (action === 'delete') forgetTorrentIndex(hash)
  return { ok: true }
})

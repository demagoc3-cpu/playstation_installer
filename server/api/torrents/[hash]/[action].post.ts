import { controlTorrent, setTorrentAutoInstall } from '../../../utils/qbittorrent'
import { forgetTorrentIndex } from '../../../utils/torrent-library'

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash') || ''
  const action = getRouterParam(event, 'action')
  if (action === 'auto-install') {
    const body = await readBody<{ enabled?: boolean }>(event)
    await setTorrentAutoInstall(hash, body?.enabled === true)
    return { ok: true }
  }
  if (action !== 'pause' && action !== 'resume' && action !== 'delete') throw createError({ statusCode: 404, statusMessage: 'Неизвестное действие torrent-задачи' })
  await controlTorrent(hash, action)
  if (action === 'delete') forgetTorrentIndex(hash)
  return { ok: true }
})

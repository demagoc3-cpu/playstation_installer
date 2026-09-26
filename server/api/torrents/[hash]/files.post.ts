import { setTorrentFilesPriority } from '../../../utils/qbittorrent'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ ids?: number[]; priority?: 0 | 1 }>(event)
  await setTorrentFilesPriority(getRouterParam(event, 'hash') || '', body?.ids || [], body?.priority === 0 ? 0 : 1)
  return { ok: true }
})

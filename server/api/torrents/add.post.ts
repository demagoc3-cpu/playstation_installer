import { addTorrent } from '../../utils/qbittorrent'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ source?: string; installAfterDownload?: boolean }>(event)
  await addTorrent(body?.source?.trim() || '', Boolean(body?.installAfterDownload))
  return { added: true }
})

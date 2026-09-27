import { logEvent } from '../../utils/event-log'
import { addTorrent } from '../../utils/qbittorrent'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ source?: string; installAfterDownload?: boolean }>(event)
  await addTorrent(body?.source?.trim() || '', Boolean(body?.installAfterDownload))
  logEvent('info', `Торрент передан в qBittorrent${body?.installAfterDownload ? ' (с автоустановкой на PS4)' : ''}`)
  return { added: true }
})

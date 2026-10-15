import { logEvent } from '../../utils/event-log';
import { addTorrent } from '../../utils/qbittorrent';
import { torrentInstallTarget } from '../../utils/torrent-console';

export default defineEventHandler(async (event) => {
  const body = await readBody<{
    source?: string;
    installAfterDownload?: boolean;
    consoleId?: string;
  }>(event);
  const ip = body?.installAfterDownload ? torrentInstallTarget(body.consoleId) : undefined;
  await addTorrent(body?.source?.trim() || '', Boolean(body?.installAfterDownload), ip);
  logEvent(
    'info',
    `Торрент передан в qBittorrent${body?.installAfterDownload ? ' (с автоустановкой на PS4)' : ''}`,
  );
  return { added: true };
});

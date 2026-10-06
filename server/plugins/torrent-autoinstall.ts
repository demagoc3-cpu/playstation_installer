import { runTorrentAutoInstall } from '../utils/torrent-autoinstall'
import { desktopStopping } from '../utils/desktop-lifecycle'

/** Watches qBittorrent in the background so auto-install works even with the web page closed. */
export default defineNitroPlugin(() => {
  let busy = false
  const timer = setInterval(async () => {
    if (busy || desktopStopping()) return
    busy = true
    try { await runTorrentAutoInstall() } catch { /* errors are logged inside */ } finally { busy = false }
  }, 5000)
  timer.unref?.()
})

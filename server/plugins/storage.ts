import { storageManager } from '../utils/storage-sources'
export default defineNitroPlugin(nitro => {
  const timer = setInterval(() => { void storageManager.tick().catch(() => {}) }, 60000)
  timer.unref()
  void storageManager.tick().catch(() => {})
  nitro.hooks.hook('close', () => { clearInterval(timer); storageManager.close() })
})

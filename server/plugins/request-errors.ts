/**
 * Prints every failed request as one readable line, e.g.
 * [PackageFlow] GET /api/torrents → 502 qBittorrent отклонил подключение…
 * (instead of h3's generic warning), so repeating errors are easy to trace.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (error: any, context) => {
    const event = context?.event
    const status = error?.statusCode || 500
    const where = event ? `${event.method} ${event.path}` : 'сервер'
    const text = error?.message || error?.statusMessage || String(error)
    if (status >= 500 && !error?.statusCode) console.error(`[PackageFlow] ${where} → ${status}`, error)
    else console.warn(`[PackageFlow] ${where} → ${status} ${text}`)
  })
})

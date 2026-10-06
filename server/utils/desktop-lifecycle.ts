import { createError } from 'h3'
let stopping = false
let requests = 0
export const desktopStopping = () => stopping
export const desktopRequests = () => requests
export function beginDesktopStop() { stopping = true }
export function cancelDesktopStop() { stopping = false }
export function trackDesktopRequest() { requests++; let ended = false; return () => { if (!ended) { ended = true; requests-- } } }
export function assertDesktopWritable() {
  if (stopping) throw createError({ statusCode: 503, message: 'PackageFlow готовится к остановке. Повторите действие после запуска.' })
}

import { assertDesktopWritable, trackDesktopRequest } from '../utils/desktop-lifecycle'
export default defineEventHandler(event => {
  if (!process.env.PACKAGEFLOW_LAUNCHER_KEY || event.path.startsWith('/api/desktop/')) return
  assertDesktopWritable()
  const done = trackDesktopRequest()
  event.node.res.once('finish', done)
  event.node.res.once('close', done)
})

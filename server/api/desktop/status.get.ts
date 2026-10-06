import { assertDesktopControl, desktopActivity } from '../../utils/desktop-control'
export default defineEventHandler(event => {
  assertDesktopControl(event)
  return { application: 'PackageFlow', processId: process.pid, ...desktopActivity() }
})

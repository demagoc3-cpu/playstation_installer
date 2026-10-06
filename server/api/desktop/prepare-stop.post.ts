import { assertDesktopControl, desktopActivity } from '../../utils/desktop-control'
import { beginDesktopStop, cancelDesktopStop } from '../../utils/desktop-lifecycle'
export default defineEventHandler(async event => {
  assertDesktopControl(event)
  beginDesktopStop()
  // Let already accepted requests finish; new requests cannot start while draining.
  await new Promise(resolve => setTimeout(resolve, 1500))
  try {
    const activity = desktopActivity()
    if (activity.busy) cancelDesktopStop()
    else {
      // If the launcher disappears before stopping the process, restore normal use.
      const timeout = setTimeout(cancelDesktopStop, 15000); timeout.unref?.()
    }
    return activity
  } catch (error) { cancelDesktopStop(); throw error }
})

import { forgetQueuedPackage } from '../../../utils/installation-queue'
import { markPackageInstalled, resetPackageDelivery } from '../../../utils/package-library'

/** Returns a delivered / installed / failed / cancelled package to "ready" so it can be installed again. */
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  forgetQueuedPackage(id)
  resetPackageDelivery(id)
  return markPackageInstalled(id, false)
})


import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { fileJobs } from '../../../utils/console-files'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  return fileJobs((await readBody(event))?.ip)
})

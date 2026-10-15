import { ps5AppUpdateInfo } from '../../utils/ps5-app-updates'
export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store')
  return ps5AppUpdateInfo(getQuery(event).consoleId)
})

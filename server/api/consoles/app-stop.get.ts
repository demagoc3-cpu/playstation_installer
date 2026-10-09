import { ps5AppStopInfo } from '../../utils/ps5-app-stop'
export default defineEventHandler(event => ps5AppStopInfo(String(getQuery(event).consoleId || '')))

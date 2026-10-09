import { ps5AppLaunchInfo } from '../../utils/ps5-app-launch'
export default defineEventHandler(event=>ps5AppLaunchInfo(getQuery(event).consoleId))

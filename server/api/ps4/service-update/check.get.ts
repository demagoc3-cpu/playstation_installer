import { latestServiceRelease } from '../../../utils/service-updates'
export default defineEventHandler(event => latestServiceRelease(String(getQuery(event).current || '0.00')))

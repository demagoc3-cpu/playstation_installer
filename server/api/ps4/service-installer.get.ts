import { getServiceInstallerStatus } from '../../utils/ps4-service-installer'
export default defineEventHandler(event => getServiceInstallerStatus(String(getQuery(event).ip || '')))

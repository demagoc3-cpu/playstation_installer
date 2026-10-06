import { getInstallationTasks } from '../../../utils/installation-tasks'
export default defineEventHandler(event => getInstallationTasks(getQuery(event)))

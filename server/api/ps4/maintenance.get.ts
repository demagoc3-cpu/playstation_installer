import { getMaintenance } from '../../utils/console-maintenance'
export default defineEventHandler(event => getMaintenance(getQuery(event).ip))

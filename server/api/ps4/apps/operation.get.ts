import { getConsoleRemoval } from '../../../utils/ps4-console-apps'
export default defineEventHandler(event => getConsoleRemoval(getQuery(event).ip))

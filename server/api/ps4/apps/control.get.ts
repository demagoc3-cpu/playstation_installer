import { getConsoleControl } from '../../../utils/console-control'
export default defineEventHandler(event => getConsoleControl(getQuery(event).ip))

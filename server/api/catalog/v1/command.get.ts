import { consoleCommand } from '../../../utils/console-app-commands'
export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const q = getQuery(event)
  return consoleCommand(q.id, q.ip)
})

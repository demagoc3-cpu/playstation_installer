import { consoleSupport } from '../../../utils/console-support'

export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store')
  return consoleSupport(useRuntimeConfig(event).public.donation)
})

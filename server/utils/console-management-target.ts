import { createError } from 'h3'
import { dataPath } from './data-path'
import { readJsonFile } from './json-store'
import { ps4ServiceIp } from './ps4-service'

/** Request-local target, never the browser's mutable active profile. Legacy
 * PS4 addresses remain supported; known PS5 profiles cannot reach PS4 APIs. */
export function ps4ManagementIp(value: unknown) {
  const ip = ps4ServiceIp(value)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите корректный IPv4-адрес PS4' })
  const profiles = readJsonFile<{ consoles?: Array<{ ip: string; platform: string }> }>(dataPath('console-profiles.json'), {})
  if (profiles.consoles?.some(item => item.ip === ip && item.platform !== 'ps4'))
    throw createError({ statusCode: 409, message: 'Для выбранной PS5 нельзя использовать операции PS4' })
  return ip
}

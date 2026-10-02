import { resolve } from 'node:path'
import { readJsonFile, writeJsonFile } from './json-store'
import type { InstallationTransport } from '../../shared/types/installation'

const path = resolve(process.cwd(), '.data/installation-preference.json')

export function getInstallationPreference(): InstallationTransport {
  const value = readJsonFile<{ transport?: unknown }>(path, { transport: 'service' }).transport
  return value === 'payload' ? 'payload' : 'service'
}

export function setInstallationPreference(value: unknown): InstallationTransport {
  if (value !== 'payload' && value !== 'service') throw createError({ statusCode: 400, message: 'Неизвестный способ установки' })
  writeJsonFile(path, { transport: value })
  return value
}

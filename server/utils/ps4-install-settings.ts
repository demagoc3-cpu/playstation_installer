import { createError } from 'h3'
import { dataPath } from './data-path'
import { readJsonFile, writeJsonFile } from './json-store'

const path = () => dataPath('ps4-install-settings.json')
export function getPs4InstallSettings() {
  const saved = readJsonFile<{ verifyPkgBeforeSend?: unknown }>(path(), {})
  return { verifyPkgBeforeSend: saved.verifyPkgBeforeSend === true }
}
export function savePs4InstallSettings(input: unknown) {
  if (!input || typeof input !== 'object' || typeof (input as any).verifyPkgBeforeSend !== 'boolean')
    throw createError({ statusCode: 400, message: 'Укажите, проверять ли PKG перед отправкой' })
  const settings = { verifyPkgBeforeSend: (input as any).verifyPkgBeforeSend as boolean }
  writeJsonFile(path(), settings)
  return settings
}

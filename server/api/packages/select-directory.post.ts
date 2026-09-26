import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const run = promisify(execFile)

export default defineEventHandler(async () => {
  try {
    const { stdout } = await run('/usr/bin/zenity', ['--file-selection', '--directory', '--title=PackageFlow: выберите папку с PKG'], { timeout: 5 * 60 * 1000 })
    const directory = stdout.trim()
    if (!directory) throw createError({ statusCode: 400, statusMessage: 'Папка не выбрана' })
    return { directory }
  } catch (error: any) {
    if (error?.killed || error?.code === 1) throw createError({ statusCode: 400, statusMessage: 'Выбор папки отменён' })
    throw createError({ statusCode: 503, statusMessage: 'Не удалось открыть системный выбор папки. Введите путь вручную.' })
  }
})

import { FolderPickerCancelled, pickFolder } from '../../utils/folder-picker'

/** Opens the operating system's folder dialog (Windows, macOS, Linux) on the PC running PackageFlow. */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ initial?: string }>(event).catch(() => undefined)
  try {
    return { directory: await pickFolder(body?.initial), cancelled: false }
  } catch (error: any) {
    // Closing the dialog is a normal outcome, not an error.
    if (error instanceof FolderPickerCancelled) return { directory: '', cancelled: true }
    throw createError({ statusCode: 503, message: error?.message || 'Не удалось открыть системный выбор папки. Введите путь вручную.' })
  }
})

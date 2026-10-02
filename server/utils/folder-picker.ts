import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { promisify } from 'node:util'

const run = promisify(execFile)
const TITLE = 'PackageFlow: выберите папку с PKG'
const TIMEOUT_MS = 5 * 60 * 1000

export class FolderPickerCancelled extends Error {}
export class FolderPickerUnavailable extends Error {}

const isDirectory = (path?: string) => { try { return Boolean(path) && existsSync(path!) && statSync(path!).isDirectory() } catch { return false } }

/** A process that exited with code 1 means the user closed the dialog (zenity, kdialog, osascript, our PowerShell script). */
const cancelled = (error: any) => error?.code === 1 || error?.killed

/**
 * Windows: FolderBrowserDialog from PowerShell. The script is passed as
 * -EncodedCommand (UTF-16LE base64) so Cyrillic text survives, and the path is
 * written as UTF-8. A hidden TopMost owner keeps the dialog above the browser.
 */
async function pickOnWindows(initial?: string) {
  const escape = (value: string) => value.replace(/'/g, "''")
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${escape(TITLE)}'`,
    '$dialog.ShowNewFolderButton = $false',
    initial ? `$dialog.SelectedPath = '${escape(initial)}'` : '',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath); exit 0 }',
    'exit 1'
  ].filter(Boolean).join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout: TIMEOUT_MS, encoding: 'utf8' })
  return stdout
}

async function pickOnMac(initial?: string) {
  const location = initial ? ` default location (POSIX file "${initial.replace(/(["\\])/g, '\\$1')}")` : ''
  const { stdout } = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "${TITLE}"${location})`], { timeout: TIMEOUT_MS })
  return stdout
}

async function pickOnLinux(initial?: string) {
  if (process.env.PACKAGEFLOW_DOCKER === '1') throw new FolderPickerUnavailable('В Docker окно выбора папки недоступно. Введите путь внутри контейнера вручную, например /games.')
  const start = initial ? `${initial.replace(/\/+$/, '')}/` : undefined
  const candidates: Array<[string, string[]]> = [
    ['zenity', ['--file-selection', '--directory', `--title=${TITLE}`, ...(start ? [`--filename=${start}`] : [])]],
    ['kdialog', ['--getexistingdirectory', start || '.', '--title', TITLE]]
  ]
  for (const [command, args] of candidates) {
    try { return (await run(command, args, { timeout: TIMEOUT_MS })).stdout } catch (error: any) {
      if (error?.code === 'ENOENT') continue // not installed: try the next picker
      throw error
    }
  }
  throw new FolderPickerUnavailable('Не найден zenity или kdialog. Установите zenity (sudo apt install zenity) или укажите путь вручную.')
}

/** Opens the native folder dialog on the machine running the server and returns the chosen path. */
export async function pickFolder(initial?: string) {
  const start = isDirectory(initial) ? initial : undefined
  let output: string
  try {
    if (process.platform === 'win32') output = await pickOnWindows(start)
    else if (process.platform === 'darwin') output = await pickOnMac(start)
    else output = await pickOnLinux(start)
  } catch (error: any) {
    if (error instanceof FolderPickerUnavailable) throw error
    if (cancelled(error)) throw new FolderPickerCancelled('Выбор папки отменён')
    if (error?.code === 'ENOENT') throw new FolderPickerUnavailable('Системный выбор папки недоступен. Укажите путь вручную.')
    throw new FolderPickerUnavailable(`Не удалось открыть выбор папки: ${error?.message || error}`)
  }
  let directory = output.trim()
  // Drop a trailing slash (macOS adds one) but keep roots such as "C:\\" or "/".
  if (!/^(?:[A-Za-z]:[\\/]|\/)$/.test(directory)) directory = directory.replace(/[\\/]+$/, '')
  if (!directory) throw new FolderPickerCancelled('Папка не выбрана')
  return directory
}

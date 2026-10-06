import { resolve } from 'node:path'

/** Installed applications can keep persistent data outside the replaceable build. */
export function dataPath(...parts: string[]) {
  return resolve(process.env.PACKAGEFLOW_DATA_DIR || resolve(process.cwd(), '.data'), ...parts)
}

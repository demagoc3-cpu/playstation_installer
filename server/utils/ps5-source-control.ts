import { dataPath } from './data-path';
import { readJsonFile } from './json-store';

/** Owner switch per PS5: allow game file changes before the service check. */
export const ps5SourceControlPath = (id: string) =>
  dataPath('consoles', id, 'ps5-source-control.json');
export function ps5SourceControlOverride(id: string) {
  return readJsonFile<any>(ps5SourceControlPath(id), null)?.enabled === true;
}

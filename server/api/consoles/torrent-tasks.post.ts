import { clearFinishedTorrentTasks } from '../../utils/task-visibility';
import { assertInstallationOrigin } from '../../utils/installation-origin';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  return clearFinishedTorrentTasks((await readBody(event))?.torrents);
});

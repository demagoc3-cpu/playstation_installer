import { assertInstallationOrigin } from '../../utils/installation-origin';
import { storageManager } from '../../utils/storage-sources';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event);
  return storageManager.remove(getRouterParam(event, 'id') || '');
});

import { markPackageInstalled } from '../../../utils/package-library';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || '';
  const body = await readBody<{ installed?: boolean; ip?: string }>(event);
  return markPackageInstalled(id, body?.installed !== false, body?.ip);
});

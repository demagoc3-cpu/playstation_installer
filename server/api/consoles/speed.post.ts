import { beginConsoleSpeed, cancelConsoleSpeed } from '../../utils/console-speed';
import { assertInstallationOrigin } from '../../utils/installation-origin';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const b = await readBody(event);
  if (typeof b?.consoleId !== 'string')
    throw createError({ statusCode: 400, message: 'Выберите приставку' });
  if (b.action === 'cancel' && typeof b.id === 'string')
    return cancelConsoleSpeed(b.consoleId, b.id);
  if (b.action !== 'start') throw createError({ statusCode: 400, message: 'Неверное действие' });
  return beginConsoleSpeed(b.consoleId, b.sizeMiB, b.modes);
});

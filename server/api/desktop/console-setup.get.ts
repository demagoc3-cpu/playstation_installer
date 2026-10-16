import { assertDesktopControl } from '../../utils/desktop-control';
import { desktopConsoleSetupInfo } from '../../utils/desktop-console-setup';
export default defineEventHandler((event) => {
  assertDesktopControl(event);
  setHeader(event, 'Cache-Control', 'no-store');
  return desktopConsoleSetupInfo(getQuery(event).consoleId);
});

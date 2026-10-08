import { inConsoleScope } from '../../utils/console-scope'
import { presetPage } from '../../utils/presets'
export default defineEventHandler(event => inConsoleScope(getQuery(event).ip?.toString(), () => presetPage(getRouterParam(event, 'id'), getQuery(event))))

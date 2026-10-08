import { inConsoleScope } from '../../utils/console-scope'
import { listPresets } from '../../utils/presets'
export default defineEventHandler(event => inConsoleScope(getQuery(event).ip?.toString(), () => listPresets(getQuery(event))))

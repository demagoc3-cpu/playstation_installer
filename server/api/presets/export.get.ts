import { exportPresets } from '../../utils/presets'
export default defineEventHandler(event => { setHeader(event, 'Content-Disposition', 'attachment; filename="PackageFlow-presets.json"'); return exportPresets(getQuery(event).id) })

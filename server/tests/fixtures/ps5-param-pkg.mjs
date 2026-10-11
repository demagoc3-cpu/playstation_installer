/** Public metadata-only FIH/CNT fixture; the rest is synthetic game data. */
export function ps5ParamFixture(fields = {}) {
  return { titleId: 'PPSA95001', contentId: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001', contentVersion: '01.000.001', applicationCategoryType: 0,
    requiredSystemSoftwareVersion: '0x0800000000000000', sdkVersion: '0x0800000000000000',
    localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: 'Owned fixture' } }, ...fields }
}
export function putPs5ParamPkg(bytes, fields = {}) {
  const param = Buffer.from(JSON.stringify(ps5ParamFixture(fields)))
  bytes.writeUInt32BE(0x7f464948, 0); bytes[5] = 0; bytes.writeUInt16LE(3, 6); bytes.writeBigUInt64LE(4096n, 88)
  bytes.fill(0, 4096, 4096 + 1024)
  bytes.writeUInt32BE(0x7f434e54, 4096); bytes.writeUInt32BE(1, 4112); bytes.writeUInt32BE(256, 4120)
  bytes.writeUInt32BE(0x2000, 4352); bytes.writeUInt32BE(512, 4368); bytes.writeUInt32BE(param.length, 4372)
  param.copy(bytes, 4608)
  return bytes
}

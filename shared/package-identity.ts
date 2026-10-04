/** PKG digest identifies the build, not just a game or Content ID. Zero or
 * missing digests are not evidence that two files contain the same package. */
export function packageIdentity(item: { packageDigest?: string; size: number; contentId: string; contentType: string }) {
  const digest = item.packageDigest?.toUpperCase() || ''
  if (!/^[A-F0-9]{64}$/.test(digest) || /^0+$/.test(digest) || !item.contentId || !item.contentType || item.size <= 0) return undefined
  return JSON.stringify([digest, item.size, item.contentId, item.contentType])
}

export function packageHasId(item: { id: string; sourceIds?: string[] }, id: string) {
  return item.id === id || Boolean(item.sourceIds?.includes(id))
}

// Names of the console files in a GitHub release, with their own version:
// PackageFlowPayload-PS5_0.1.29-dev.elf, PackageFlow-PS5_01.000.044.ffpkg,
// PackageFlow-PS4_2.14.pkg. The bundle and PLDMGR keep the pinned file names
// (PackageFlowService-PS5.elf); server/utils/ps5-service-github.ts and
// server/utils/service-updates.ts read these names in the latest release.
export function consoleReleaseName(role, entry) {
  const extension = entry.fileName.slice(entry.fileName.lastIndexOf('.'));
  const base = { elf: 'PackageFlowPayload-PS5', app: 'PackageFlow-PS5', ps4: 'PackageFlow-PS4' }[
    role
  ];
  if (!base || !/^[0-9][0-9A-Za-z.-]{0,31}$/.test(entry.version || ''))
    throw new Error(`No release name for ${role} ${entry.version}`);
  return `${base}_${entry.version}${extension}`;
}

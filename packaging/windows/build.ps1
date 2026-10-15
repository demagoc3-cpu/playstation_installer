param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '1.10.15',
    [string]$Ps5Bundle = '',
    [ValidatePattern('^22\.\d+\.\d+$')][string]$NodeVersion = '22.23.3',
    [switch]$SkipWebBuild,
    [switch]$SkipInstaller
)
$ErrorActionPreference = 'Stop'
if (([version]$Version).Major -eq 10) { throw '10.x.x is an erroneous installer version. Use 1.x.x (for example 1.10.15); rebuild the EXE, do not just rename it.' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$destination = Join-Path $repo 'dist/windows'
$payload = Join-Path $destination 'payload'
New-Item -ItemType Directory -Force $payload | Out-Null
$buildTemp = Join-Path ([IO.Path]::GetTempPath()) ('packageflow-windows-build-' + [guid]::NewGuid().ToString('N'))
Push-Location $repo
try {
    if (!$SkipWebBuild) {
        & npm.cmd ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE) { throw 'Dependency installation failed' }
        & npm.cmd run build
        if ($LASTEXITCODE) { throw 'WEB build failed' }
    }
    & node scripts/package-windows-brand.mjs
    if ($LASTEXITCODE) { throw 'Windows donation assets generation failed' }
    & npm.cmd ci --prefix apps/windows-launcher/desktop-ui --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'Desktop dependencies failed' }
    & npm.cmd run build --prefix apps/windows-launcher/desktop-ui
    if ($LASTEXITCODE) { throw 'Desktop frontend build failed' }
    & dotnet build apps/windows-launcher/PackageFlow.Core.Tests -c Release "-p:ArtifactsPath=$buildTemp/tests"
    if ($LASTEXITCODE) { throw 'Windows core test build failed' }
    & dotnet (Join-Path $buildTemp 'tests/bin/PackageFlow.Core.Tests/release/PackageFlow.Core.Tests.dll')
    if ($LASTEXITCODE) { throw 'Windows core tests failed' }
    & dotnet publish apps/windows-launcher/PackageFlow.Windows -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true "-p:Version=$Version" "-p:ArtifactsPath=$buildTemp/publish" -o $payload
    if ($LASTEXITCODE) { throw 'Windows launcher build failed' }
    & dotnet build packaging/windows/BundleCheck -c Release "-p:ArtifactsPath=$buildTemp/check"
    if ($LASTEXITCODE) { throw 'Windows bundle checker build failed' }
    & dotnet (Join-Path $buildTemp 'check/bin/BundleCheck/release/BundleCheck.dll') (Join-Path $payload 'PackageFlow.exe') $Version
    if ($LASTEXITCODE) { throw 'Windows launcher bundle verification failed' }
    & node scripts/package-windows-desktop.mjs $payload
    if ($LASTEXITCODE) { throw 'Pinned WebView2 packaging failed' }
    New-Item -ItemType Directory -Force (Join-Path $payload 'server') | Out-Null
    $serverOutput = Join-Path $payload 'server/.output'
    if (Test-Path $serverOutput) { Remove-Item $serverOutput -Recurse -Force }
    Copy-Item '.output' $serverOutput -Recurse
    if (Get-ChildItem $serverOutput -Filter '*.node' -Recurse) { throw 'WEB contains native Windows modules. Build the native module for Windows before packaging.' }

    # Download the official Windows runtime and verify its published checksum.
    $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt").Content
    $archiveName="node-v$NodeVersion-win-x64.zip"
    $match = [regex]::Match($sums, '(?m)^([0-9a-f]{64})\s+'+[regex]::Escape($archiveName)+'\s*$')
    if (!$match.Success) { throw 'Official Node.js Windows runtime not found' }
    $zip = Join-Path $destination $archiveName
    if(!(Test-Path $zip)){Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$NodeVersion/$archiveName" -OutFile $zip}
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) { throw 'Node.js SHA-256 mismatch' }
    $staging = Join-Path $destination 'node-runtime'
    Expand-Archive $zip $staging -Force
    $nodeFolder = Get-Item (Join-Path $staging "node-v$NodeVersion-win-x64")
    New-Item -ItemType Directory -Force (Join-Path $payload 'runtime') | Out-Null
    Copy-Item (Join-Path $nodeFolder.FullName 'node.exe') (Join-Path $payload 'runtime/node.exe')
    Copy-Item (Join-Path $nodeFolder.FullName 'LICENSE') (Join-Path $payload 'runtime/LICENSE')
    Copy-Item 'LICENSE' $payload
    Copy-Item 'packaging/windows/configure-firewall.ps1' $payload
    $bundleSource = if ($Ps5Bundle) { $Ps5Bundle } else { '-' }
    & node 'scripts/package-console-bundle.mjs' $bundleSource (Join-Path $payload 'console-setup')
    if ($LASTEXITCODE) { throw 'PS5 release bundle validation failed' }
    @{version=$Version} | ConvertTo-Json | Set-Content (Join-Path $payload 'release.json') -Encoding utf8
    # PDBs are build artifacts; the installed application needs no SDK.
    Get-ChildItem $payload -Filter '*.pdb' | Remove-Item
    & node scripts/check-windows-payload.mjs $payload $Version
    if ($LASTEXITCODE) { throw 'Windows payload audit failed' }
    if (!$SkipInstaller) {
        $compiler = (Get-Command makensis.exe -ErrorAction SilentlyContinue).Source
        if (!$compiler) { $compiler = "${env:ProgramFiles(x86)}/NSIS/makensis.exe" }
        $installer = Join-Path $destination "PackageFlowSetup-$Version-x64.exe"
        foreach ($required in @('PackageFlow.exe', 'runtime/node.exe', 'server/.output/server/index.mjs', 'release.json')) {
            if (!(Test-Path -LiteralPath (Join-Path $payload $required) -PathType Leaf)) { throw "Installer payload is incomplete: $required" }
        }
        & $compiler /INPUTCHARSET UTF8 "/DVERSION=$Version" "/DPAYLOAD=$payload" "/DOUTPUT=$installer" 'packaging/windows/installer.nsi'
        if ($LASTEXITCODE) { throw 'Setup.exe build failed' }
        Get-FileHash $installer -Algorithm SHA256 | Format-List
    }
}
finally { Pop-Location; if (Test-Path $buildTemp) { Remove-Item $buildTemp -Recurse -Force } }

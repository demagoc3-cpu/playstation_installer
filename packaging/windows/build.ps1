param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '0.1.7',
    [string]$DockerImage = 'demagoc3/packageflow:latest',
    [switch]$SkipWebBuild,
    [switch]$SkipInstaller
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$destination = Join-Path $repo 'dist/windows'
$payload = Join-Path $destination 'payload'
New-Item -ItemType Directory -Force $payload | Out-Null
Push-Location $repo
try {
    if (!$SkipWebBuild) {
        & npm.cmd ci --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE) { throw 'Dependency installation failed' }
        & npm.cmd run build
        if ($LASTEXITCODE) { throw 'WEB build failed' }
    }
    & dotnet run --project apps/windows-launcher/PackageFlow.Core.Tests -c Release
    if ($LASTEXITCODE) { throw 'Windows core tests failed' }
    & dotnet publish apps/windows-launcher/PackageFlow.Windows -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true "-p:Version=$Version" -o $payload
    if ($LASTEXITCODE) { throw 'Windows launcher build failed' }
    New-Item -ItemType Directory -Force (Join-Path $payload 'server') | Out-Null
    $serverOutput = Join-Path $payload 'server/.output'
    if (Test-Path $serverOutput) { Remove-Item $serverOutput -Recurse -Force }
    Copy-Item '.output' $serverOutput -Recurse
    if (Get-ChildItem $serverOutput -Filter '*.node' -Recurse) { throw 'WEB contains native Windows modules. Build a separate Linux distribution for Compose before packaging.' }
    New-Item -ItemType Directory -Force (Join-Path $payload 'compose') | Out-Null
    Copy-Item 'packaging/compose/Dockerfile' (Join-Path $payload 'compose/Dockerfile')
    Copy-Item 'packaging/compose/Dockerfile.dockerignore' (Join-Path $payload 'compose/Dockerfile.dockerignore')

    # Download the official Windows runtime and verify its published checksum.
    $sums = (Invoke-WebRequest 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt').Content
    $match = [regex]::Match($sums, '(?m)^([0-9a-f]{64})\s+(node-v22\.\d+\.\d+-win-x64\.zip)\s*$')
    if (!$match.Success) { throw 'Official Node.js Windows runtime not found' }
    $zip = Join-Path $destination $match.Groups[2].Value
    Invoke-WebRequest "https://nodejs.org/dist/latest-v22.x/$($match.Groups[2].Value)" -OutFile $zip
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $match.Groups[1].Value) { throw 'Node.js SHA-256 mismatch' }
    $staging = Join-Path $destination 'node-runtime'
    Expand-Archive $zip $staging -Force
    $nodeFolder = Get-ChildItem $staging -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force (Join-Path $payload 'runtime') | Out-Null
    Copy-Item (Join-Path $nodeFolder.FullName 'node.exe') (Join-Path $payload 'runtime/node.exe')
    Copy-Item (Join-Path $nodeFolder.FullName 'LICENSE') (Join-Path $payload 'runtime/LICENSE')
    Copy-Item 'LICENSE' $payload
    Copy-Item 'packaging/windows/configure-firewall.ps1' $payload
    @{version=$Version;dockerImage=$DockerImage} | ConvertTo-Json | Set-Content (Join-Path $payload 'release.json') -Encoding utf8
    # PDBs are build artifacts; the installed application needs no SDK.
    Get-ChildItem $payload -Filter '*.pdb' | Remove-Item
    if (!$SkipInstaller) {
        $compiler = (Get-Command makensis.exe -ErrorAction SilentlyContinue).Source
        if (!$compiler) { $compiler = "${env:ProgramFiles(x86)}/NSIS/makensis.exe" }
        $installer = Join-Path $destination "PackageFlowSetup-$Version-x64.exe"
        foreach ($required in @('PackageFlow.exe', 'runtime/node.exe', 'server/.output/server/index.mjs', 'compose/Dockerfile', 'release.json')) {
            if (!(Test-Path -LiteralPath (Join-Path $payload $required) -PathType Leaf)) { throw "Installer payload is incomplete: $required" }
        }
        & $compiler /INPUTCHARSET UTF8 "/DVERSION=$Version" "/DPAYLOAD=$payload" "/DOUTPUT=$installer" 'packaging/windows/installer.nsi'
        if ($LASTEXITCODE) { throw 'Setup.exe build failed' }
        Get-FileHash $installer -Algorithm SHA256 | Format-List
    }
}
finally { Pop-Location }

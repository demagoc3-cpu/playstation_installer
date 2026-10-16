#Requires -Version 5.1
# Inspect is the default; no launcher/PS5 update is performed.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$InstallDirectory,
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ArchiveSha256,
    [string]$SettingsPath = (Join-Path $env:LOCALAPPDATA 'PackageFlow\launcher.json'),
    [ValidateSet('Inspect','Apply','Rollback')][string]$Mode = 'Inspect',
    [string[]]$ProbePath = @(),
    [switch]$Execute
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2
if (($Mode -eq 'Inspect' -and $Execute) -or ($Mode -ne 'Inspect' -and !$Execute)) {
    throw 'Apply/Rollback require -Execute; Inspect never accepts it.'
}

function File-Hash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path); $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
function Text-Hash([string]$Value) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Safe-Relative([string]$Value) {
    if (!$Value -or $Value.Length -gt 220) { throw 'Invalid relative file path' }
    foreach ($part in $Value.Split('/')) {
        if (!$part -or $part -in @('.','..') -or $part -match '[<>:"\\|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$') { throw 'Unsafe relative Windows path' }
    }
    return $Value
}
function Assert-NoLinks([string]$Path) {
    $part = [IO.Path]::GetFullPath($Path)
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            if ((Get-Item -Force -LiteralPath $part).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not permitted' }
        }
        $parent = [IO.Path]::GetDirectoryName($part)
        if ($part -eq $parent) { break }; $part = $parent
    }
}
function Paths-Overlap([string]$First, [string]$Second) {
    $firstPath=[IO.Path]::GetFullPath($First).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
    $secondPath=[IO.Path]::GetFullPath($Second).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
    return $firstPath.StartsWith($secondPath,[StringComparison]::OrdinalIgnoreCase) -or $secondPath.StartsWith($firstPath,[StringComparison]::OrdinalIgnoreCase)
}
function Assert-File($Path, $Record) {
    Assert-NoLinks $Path
    $item = Get-Item -Force -LiteralPath $Path
    if ($item.PSIsContainer -or $item.Length -ne $Record.size -or (File-Hash $Path) -cne $Record.sha256) { throw ('File identity mismatch: '+$Path) }
}
function Validate-Records($Records, [switch]$Web) {
    $seen = @{}
    if (@($Records).Count -eq 0) { throw 'Missing file inventory' }
    foreach ($record in $Records) {
        $name = Safe-Relative $record.path
        if ($seen.ContainsKey($name) -or $record.size -isnot [ValueType] -or $record.size -lt 0 -or $record.size -gt 157286400 -or [decimal]$record.size -ne [long]$record.size -or $record.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid or duplicate file identity' }
        $seen[$name] = $record
    }
    foreach ($name in $seen.Keys) {
        $parts = $name.Split('/')
        for ($n=1; $n -lt $parts.Length; $n++) { if ($seen.ContainsKey(($parts[0..($n-1)] -join '/'))) { throw 'File/directory path conflict' } }
    }
    if ($Web -and !$seen.ContainsKey('server/index.mjs')) { throw 'Missing WEB entry point' }
}
function Tree-Hash($Records) {
    $lookup = @{}; foreach ($record in $Records) { $lookup[$record.path] = $record }
    [string[]]$names = @($lookup.Keys); [Array]::Sort($names, [StringComparer]::Ordinal)
    $text = New-Object Text.StringBuilder
    foreach ($name in $names) { $record = $lookup[$name]; [void]$text.Append($name+"`t"+([long]$record.size).ToString([Globalization.CultureInfo]::InvariantCulture)+"`t"+$record.sha256+"`n") }
    return Text-Hash $text.ToString()
}
function Assert-Tree([string]$Root, $Identity) {
    Assert-NoLinks $Root
    $actual = @(Get-ChildItem -Force -LiteralPath $Root -Recurse)
    foreach ($item in $actual) { if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked WEB entry' } }
    if (@($actual | Where-Object { !$_.PSIsContainer }).Count -ne @($Identity.files).Count) { throw 'WEB file inventory differs' }
    foreach ($record in $Identity.files) { Assert-File (Join-Path $Root $record.path) $record }
}
function Save-Journal([string]$State) {
    $script:journal.state = $State; $script:journal.updatedUtc = [DateTime]::UtcNow.ToString('o')
    $temp = $script:journalPath+'.tmp'
    Assert-NoLinks $temp; Assert-NoLinks $script:journalPath
    [IO.File]::WriteAllText($temp, ($script:journal | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
    $stream = [IO.File]::Open($temp, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { $stream.Flush($true) } finally { $stream.Dispose() }
    Move-Item -Force -LiteralPath $temp -Destination $script:journalPath
}
function Desktop-Request([string]$Method, [string]$Route) {
    # Fixed loopback routes only. This updater never calls a console API.
    if ($Route -notin @('/api/desktop/status','/api/desktop/prepare-stop','/')) { throw 'Invalid updater route' }
    $request = [Net.HttpWebRequest]::Create('http://127.0.0.1:'+$script:settings.Port+$Route)
    $request.Proxy=$null; $request.Method=$Method; $request.Timeout=5000; $request.ReadWriteTimeout=5000; $request.KeepAlive=$false
    $request.Headers['X-PackageFlow-Launcher-Key']=$script:launcherKey
    if ($Method -eq 'POST') { $request.ContentLength=0 }
    $response=$null; $reader=$null
    try {
        $response=$request.GetResponse(); $reader=New-Object IO.StreamReader($response.GetResponseStream())
        $body=$reader.ReadToEnd()
        if ($Route -ne '/') { $body=$body | ConvertFrom-Json }
        return @{ status=[int]$response.StatusCode; body=$body }
    } finally { if ($reader) { $reader.Dispose() }; if ($response) { $response.Close() } }
}
function Owned-Node([int]$NodeId, [string]$Creation='') {
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$NodeId)
    if (!$process -or $process.ExecutablePath -ine $script:nodeExe -or !$process.CommandLine.Contains($script:entry) -or $process.SessionId -ne $script:sessionId) { throw 'Node identity or interactive session differs' }
    $owner=Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $script:userSid) { throw 'Node user differs' }
    if ($Creation -and $process.CreationDate.ToUniversalTime().ToString('o') -ne $Creation) { throw 'Node PID was reused' }
    return $process
}
function Current-Node {
    $reply=Desktop-Request 'GET' '/api/desktop/status'
    if ($reply.status -ne 200 -or $reply.body.application -ne 'PackageFlow' -or !$reply.body.processId) { throw 'Owned WEB status not confirmed' }
    return Owned-Node $reply.body.processId
}
function Stop-OwnedNode($Process) {
    $reply=Desktop-Request 'GET' '/api/desktop/status'
    if ($reply.body.application -ne 'PackageFlow' -or $reply.body.processId -ne $Process.ProcessId) { throw 'WEB changed before stop' }
    $drain=Desktop-Request 'POST' '/api/desktop/prepare-stop'
    if ($drain.status -ne 200 -or $drain.body.busy -isnot [bool] -or $drain.body.busy) { throw 'Standard WEB stop guard reports busy; no forced stop' }
    $lease=[Diagnostics.Stopwatch]::StartNew()
    $exact=Owned-Node $Process.ProcessId $Process.CreationDate.ToUniversalTime().ToString('o')
    if ($lease.Elapsed.TotalSeconds -gt 10) { throw 'Stop lease expired' }
    $owned=[Diagnostics.Process]::GetProcessById($exact.ProcessId)
    $script:killAttempted=$true
    $owned.Kill()
    if (!$owned.WaitForExit(5000)) { throw 'Owned WEB exit not confirmed' }
}
function Start-Web {
    $names=@('NODE_ENV','HOST','PORT','PACKAGEFLOW_DATA_DIR','PACKAGEFLOW_PAYLOAD_PORT','PACKAGEFLOW_PUBLIC_PORT','PACKAGEFLOW_LAUNCHER_KEY','PACKAGEFLOW_HOST_IP')
    $previous=@{}; foreach ($name in $names) { $previous[$name]=[Environment]::GetEnvironmentVariable($name,'Process') }
    try {
        $env:NODE_ENV='production'; $env:HOST='0.0.0.0'; $env:PORT=[string]$script:settings.Port
        $env:PACKAGEFLOW_DATA_DIR=$script:dataDirectory; $env:PACKAGEFLOW_PAYLOAD_PORT=[string]$script:settings.PayloadPort; $env:PACKAGEFLOW_PUBLIC_PORT=[string]$script:settings.Port
        $env:PACKAGEFLOW_LAUNCHER_KEY=$script:launcherKey; $env:PACKAGEFLOW_HOST_IP=$script:settings.HostIp
        $probeOutput=Join-Path $script:backupDirectory ('node-context-'+[Guid]::NewGuid().ToString('N')+'.json')
        $probeFile=$probeOutput+'.cjs'
        $configuration=@{output=$probeOutput;paths=@($ProbePath)} | ConvertTo-Json -Compress
        $probeCode='const fs=require("node:fs");const c='+$configuration+';fs.writeFileSync(c.output,JSON.stringify({pid:process.pid,dataDirectory:process.env.PACKAGEFLOW_DATA_DIR,paths:c.paths.map(path=>{try{const s=fs.statSync(path);return{path,exists:true,size:s.size}}catch{return{path,exists:false}}})}));'
        [IO.File]::WriteAllText($probeFile,$probeCode,(New-Object Text.UTF8Encoding($false)))
        $started=Start-Process -FilePath $script:nodeExe -ArgumentList @('-r',('"'+$probeFile+'"'),('"'+$script:entry+'"')) -WorkingDirectory (Join-Path $InstallDirectory 'server') -WindowStyle Hidden -PassThru
        $script:startedNode=$started
    } finally { foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') } }
    for ($n=0; $n -lt 40; $n++) {
        if ($started.HasExited) { throw 'Replacement WEB exited' }
        try {
            $reply=Desktop-Request 'GET' '/api/desktop/status'; $page=Desktop-Request 'GET' '/'
            if ($reply.body.application -eq 'PackageFlow' -and $reply.body.processId -eq $started.Id -and $page.status -eq 200) {
                $null=Owned-Node $started.Id
                $probe=Get-Content -LiteralPath $probeOutput -Raw | ConvertFrom-Json
                if ($probe.pid -ne $started.Id -or $probe.dataDirectory -ine $script:dataDirectory -or @($probe.paths | Where-Object { !$_.exists }).Count) { throw 'Replacement Node data directory or source access differs' }
                return $started.Id
            }
        } catch { if ($n -eq 39) { throw } }
        Start-Sleep -Milliseconds 500
    }
    throw 'Replacement WEB HTTP validation failed'
}
function State-Hashes {
    $result=@{}
    $result[$SettingsPath]=File-Hash $SettingsPath
    foreach ($file in Get-ChildItem -Force -LiteralPath $script:dataDirectory -Recurse -File -Filter '*.json') {
        if (!$file.FullName.StartsWith($script:artifactDirectory+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
            Assert-NoLinks $file.FullName; $result[$file.FullName]=File-Hash $file.FullName
        }
    }
    return $result
}
function State-Differences($Before) {
    $different=@()
    foreach ($path in $Before.Keys) { if (!(Test-Path -LiteralPath $path) -or (File-Hash $path) -cne $Before[$path]) { $different+= $path } }
    return $different
}
function Set-ServiceManifest([string]$Source) {
    Assert-NoLinks $script:activeManifest; Assert-NoLinks ($script:activeManifest+'.tmp')
    if ($Source) {
        Copy-Item -LiteralPath $Source -Destination ($script:activeManifest+'.tmp')
        Move-Item -Force -LiteralPath ($script:activeManifest+'.tmp') -Destination $script:activeManifest
    } elseif (Test-Path -LiteralPath $script:activeManifest) {
        Remove-Item -LiteralPath $script:activeManifest
    }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.Security
$InstallDirectory=[IO.Path]::GetFullPath($InstallDirectory)
$SettingsPath=[IO.Path]::GetFullPath($SettingsPath)
Assert-NoLinks $InstallDirectory; Assert-NoLinks $SettingsPath
if ((File-Hash $Archive) -cne $ArchiveSha256) { throw 'Patch archive SHA256 differs' }
$zip=[IO.Compression.ZipFile]::OpenRead($Archive)
$staging=Join-Path $env:TEMP ('PackageFlow-web-patch-'+[Guid]::NewGuid().ToString('N'))
$stopped=$false; $moved=$false; $manifestChanged=$false; $startedNode=$null; $journal=$null; $journalOwned=$false; $installLock=$null; $killAttempted=$false
try {
    # Validate names and bounds BEFORE extracting any entry.
    $entries=@{}; [long]$total=0
    foreach ($zipEntry in $zip.Entries) {
        $name=Safe-Relative $zipEntry.FullName
        if ($entries.ContainsKey($name) -or $zipEntry.Length -gt 157286400) { throw 'Duplicate or oversized ZIP entry' }
        $entries[$name]=$zipEntry; $total+=$zipEntry.Length
    }
    if ($entries.Count -gt 20000 -or $total -gt 536870912 -or !$entries.ContainsKey('patch-manifest.json') -or $entries['patch-manifest.json'].Length -gt 16777216) { throw 'Invalid patch bounds' }
    $reader=New-Object IO.StreamReader($entries['patch-manifest.json'].Open())
    try { $patch=$reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($patch.schemaVersion -ne 1 -or $patch.kind -cne 'PackageFlowInstalledWindowsWebPatch' -or $patch.sourceCommit -cnotmatch '^[a-f0-9]{40}$' -or $patch.patchId -cnotmatch '^[a-f0-9]{12}-[a-f0-9]{12}-[a-f0-9]{12}$') { throw 'Invalid patch identity' }
    Validate-Records $patch.files; Validate-Records $patch.web.files -Web; Validate-Records $patch.base.web.files -Web
    if ($patch.base.kind -cne 'PackageFlowInstalledWindowsBase' -or $patch.base.schemaVersion -ne 1 -or (Tree-Hash $patch.web.files) -cne $patch.web.treeSha256 -or (Tree-Hash $patch.base.web.files) -cne $patch.base.web.treeSha256 -or $entries.Count -ne @($patch.files).Count+1) { throw 'Invalid patch inventory' }
    $elf=$patch.service.elf
    if ($patch.service.schemaVersion -ne 1 -or $elf.fileName -cne 'PackageFlowService-PS5.elf' -or $elf.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $elf.size -lt 4096 -or $elf.size -gt 4194304 -or $elf.firmware -cne '13.60' -or $elf.version -cnotmatch '^\d+\.\d+\.\d+(?:-dev)?$' -or $elf.buildId -cnotmatch '^[a-z0-9-]{1,64}$') { throw 'Invalid service artifact' }
    if ($patch.patchId -cne ($patch.sourceCommit.Substring(0,12)+'-'+$elf.sha256.Substring(0,12)+'-'+$patch.web.treeSha256.Substring(0,12))) { throw 'Patch ID does not bind its source, WEB and service' }
    $artifactRelative='ps5-service-artifacts/'+$elf.sha256+'/'+$elf.fileName
    $approved=@{}; foreach ($record in $patch.web.files) { $approved['web/'+$record.path]=$record }
    foreach ($record in $patch.files) {
        if (!$entries.ContainsKey($record.path) -or $entries[$record.path].Length -ne $record.size) { throw 'ZIP inventory differs' }
        if ($record.path.StartsWith('web/')) {
            if (!$approved.ContainsKey($record.path) -or $record.sha256 -cne $approved[$record.path].sha256 -or $record.size -ne $approved[$record.path].size) { throw 'WEB inventories differ' }
            $approved.Remove($record.path)
        } elseif ($record.path -cnotin @('ps5-service-artifacts/manifest.json',$artifactRelative,'update-installed-windows-web.ps1')) { throw 'Unexpected patch payload' }
    }
    if ($approved.Count -or !$entries.ContainsKey($artifactRelative) -or !$entries.ContainsKey('ps5-service-artifacts/manifest.json')) { throw 'Incomplete patch payload' }
    $null=New-Item -ItemType Directory -Path $staging
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $acl.SetAccessRuleProtection($true,$false)
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($userSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule); Set-Acl -LiteralPath $staging -AclObject $acl
    foreach ($record in $patch.files) {
        $destination=Join-Path $staging $record.path
        $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[$record.path],$destination,$false)
        Assert-File $destination $record
    }
    $serviceFile=Join-Path $staging $artifactRelative
    Assert-File $serviceFile $elf
    $header=[IO.File]::ReadAllBytes($serviceFile)
    if ([BitConverter]::ToString($header[0..5]) -cne '7F-45-4C-46-02-01' -or $header[18] -ne 62 -or $header[19] -ne 0) { throw 'Service is not ELF x64' }
    $serviceManifest=Get-Content -LiteralPath (Join-Path $staging 'ps5-service-artifacts/manifest.json') -Raw | ConvertFrom-Json
    foreach ($field in @('fileName','size','sha256','version','buildId','firmware')) { if ($serviceManifest.elf.$field -cne $elf.$field) { throw 'Service manifests differ' } }
    if ($serviceManifest.schemaVersion -ne 1) { throw 'Service schema differs' }
    $launcher=Join-Path $InstallDirectory 'PackageFlow.exe'; $nodeExe=Join-Path $InstallDirectory 'runtime\node.exe'
    Assert-File $launcher $patch.base.launcher; Assert-File $nodeExe $patch.base.node
    if ((Get-Item -LiteralPath $launcher).VersionInfo.FileVersion -cne $patch.base.launcher.version) { throw 'Launcher FileVersion differs' }
    $output=Join-Path $InstallDirectory 'server\.output'; $entry=Join-Path $output 'server\index.mjs'
    $settings=Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
    $settingsSha256=File-Hash $SettingsPath
    if ($settings.Mode -ne 'native' -or $settings.LegacyMigrationRequired -or $settings.Port -lt 1024 -or $settings.Port -gt 65535) { throw 'Unsupported launcher configuration' }
    if ($settings.WebDataDirectory -and ![IO.Path]::IsPathRooted($settings.WebDataDirectory)) { throw 'Relative WEB data directory is not supported' }
    $dataDirectory=if ($settings.WebDataDirectory) { [IO.Path]::GetFullPath($settings.WebDataDirectory) } else { Join-Path ([IO.Path]::GetDirectoryName($SettingsPath)) 'data\web' }
    Assert-NoLinks $dataDirectory
    $artifactDirectory=Join-Path $dataDirectory 'ps5-service-artifacts'; $activeManifest=Join-Path $artifactDirectory 'manifest.json'
    Assert-NoLinks $artifactDirectory
    $backupDirectory=Join-Path $InstallDirectory ('.web-patch-backups\'+$patch.patchId)
    if ((Paths-Overlap $dataDirectory $output) -or (Paths-Overlap $dataDirectory $backupDirectory)) { throw 'Persistent data overlaps replaceable WEB or rollback storage' }
    Assert-NoLinks $backupDirectory
    $journalPath=Join-Path $backupDirectory 'journal.json'; $backupWeb=Join-Path $backupDirectory 'web'; $backupManifest=Join-Path $backupDirectory 'manifest.before'
    $launcherKey=[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($settings.ProtectedLauncherKey),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))
    $sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($sessionId -eq 0) { throw 'Run in the existing interactive user session, not an SSH/service session' }
    $current=Current-Node
    if ($Mode -ne 'Inspect') {
        $lockPath=Join-Path $InstallDirectory '.web-patch.lock'; Assert-NoLinks $lockPath
        $installLock=[IO.File]::Open($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    }
    if ($Mode -eq 'Rollback') {
        Assert-NoLinks $backupDirectory
        $journal=Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json
        if ($journal.patchArchiveSha256 -cne $ArchiveSha256 -or $journal.userSid -ne $userSid -or $journal.dataDirectory -ine $dataDirectory -or $journal.state -ne 'applied') { throw 'Rollback requires the matching applied journal; uncertain results need reconciliation' }
        Assert-Tree $backupWeb $patch.base.web; Assert-Tree $output $patch.web
        if ((File-Hash $activeManifest) -cne (File-Hash (Join-Path $staging 'ps5-service-artifacts/manifest.json'))) { throw 'Active service artifact changed after this patch' }
        if ($journal.hadServiceManifest) { Assert-File $backupManifest $journal.oldManifest }
        if ((File-Hash $SettingsPath) -cne $settingsSha256) { throw 'Launcher settings changed during inspection' }
        $journalOwned=$true; Save-Journal 'rollback-stopping'; Stop-OwnedNode $current; $stopped=$true
        Move-Item -LiteralPath $output -Destination (Join-Path $backupDirectory 'rolled-back-web')
        Move-Item -LiteralPath $backupWeb -Destination $output
        if ($journal.hadServiceManifest) { Set-ServiceManifest $backupManifest } else { Set-ServiceManifest '' }
        $null=Start-Web; $stopped=$false; Save-Journal 'rolled-back'
    } else {
        Assert-Tree $output $patch.base.web
        if (Test-Path -LiteralPath $backupDirectory) { throw 'Patch journal/backup already exists; never automatically replay' }
        foreach ($path in $ProbePath) { if (!(Test-Path -LiteralPath $path)) { throw 'Baseline source probe is unavailable' } }
        if ($Mode -eq 'Inspect') {
            @{state='inspected';patchId=$patch.patchId;sourceCommit=$patch.sourceCommit;webFiles=@($patch.web.files).Count;elfSha256=$elf.sha256;nodePid=$current.ProcessId;sessionId=$sessionId;dataDirectory=$dataDirectory;runtimeChanged=$false} | ConvertTo-Json -Compress
        } else {
            $null=[IO.Directory]::CreateDirectory($backupDirectory)
            Set-Acl -LiteralPath $backupDirectory -AclObject $acl
            $hadManifest=Test-Path -LiteralPath $activeManifest
            $oldManifest=$null
            if ($hadManifest) { Assert-NoLinks $activeManifest; Copy-Item -LiteralPath $activeManifest -Destination $backupManifest; $oldManifest=@{size=(Get-Item $backupManifest).Length;sha256=(File-Hash $backupManifest)} }
            $journal=@{state='prepared';updatedUtc='';patchId=$patch.patchId;patchArchiveSha256=$ArchiveSha256;userSid=$userSid;sessionId=$sessionId;dataDirectory=$dataDirectory;hadServiceManifest=$hadManifest;oldManifest=$oldManifest;oldNodePid=$current.ProcessId;newNodePid=0;stateDifferences=@()}
            $journalOwned=$true
            Save-Journal 'prepared'
            # Write verified bytes before publishing the authoritative manifest.
            $null=[IO.Directory]::CreateDirectory($artifactDirectory)
            $hashDirectory=Join-Path $artifactDirectory $elf.sha256
            if (Test-Path -LiteralPath $hashDirectory) { Assert-File (Join-Path $hashDirectory $elf.fileName) $elf }
            else {
                $incoming=Join-Path $artifactDirectory ('.incoming-'+[Guid]::NewGuid().ToString('N'))
                $null=[IO.Directory]::CreateDirectory($incoming)
                Copy-Item -LiteralPath $serviceFile -Destination (Join-Path $incoming $elf.fileName)
                Assert-File (Join-Path $incoming $elf.fileName) $elf
                Move-Item -LiteralPath $incoming -Destination $hashDirectory
            }
            if ((File-Hash $SettingsPath) -cne $settingsSha256) { throw 'Launcher settings changed during preparation' }
            Save-Journal 'stopping'; Stop-OwnedNode $current; $stopped=$true
            $stateBefore=State-Hashes
            Assert-Tree $output $patch.base.web
            Move-Item -LiteralPath $output -Destination $backupWeb; $moved=$true
            # Copy across volumes; the original tree stays backed up on the install volume.
            Copy-Item -LiteralPath (Join-Path $staging 'web') -Destination $output -Recurse
            Assert-Tree $output $patch.web
            Set-ServiceManifest (Join-Path $staging 'ps5-service-artifacts/manifest.json'); $manifestChanged=$true
            if (@(State-Differences $stateBefore).Count) { throw 'Persistent JSON/settings changed while WEB was stopped' }
            Save-Journal 'starting'; $journal.newNodePid=Start-Web; $stopped=$false
            $journal.stateDifferences=@(State-Differences $stateBefore)
            Save-Journal 'applied'
        }
    }
    if ($Mode -ne 'Inspect') { @{state=$journal.state;patchId=$patch.patchId;backup=$backupDirectory;newNodePid=$journal.newNodePid;stateDifferences=$journal.stateDifferences;launcherReplaced=$false;ps5Commands=$false} | ConvertTo-Json -Depth 5 -Compress }
} catch {
    $failure=$_.Exception.Message
    if ($Mode -eq 'Apply' -and $journal -and ($stopped -or $moved)) {
        try {
            if ($startedNode -and !$startedNode.HasExited) { $replacement=Current-Node; if ($replacement.ProcessId -ne $startedNode.Id) { throw 'Replacement identity changed' }; Stop-OwnedNode $replacement }
            if ($moved) {
                if (Test-Path -LiteralPath $output) { Move-Item -LiteralPath $output -Destination (Join-Path $backupDirectory 'failed-web') }
                Move-Item -LiteralPath $backupWeb -Destination $output
            }
            if ($manifestChanged) { if ($journal.hadServiceManifest) { Set-ServiceManifest $backupManifest } else { Set-ServiceManifest '' } }
            Assert-Tree $output $patch.base.web
            $null=Start-Web; Save-Journal 'apply-failed-restored'
        } catch { Save-Journal 'needs-reconciliation'; throw ('Patch failed: '+$failure+'. Guarded rollback incomplete: '+$_.Exception.Message+'. No forced stop/replay was attempted.') }
    } elseif ($journalOwned) {
        if ($killAttempted) { Save-Journal 'needs-reconciliation' }
        elseif ($Mode -eq 'Apply') { Save-Journal 'not-applied' }
        else { Save-Journal 'applied' }
    }
    throw $failure
} finally {
    $zip.Dispose(); $launcherKey=$null
    if ($installLock) { $installLock.Dispose() }
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}

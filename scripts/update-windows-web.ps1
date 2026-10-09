param(
 [Parameter(Mandatory=$true)][string]$Root,
 [Parameter(Mandatory=$true)][string]$TaskName,
 [Parameter(Mandatory=$true)][string]$Archive,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ArchiveSha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ServerSha256,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{7,40}$')][string]$Revision,
 [Parameter(Mandatory=$true)][string]$ConsoleId
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$node=Join-Path $Root 'runtime\node.exe'
$entry=Join-Path $Root 'web\server\index.mjs'
function AssertIdleQueues {
 foreach($file in @(Get-ChildItem (Join-Path $Root 'data') -Recurse -File -Filter '*installation-queue.json')) {
  $q=Get-Content -Raw $file.FullName|ConvertFrom-Json
  if($q.status -notin @('idle','completed','failed','cancelled')){throw 'An installation queue is active; postpone WEB replacement'}
  if(@($q.items|Where-Object {$_.state -notin @('installed','failed','skipped','cancelled')}).Count -gt 0){throw 'Unresolved installation items; postpone WEB replacement'}
 }
}
function OwnListener {
 $listeners=@(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
 if($listeners.Count -ne 1){throw 'Unexpected WEB listener'}
 $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+$listeners[0].OwningProcess)
 if($process.ExecutablePath -ne $node -or $process.CommandLine -notlike ('*'+$entry+'*')){throw 'Listener does not belong to the managed WEB'}
 return $process
}
if((Get-FileHash $Archive).Hash.ToLower() -ne $ArchiveSha256){throw 'Archive mismatch'}
AssertIdleQueues
$before=Invoke-RestMethod ('http://127.0.0.1:3000/api/catalog/v2?consoleId='+$ConsoleId+'&limit=10') -TimeoutSec 15
$owner=OwnListener
$backup=Join-Path $Root ('web-backup-before-'+$Revision)
$stage=Join-Path $Root ('update-'+$Revision)
if((Test-Path $backup) -or (Test-Path $stage)){throw 'Reserved update paths already exist'}
Expand-Archive $Archive -DestinationPath $stage
if((Get-FileHash (Join-Path $stage 'web\server\index.mjs')).Hash.ToLower() -ne $ServerSha256){throw 'Extracted server mismatch'}
AssertIdleQueues
$owner=OwnListener
Stop-ScheduledTask -TaskName $TaskName
Start-Sleep -Milliseconds 500
if(Get-Process -Id $owner.ProcessId -ErrorAction SilentlyContinue){Stop-Process -Id $owner.ProcessId -Force}
Move-Item (Join-Path $Root 'web') $backup
try {
 Move-Item (Join-Path $stage 'web') (Join-Path $Root 'web')
 Start-ScheduledTask -TaskName $TaskName
 $ready=$false
 for($i=0;$i -lt 20;$i++){
  Start-Sleep -Milliseconds 500
  try{$home=Invoke-WebRequest 'http://127.0.0.1:3000/' -UseBasicParsing -TimeoutSec 3;if($home.StatusCode -eq 200 -and $home.Content -match 'PackageFlow'){$ready=$true;break}}catch{}
 }
 if(-not $ready){throw 'Updated WEB is unavailable'}
 $catalog=Invoke-RestMethod ('http://127.0.0.1:3000/api/catalog/v2?consoleId='+$ConsoleId+'&limit=10') -TimeoutSec 15
 if($catalog.total -ne $before.total -or @($catalog.games).Count -ne @($before.games).Count){throw 'Library changed unexpectedly'}
 $updates=Invoke-RestMethod ('http://127.0.0.1:3000/api/consoles/service-update?consoleId='+$ConsoleId) -TimeoutSec 5
 Copy-Item (Join-Path $stage 'release.json') (Join-Path $Root 'release.json')
 [ordered]@{source=$Revision;http=$home.StatusCode;total=$catalog.total;count=@($catalog.games).Count;currentService=$updates.current;backupPreserved=$true}|ConvertTo-Json -Compress
}catch{
 Stop-ScheduledTask -TaskName $TaskName
 Start-Sleep -Milliseconds 500
 try{$failedOwner=OwnListener;Stop-Process -Id $failedOwner.ProcessId -Force}catch{}
 if(Test-Path (Join-Path $Root 'web')){Move-Item (Join-Path $Root 'web') (Join-Path $Root ('web-failed-'+$Revision))}
 Move-Item $backup (Join-Path $Root 'web')
 Start-ScheduledTask -TaskName $TaskName
 throw
}

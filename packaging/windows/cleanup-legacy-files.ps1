param([Parameter(Mandatory=$true)][string]$InstallDirectory)
$ErrorActionPreference='Stop'
$pfRoot=[IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
if((Test-Path -LiteralPath $pfRoot) -and ((Get-Item -LiteralPath $pfRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Install directory is a link; legacy cleanup refused'}
$pfManifest=Get-Content (Join-Path $PSScriptRoot 'legacy-distributed-files.json') -Raw|ConvertFrom-Json
foreach($pfEntry in $pfManifest.PSObject.Properties) {
 $pfFile=Join-Path $InstallDirectory $pfEntry.Name
 if(Test-Path -LiteralPath $pfFile -PathType Leaf) {
  $pfParent=Split-Path -Parent $pfFile
  while($pfParent -and $pfParent -ne $pfRoot){if((Get-Item -LiteralPath $pfParent).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Legacy parent is a link; preserved'};$pfParent=Split-Path -Parent $pfParent}
  $pfItem=Get-Item -LiteralPath $pfFile
  if($pfItem.Attributes -band [IO.FileAttributes]::ReparsePoint){throw ('Legacy path is a link; preserved: '+$pfEntry.Name)}
  if($pfItem.Length -ne $pfEntry.Value.size -or (Get-FileHash -LiteralPath $pfFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pfEntry.Value.sha256){throw ('Legacy file differs from the known PackageFlow distribution; preserved: '+$pfEntry.Name)}
 }
}
# Verify all before removing any. No shared Runtime, volumes or Downloads paths are touched.
foreach($pfEntry in $pfManifest.PSObject.Properties) {
 $pfFile=Join-Path $InstallDirectory $pfEntry.Name
 if(Test-Path -LiteralPath $pfFile -PathType Leaf){Remove-Item -LiteralPath $pfFile -Force}
}
$pfOldFolder=Join-Path $InstallDirectory 'compose'
if((Test-Path -LiteralPath $pfOldFolder) -and !(Get-ChildItem -LiteralPath $pfOldFolder -Force|Select-Object -First 1)){Remove-Item -LiteralPath $pfOldFolder}

param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference='Stop'
$pfSignature=Get-AuthenticodeSignature -LiteralPath $Installer
if($pfSignature.Status -ne 'Valid' -or $pfSignature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') { throw 'Authenticode Runtime bootstrapper: Microsoft signature is not Valid. The file was not executed.' }
'Valid Microsoft Authenticode signature'

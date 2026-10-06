param([ValidateRange(1024,65535)][int]$WebPort = 3000, [ValidateRange(1024,65535)][int]$PayloadPort = 3001)
$ErrorActionPreference = 'Stop'
foreach ($rule in @(@{Name='PackageFlow-WEB';Port=$WebPort}, @{Name='PackageFlow-PS4-Callback';Port=$PayloadPort})) {
    $existing = Get-NetFirewallRule -Name $rule.Name -ErrorAction SilentlyContinue
    if ($existing) { $existing | Remove-NetFirewallRule }
    New-NetFirewallRule -Name $rule.Name -DisplayName $rule.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $rule.Port -Profile Private -RemoteAddress LocalSubnet | Out-Null
}
Write-Host 'PackageFlow: private LAN access configured.'

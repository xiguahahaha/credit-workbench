param(
  [string]$ProfileDir = (Join-Path $env:APPDATA 'com.qodercn.app.stable')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$statePath = Join-Path $ProfileDir 'Local State'
if (-not (Test-Path $statePath)) { throw 'Qoder Local State not found' }

$state = Get-Content $statePath -Raw | ConvertFrom-Json
$encrypted = [Convert]::FromBase64String($state.os_crypt.encrypted_key)
$wrapped = $encrypted[5..($encrypted.Length - 1)]
$key = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $wrapped,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Convert]::ToBase64String($key)

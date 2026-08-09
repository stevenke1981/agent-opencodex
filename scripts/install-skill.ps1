[CmdletBinding()]
param(
  [string]$Destination,
  [string]$Source,
  [string]$BackupDirectory,
  [switch]$Json
)

$ErrorActionPreference = "Stop"

function Get-NormalizedPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
}

function Assert-SafeDestination([string]$SourcePath, [string]$DestinationPath) {
  $root = [System.IO.Path]::GetPathRoot($DestinationPath).TrimEnd("\", "/")
  if ($DestinationPath.TrimEnd("\", "/") -eq $root) {
    throw "Refusing to install a skill at a filesystem root: $DestinationPath"
  }

  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  $separator = [System.IO.Path]::DirectorySeparatorChar
  if ($SourcePath.Equals($DestinationPath, $comparison) -or
      $DestinationPath.StartsWith("$SourcePath$separator", $comparison) -or
      $SourcePath.StartsWith("$DestinationPath$separator", $comparison)) {
    throw "Source and destination must not be the same directory or contain one another"
  }
}

function Assert-SeparatePaths([string]$FirstPath, [string]$SecondPath, [string]$Message) {
  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  $separator = [System.IO.Path]::DirectorySeparatorChar
  if ($FirstPath.Equals($SecondPath, $comparison) -or
      $FirstPath.StartsWith("$SecondPath$separator", $comparison) -or
      $SecondPath.StartsWith("$FirstPath$separator", $comparison)) {
    throw $Message
  }
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    return [System.BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Get-FileManifest([string]$Root) {
  $prefix = $Root.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
  return @(
    Get-ChildItem -LiteralPath $Root -File -Recurse | ForEach-Object {
      [pscustomobject]@{
        Path = $_.FullName.Substring($prefix.Length).Replace("\", "/")
        Sha256 = Get-Sha256 $_.FullName
        Bytes = $_.Length
      }
    } | Sort-Object Path
  )
}

function Compare-FileManifests([object[]]$Expected, [object[]]$Actual) {
  if ($Expected.Count -ne $Actual.Count) {
    throw "Installed file count mismatch: expected $($Expected.Count), got $($Actual.Count)"
  }
  for ($index = 0; $index -lt $Expected.Count; $index += 1) {
    if ($Expected[$index].Path -cne $Actual[$index].Path) {
      throw "Installed file tree mismatch at index $index"
    }
    if ($Expected[$index].Sha256 -cne $Actual[$index].Sha256) {
      throw "SHA-256 mismatch for $($Expected[$index].Path)"
    }
    if ($Expected[$index].Bytes -ne $Actual[$index].Bytes) {
      throw "Byte-size mismatch for $($Expected[$index].Path)"
    }
  }
}

if (-not $Source) {
  $Source = Join-Path $PSScriptRoot "..\skills\agent-opencodex"
}
if (-not $Destination) {
  if (-not $env:USERPROFILE) { throw "USERPROFILE is required when -Destination is omitted" }
  $Destination = Join-Path $env:USERPROFILE ".codex\skills\agent-opencodex"
}

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$destinationPath = Get-NormalizedPath $Destination
Assert-SafeDestination $sourcePath $destinationPath

if (-not (Test-Path -LiteralPath (Join-Path $sourcePath "SKILL.md") -PathType Leaf)) {
  throw "Source is not an Agent OpenCodex skill package: $sourcePath"
}
if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
  throw "Destination exists as a file: $destinationPath"
}

$parentPath = Split-Path -Parent $destinationPath
New-Item -ItemType Directory -Force -Path $parentPath | Out-Null
$backupParentPath = Split-Path -Parent $parentPath
if (-not $BackupDirectory) {
  if (-not $backupParentPath) { throw "-BackupDirectory is required for destination: $destinationPath" }
  $BackupDirectory = Join-Path $backupParentPath "skill-backups"
}
$backupDirectoryPath = Get-NormalizedPath $BackupDirectory
Assert-SafeDestination $sourcePath $backupDirectoryPath
Assert-SeparatePaths $destinationPath $backupDirectoryPath "Destination and backup directory must not contain one another"
New-Item -ItemType Directory -Force -Path $backupDirectoryPath | Out-Null

$operationId = "{0}-{1}-{2}" -f (Get-Date -Format "yyyyMMdd-HHmmssfff"), $PID, ([guid]::NewGuid().ToString("N").Substring(0, 8))
$destinationName = Split-Path -Leaf $destinationPath
$stagingPath = Join-Path $backupDirectoryPath "$destinationName.installing-$operationId"
$backupPath = if (Test-Path -LiteralPath $destinationPath) {
  Join-Path $backupDirectoryPath "$destinationName.backup-$operationId"
} else { $null }
$failedPath = Join-Path $backupDirectoryPath "$destinationName.failed-$operationId"
$destinationMoved = $false
$stagingMoved = $false

try {
  Copy-Item -LiteralPath $sourcePath -Destination $stagingPath -Recurse
  $sourceManifest = Get-FileManifest $sourcePath
  $stagingManifest = Get-FileManifest $stagingPath
  Compare-FileManifests $sourceManifest $stagingManifest

  if ($backupPath) {
    Move-Item -LiteralPath $destinationPath -Destination $backupPath
    $destinationMoved = $true
  }
  Move-Item -LiteralPath $stagingPath -Destination $destinationPath
  $stagingMoved = $true

  $installedManifest = Get-FileManifest $destinationPath
  Compare-FileManifests $sourceManifest $installedManifest

  $result = [ordered]@{
    ok = $true
    source = $sourcePath
    destination = $destinationPath
    backupDirectory = $backupDirectoryPath
    backup = $backupPath
    fileCount = $installedManifest.Count
    hashesVerified = $true
    files = $installedManifest
  }
  if ($Json) { $result | ConvertTo-Json -Depth 5 -Compress }
  else {
    Write-Output "Installed Agent OpenCodex skill at $destinationPath"
    Write-Output "Verified $($installedManifest.Count) file(s) with SHA-256"
    if ($backupPath) { Write-Output "Rollback backup: $backupPath" }
  }
} catch {
  $originalError = $_
  try {
    if ($stagingMoved -and (Test-Path -LiteralPath $destinationPath)) {
      Move-Item -LiteralPath $destinationPath -Destination $failedPath
    } elseif (Test-Path -LiteralPath $stagingPath) {
      Move-Item -LiteralPath $stagingPath -Destination $failedPath
    }
    if ($destinationMoved -and $backupPath -and (Test-Path -LiteralPath $backupPath) -and
        -not (Test-Path -LiteralPath $destinationPath)) {
      Move-Item -LiteralPath $backupPath -Destination $destinationPath
    }
  } catch {
    throw "Skill installation failed and rollback also failed. Original: $($originalError.Exception.Message); rollback: $($_.Exception.Message)"
  }
  throw "Skill installation failed; previous destination was preserved or restored. $($originalError.Exception.Message)"
}

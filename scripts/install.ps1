$ErrorActionPreference = "Stop"
$parts = (node -p "process.versions.node").Split(".")
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 20 -or ($major -eq 20 -and $minor -lt 11)) {
  throw "Node.js 20.11 or newer is required"
}
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
npm install -g $root
aocx version

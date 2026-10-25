# Push GearVane Wiki Pages
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools/push-wiki.ps1

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$wikiSrc = Join-Path $repoRoot "docs\wiki"
$wikiDir = Join-Path $env:TEMP "gearvane-wiki-sync"

Write-Host "Syncing GearVane Wiki..." -ForegroundColor Cyan

if (Test-Path $wikiDir) {
    Remove-Item -Path $wikiDir -Recurse -Force
}
New-Item -ItemType Directory -Path $wikiDir | Out-Null

Copy-Item -Path "$wikiSrc\*" -Destination $wikiDir -Recurse

Set-Location $wikiDir
git init -b master | Out-Null
git config user.name "Debarun1205"
git config user.email "debarunbanerjee1205@gmail.com"

git add .
git commit -m "docs(wiki): update official wiki documentation"

$token = (& gh auth token)
if ($token) {
    git remote add origin "https://x-access-token:$token@github.com/Debarun1205/GearVane.wiki.git"
} else {
    git remote add origin "https://github.com/Debarun1205/GearVane.wiki.git"
}

try {
    git push -u origin master --force
    Write-Host "Wiki successfully pushed to https://github.com/Debarun1205/GearVane/wiki" -ForegroundColor Green
} catch {
    Write-Host "Wiki push failed. Note: If the wiki was never initialized on GitHub, create the first page on https://github.com/Debarun1205/GearVane/wiki and then rerun this script." -ForegroundColor Yellow
}

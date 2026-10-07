# install-multitask.ps1 -- install dsh-multitask into a DSH profile from THIS checkout.
#
# ASCII-ONLY ON PURPOSE. Windows PowerShell 5.1 decodes a BOM-less .ps1 using the
# system ANSI code page, so ANY non-ASCII byte in this file becomes mojibake in
# the parsed string literals. That silently broke two earlier revisions:
#   rev 1 used box-drawing characters in its markers -> markers never matched.
#   rev 2 kept the raw Chinese workspace path in a variable -> still non-ASCII.
# Every byte below is 7-bit ASCII, and the entry URL is DERIVED from this
# script's own location instead of being written literally -- so the script
# works in any checkout path, including non-ASCII ones.
#
# WHEN TO USE THIS
#   End users do NOT need this script: install the published package instead
#   (the in-app Plugins page, or `dsh plugin add dsh-multitask`).
#   This script is for the DEVELOPER working from a source checkout, and for
#   any profile whose package manager refuses the write (the packaged desktop
#   app owns its own profile and rejects the CLI).
#
# Design:
#   - The package is referenced by an absolute file:// URL derived from
#     $PSScriptRoot: no pnpm install, nothing lands in node_modules.
#   - Only APPENDS a block to cordis.patch.yml; never rewrites existing content.
#   - Backs the file up, writes via temp file + verification + atomic replace,
#     and is idempotent.
#   - DSH watches this patch file and hot-reloads it; a failed reload only logs
#     a warning and keeps the running tree, so no restart is required.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-multitask.ps1
#   powershell -ExecutionPolicy Bypass -File install-multitask.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File install-multitask.ps1 -ProfileDir "C:\path\to\profile"

param(
  [switch]$Uninstall,
  [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
)

$ErrorActionPreference = 'Stop'

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $patchPath)) { throw "profile patch not found: $patchPath" }

# The entry lives next to this script: <checkout>/dsh-multitask/lib/index.js.
# System.Uri performs the percent-encoding, which is what keeps the Chinese path
# -- or any other non-ASCII path -- out of this file's own text.
$pluginFile = Join-Path $PSScriptRoot 'lib\index.js'
if (-not (Test-Path -LiteralPath $pluginFile)) { throw "plugin entry not found: $pluginFile" }
$pluginBaseUrl = (New-Object System.Uri($pluginFile)).AbsoluteUri

# THE ?v=N QUERY IS A CACHE KEY, NOT A VERSION TO KEEP IN SYNC BY HAND.
#
# This package lives OUTSIDE the HMR-watched root, so editing its sources does
# not invalidate Node's ESM cache. The profile patch file IS hot-reloaded, so
# changing this URL is the only way to pick up edits without a restart: a new
# query string yields a brand-new module instance.
#
# (This concerns the file:// install mode only. A published npm install does not
# need it: node_modules content changes only when pnpm rewrites it.)
#
# Two hard-won details, both verified by experiment:
#
#   1. A relative import does NOT inherit the entry's query, so the plugin
#      explicitly propagates it (entry -> composition -> coordinator-guard).
#      One bump therefore refreshes the whole module graph. Without that
#      propagation an edited composition would silently keep serving old text.
#
#   2. A bump can STILL fail to take effect if an earlier module instance holds
#      the preset declaration: the registry hard-rejects a duplicate preset id,
#      and that failure surfaces only as a warning, so the OLD preset silently
#      stays in place and your edit looks like it did nothing. The plugin keeps a
#      process-wide handoff table so a new instance releases the previous
#      declaration, but an instance that predates that table cannot be reached.
#      If an edit appears to have no effect, remove this row, let the app settle,
#      then add it back -- that is what finally worked here.
#
# BRACED interpolation is REQUIRED here, NOT cosmetic. In PowerShell '?' is a
# legal variable-name character, so the unbraced form "$pluginBaseUrl?v=4" does
# NOT mean (value of $pluginBaseUrl) + "?v=4": the parser reads the variable
# name as 'pluginBaseUrl?v', finds it undefined, and the whole expression
# collapses to the literal string "=4". The installer would then silently write
# "name: '=4'" into the profile, and the verification below would NOT catch it
# because it compares against this same broken value.
# Measured on Windows PowerShell 5.1 (5.1.22621.6133), unbraced:
#   len=2 value=[=4]   -- braced gives the full URL.
$pluginEntry = "${pluginBaseUrl}?v=6"

$beginMarker = '# --- dsh-multitask BEGIN (managed block; remove to uninstall) ---'
$endMarker   = '# --- dsh-multitask END ---'

$block = @"
$beginMarker
# Multitask "shock absorber" mode, installed from a source checkout and
# referenced by an absolute file:// URL: no pnpm install, nothing in
# node_modules. Select "Multitask shock-absorber mode" when creating a NEW
# session. Run install-multitask.ps1 -Uninstall to remove this block.
- insert:
    - id: multitask
      name: '$pluginEntry'
$endMarker
"@

# Read bytes so the BOM can be detected and preserved.
$srcBytes  = [IO.File]::ReadAllBytes($patchPath)
$hasBom    = $srcBytes.Length -ge 3 -and $srcBytes[0] -eq 0xEF -and $srcBytes[1] -eq 0xBB -and $srcBytes[2] -eq 0xBF
$raw       = [IO.File]::ReadAllText($patchPath)
$utf8Bom   = New-Object System.Text.UTF8Encoding($true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$encoding  = if ($hasBom) { $utf8Bom } else { $utf8NoBom }
$nl        = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }

$installed = $raw.Contains($beginMarker)
Write-Host "patch file   : $patchPath"
Write-Host "encoding     : $(if ($hasBom) { 'UTF-8 with BOM' } else { 'UTF-8 no BOM' })"
Write-Host "line ending  : $(if ($nl -eq "`r`n") { 'CRLF' } else { 'LF' })"
Write-Host "lines        : $((($raw -split $nl)).Count)"
Write-Host "block present: $installed"
Write-Host "plugin entry : $pluginFile"
Write-Host "entry exists : $(Test-Path -LiteralPath $pluginFile)"
Write-Host "row name     : $pluginEntry"
Write-Host ""

function Write-Atomically([string]$text, [string]$tmpSuffix) {
  $tmp = "$patchPath$tmpSuffix"
  [IO.File]::WriteAllText($tmp, $text, $encoding)
  return $tmp
}

if ($Uninstall) {
  if (-not $installed) { Write-Host "not installed; nothing to do"; exit 0 }

  $start  = $raw.IndexOf($beginMarker)
  $endIdx = $raw.IndexOf($endMarker)
  if ($endIdx -lt 0) { throw "begin marker found but end marker missing; refusing to edit blindly" }

  # Swallow surrounding blank lines so no gap accumulates.
  $cutFrom = $start
  while ($cutFrom -gt 0 -and ($raw[$cutFrom - 1] -eq "`n" -or $raw[$cutFrom - 1] -eq "`r")) { $cutFrom-- }
  $cutTo = $endIdx + $endMarker.Length
  while ($cutTo -lt $raw.Length -and ($raw[$cutTo] -eq "`n" -or $raw[$cutTo] -eq "`r")) { $cutTo++ }

  $backup = "$patchPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $patchPath -Destination $backup -Force
  Write-Host "backup       : $backup"

  $next   = $raw.Substring(0, $cutFrom).TrimEnd() + $nl + $raw.Substring($cutTo)
  $tmp    = Write-Atomically $next '.mt-uninstall-tmp'
  $verify = [IO.File]::ReadAllText($tmp)
  if ($verify.Contains($beginMarker)) { throw "verification failed: block still present after removal" }
  Move-Item -LiteralPath $tmp -Destination $patchPath -Force
  Write-Host "uninstalled  : removed the dsh-multitask block"
  Write-Host "No restart needed: DSH hot-reloads this patch file, so the plugin unloads"
  Write-Host "and releases its preset declaration -- it disappears from NEW sessions"
  Write-Host "(sessions already running are unaffected). If it still shows up, restart"
  Write-Host "the app and check the log for a dsh-multitask warning."
  exit 0
}

if ($installed) { Write-Host "already installed; leaving the file untouched"; exit 0 }

$backup = "$patchPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $patchPath -Destination $backup -Force
Write-Host "backup       : $backup"

$original = $raw.TrimEnd()
$next     = $original + $nl + $nl + $block + $nl
$tmp      = Write-Atomically $next '.mt-install-tmp'

# Verify BEFORE replacing: original bytes must survive as an exact prefix, the
# new block must be present, and the file must have grown.
$verify = [IO.File]::ReadAllText($tmp)
if (-not $verify.Contains($beginMarker)) { throw "verification failed: begin marker missing" }
if (-not $verify.Contains($pluginEntry)) { throw "verification failed: entry URL missing" }
if (-not $verify.StartsWith($original))  { throw "verification failed: original content is not a byte-identical prefix" }
$origLines = ($original -split $nl).Count
$newLines  = ($verify -split $nl).Count
if ($newLines -le $origLines) { throw "verification failed: line count did not grow ($origLines -> $newLines)" }

Move-Item -LiteralPath $tmp -Destination $patchPath -Force
Write-Host "installed    : appended the dsh-multitask row ($origLines -> $newLines lines)"
Write-Host ""
Write-Host "No restart needed. DSH watches this file and hot-reloads it. Expect a log line like:"
Write-Host "  dsh-multitask: preset multitask declared"
Write-Host "If the preset does not show up for a NEW session, restart the app and check the"
Write-Host "log for a dsh-multitask warning (see the notes at the top of this script)."

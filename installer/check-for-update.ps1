# Check GitHub Releases for a newer mcp-midi-control bundle and, if
# one exists, download it, extract side-by-side, and re-run setup.cmd
# from the new install so Claude Desktop's config points at the
# updated paths.
#
# Side-by-side extract is deliberate: Claude Desktop typically holds
# node.exe open while running, so an in-place overwrite would fail.
# The new install lands in a sibling folder; the old one stays on
# disk for rollback or manual cleanup.
#
# Arguments:
#   -InstallDir   Absolute path to the install root (where node.exe and
#                 the package.json with the bundle version live).
#   -Channel      auto (default) | stable | prerelease | any
#                 - auto: derive from the installed version. If the
#                   installed semver has a pre-release suffix (e.g.
#                   0.1.0-alpha.7), include pre-releases AND stable.
#                   Otherwise stable only.
#                 - stable: only releases with prerelease=false.
#                 - prerelease: only releases with prerelease=true.
#                 - any: both.
#   -CheckOnly    Report the comparison and exit; no download.
#   -Force        Re-install even if the resolved latest == installed.
#   -Repo         GitHub repo (default TheAndrewStaker/mcp-midi-control).
#
# Exit codes:
#   0  = up-to-date, OR upgrade staged and new setup.cmd ran cleanly
#   1  = argument / environment error
#   2  = network / API error
#   3  = no release matched the selected channel
#   4  = downloaded ZIP did not contain the expected layout
#   5  = new setup.cmd failed

param(
    [Parameter(Mandatory=$true)]
    [string]$InstallDir,

    [ValidateSet('auto','stable','prerelease','any')]
    [string]$Channel = 'auto',

    [switch]$CheckOnly,

    [switch]$Force,

    [string]$Repo = 'TheAndrewStaker/mcp-midi-control',

    # Test-only override. When set, skips URL construction and reads the
    # releases JSON directly from this URI (supports file://). Production
    # use leaves it empty so the public GitHub API endpoint is used.
    [string]$ReleasesUrl
)

$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

# Real semver comparator. Returns -1, 0, or 1 for $a vs $b.
# Handles the cases that matter for this project:
#   - 0.1.0-alpha.9   <  0.1.0-alpha.10           (numeric pre-release segment)
#   - 0.1.0-alpha.10  <  0.1.0                     (pre-release < stable, same main)
#   - 0.1.0           <  0.1.1                     (numeric main segment)
# Lexical sort fails the first case ("alpha.10" sorts before "alpha.9"); the
# manual numeric/string comparison below is the semver-spec rule.
function Compare-Semver {
    param([string]$a, [string]$b)

    $a = ($a -replace '^v', '').Trim()
    $b = ($b -replace '^v', '').Trim()

    $aParts = $a.Split('-', 2)
    $bParts = $b.Split('-', 2)

    $aMainNums = $aParts[0].Split('.') | ForEach-Object { [int]$_ }
    $bMainNums = $bParts[0].Split('.') | ForEach-Object { [int]$_ }
    $len = [Math]::Max($aMainNums.Length, $bMainNums.Length)
    for ($i = 0; $i -lt $len; $i++) {
        $av = if ($i -lt $aMainNums.Length) { $aMainNums[$i] } else { 0 }
        $bv = if ($i -lt $bMainNums.Length) { $bMainNums[$i] } else { 0 }
        if ($av -lt $bv) { return -1 }
        if ($av -gt $bv) { return 1 }
    }

    $aPre = if ($aParts.Length -gt 1) { $aParts[1] } else { $null }
    $bPre = if ($bParts.Length -gt 1) { $bParts[1] } else { $null }
    if (-not $aPre -and -not $bPre) { return 0 }
    # Per semver: a version without pre-release > version with pre-release.
    if (-not $aPre) { return 1 }
    if (-not $bPre) { return -1 }

    $aSegs = $aPre.Split('.')
    $bSegs = $bPre.Split('.')
    $segLen = [Math]::Max($aSegs.Length, $bSegs.Length)
    for ($i = 0; $i -lt $segLen; $i++) {
        if ($i -ge $aSegs.Length) { return -1 }
        if ($i -ge $bSegs.Length) { return 1 }
        $aSeg = $aSegs[$i]
        $bSeg = $bSegs[$i]
        $aIsNum = $aSeg -match '^\d+$'
        $bIsNum = $bSeg -match '^\d+$'
        if ($aIsNum -and $bIsNum) {
            $aN = [int]$aSeg
            $bN = [int]$bSeg
            if ($aN -lt $bN) { return -1 }
            if ($aN -gt $bN) { return 1 }
        } elseif ($aIsNum) {
            return -1
        } elseif ($bIsNum) {
            return 1
        } else {
            $cmp = [string]::Compare($aSeg, $bSeg, $false)
            if ($cmp -ne 0) { return $cmp }
        }
    }
    return 0
}

function Get-InstalledVersion {
    param([string]$Root)
    $pkgPath = Join-Path $Root 'package.json'
    if (-not (Test-Path $pkgPath)) {
        throw "package.json not found at $pkgPath. The install directory does not look like an mcp-midi-control bundle."
    }
    $pkg = Get-Content -Path $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $pkg.version) {
        throw "package.json at $pkgPath has no version field."
    }
    return [string]$pkg.version
}

# Decide which releases are eligible given a channel and the installed version.
# Returns the resolved effective channel string for logging.
function Resolve-Channel {
    param([string]$Requested, [string]$InstalledVersion)
    if ($Requested -ne 'auto') { return $Requested }
    if ($InstalledVersion -match '-') { return 'any' }
    return 'stable'
}

function Test-MatchesChannel {
    param($Release, [string]$EffectiveChannel)
    switch ($EffectiveChannel) {
        'stable'     { return -not $Release.prerelease }
        'prerelease' { return [bool]$Release.prerelease }
        'any'        { return $true }
    }
    return $false
}

# --------------------------------------------------------------------------
# 1. Validate the install directory.
# --------------------------------------------------------------------------

if (-not (Test-Path $InstallDir)) {
    Write-Error "InstallDir does not exist: $InstallDir"
    exit 1
}

$bundledNodeExe = Join-Path $InstallDir 'node.exe'
if (-not (Test-Path $bundledNodeExe)) {
    Write-Host ''
    Write-Host 'UPDATE FAILED -this install does not look like a release bundle.' -ForegroundColor Red
    Write-Host ''
    Write-Host 'Expected to find node.exe at:'
    Write-Host "  $bundledNodeExe"
    Write-Host ''
    Write-Host 'update.cmd only works on the ZIP-installed bundle layout. If you are'
    Write-Host 'running from a source checkout, use `git pull` + `npm run build` instead.'
    Write-Host ''
    exit 1
}

$installedVersion = Get-InstalledVersion -Root $InstallDir
$effectiveChannel = Resolve-Channel -Requested $Channel -InstalledVersion $installedVersion

Write-Host ''
Write-Host "Installed version: $installedVersion"
Write-Host "Channel:           $Channel (effective: $effectiveChannel)"
Write-Host "Repo:              $Repo"
Write-Host ''

# --------------------------------------------------------------------------
# 2. Fetch GitHub Releases.
# --------------------------------------------------------------------------

if ($ReleasesUrl) {
    $apiUrl = $ReleasesUrl
} else {
    $apiUrl = "https://api.github.com/repos/$Repo/releases?per_page=30"
}
$headers = @{
    'User-Agent' = 'mcp-midi-control-updater'
    'Accept'     = 'application/vnd.github+json'
}

Write-Host "Fetching releases from $apiUrl..."
try {
    if ($apiUrl -like 'file://*') {
        # Invoke-RestMethod returns raw text for file:// URIs instead of
        # parsing the JSON. Read + parse manually so test fixtures work.
        $localPath = ([System.Uri]$apiUrl).LocalPath
        $rawJson = Get-Content -Path $localPath -Raw -Encoding UTF8
        $releases = $rawJson | ConvertFrom-Json
    } else {
        $releases = Invoke-RestMethod -Uri $apiUrl -Headers $headers -ErrorAction Stop
    }
} catch {
    Write-Host ''
    Write-Host 'UPDATE FAILED -could not reach GitHub.' -ForegroundColor Red
    Write-Host ''
    Write-Host $_.Exception.Message
    Write-Host ''
    Write-Host 'Check your internet connection and try again.'
    Write-Host ''
    exit 2
}

if (-not $releases -or $releases.Count -eq 0) {
    Write-Host "No releases published yet for $Repo."
    Write-Host 'Nothing to update.'
    exit 3
}

# --------------------------------------------------------------------------
# 3. Filter by channel, sort by semver, pick the newest.
# --------------------------------------------------------------------------

$candidates = @()
foreach ($r in $releases) {
    if ($r.draft) { continue }
    if (-not (Test-MatchesChannel -Release $r -EffectiveChannel $effectiveChannel)) { continue }
    $tag = [string]$r.tag_name
    if (-not $tag) { continue }
    $version = $tag -replace '^v', ''
    $candidates += [pscustomobject]@{
        Version    = $version
        Tag        = $tag
        Release    = $r
        Prerelease = [bool]$r.prerelease
    }
}

if ($candidates.Count -eq 0) {
    Write-Host "No releases on the '$effectiveChannel' channel."
    if ($effectiveChannel -eq 'stable') {
        Write-Host 'Tip: pass -Channel prerelease if you want to track alpha/beta builds.'
    }
    exit 3
}

# Sort newest-first via the semver comparator.
$sorted = $candidates | Sort-Object -Property Version -Descending:$false
# Sort-Object doesn't take a custom comparator pre-PS7; use a manual bubble.
for ($i = 0; $i -lt $sorted.Count - 1; $i++) {
    for ($j = 0; $j -lt $sorted.Count - $i - 1; $j++) {
        if ((Compare-Semver -a $sorted[$j].Version -b $sorted[$j + 1].Version) -lt 0) {
            $tmp = $sorted[$j]
            $sorted[$j] = $sorted[$j + 1]
            $sorted[$j + 1] = $tmp
        }
    }
}
$latest = $sorted[0]

Write-Host "Latest matching release: $($latest.Tag) (prerelease=$($latest.Prerelease))"

$cmp = Compare-Semver -a $latest.Version -b $installedVersion
if ($cmp -le 0 -and -not $Force) {
    if ($cmp -eq 0) {
        Write-Host 'You are on the latest version. Nothing to do.' -ForegroundColor Green
    } else {
        Write-Host "Installed version ($installedVersion) is newer than the latest matching release ($($latest.Version))."
        Write-Host 'Nothing to do. Pass -Force to reinstall this version anyway.'
    }
    exit 0
}

if ($CheckOnly) {
    if ($cmp -gt 0) {
        Write-Host "Update available: $installedVersion -> $($latest.Version)" -ForegroundColor Yellow
    } elseif ($Force) {
        Write-Host "Would reinstall $($latest.Version) (forced)."
    }
    Write-Host 'CheckOnly: not downloading.'
    exit 0
}

# --------------------------------------------------------------------------
# 4. Locate the bundle ZIP asset and download.
# --------------------------------------------------------------------------

# The build script names assets `mcp-midi-control-v<version>.zip`. Match
# loosely on prefix + .zip so a future rename to e.g. .zip.sha256 sidecar
# doesn't trip us up.
$zipAsset = $null
foreach ($asset in $latest.Release.assets) {
    if ($asset.name -like 'mcp-midi-control-v*.zip') {
        $zipAsset = $asset
        break
    }
}
if (-not $zipAsset) {
    Write-Host ''
    Write-Host "UPDATE FAILED -release $($latest.Tag) has no mcp-midi-control-v*.zip asset." -ForegroundColor Red
    Write-Host ''
    Write-Host 'Assets attached to that release:'
    foreach ($asset in $latest.Release.assets) {
        Write-Host "  $($asset.name)"
    }
    Write-Host ''
    exit 4
}

$tempZip = Join-Path $env:TEMP $zipAsset.name
if (Test-Path $tempZip) { Remove-Item $tempZip -Force }

Write-Host ''
Write-Host "Downloading $($zipAsset.name) ($([Math]::Round($zipAsset.size / 1MB, 1)) MB)..."
try {
    # Disable the progress bar -on Windows PowerShell 5.1 it slows
    # Invoke-WebRequest 10-20x for large downloads due to a known
    # rendering bottleneck on legacy hosts.
    $prevProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $zipAsset.browser_download_url -OutFile $tempZip -Headers $headers -ErrorAction Stop
} catch {
    Write-Host ''
    Write-Host 'UPDATE FAILED -download error.' -ForegroundColor Red
    Write-Host ''
    Write-Host $_.Exception.Message
    Write-Host ''
    exit 2
} finally {
    $ProgressPreference = $prevProgress
}

# --------------------------------------------------------------------------
# 5. Extract side-by-side. The ZIP contains a top-level directory named
# mcp-midi-control-v<version>, so we extract into the PARENT of the current
# install and let that top-level dir land as a sibling.
# --------------------------------------------------------------------------

$parentDir = Split-Path $InstallDir -Parent
$expectedNewDir = Join-Path $parentDir "mcp-midi-control-v$($latest.Version)"

if (Test-Path $expectedNewDir) {
    if ($Force) {
        Write-Host "Removing existing $expectedNewDir (forced)..."
        Remove-Item $expectedNewDir -Recurse -Force
    } else {
        Write-Host ''
        Write-Host "UPDATE FAILED -target directory already exists:" -ForegroundColor Red
        Write-Host "  $expectedNewDir"
        Write-Host ''
        Write-Host 'Delete it manually and re-run, or pass -Force.'
        Write-Host ''
        exit 4
    }
}

Write-Host "Extracting to $parentDir..."
try {
    $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tarExe) {
        & $tarExe -xf $tempZip -C $parentDir 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "tar.exe exited with code $LASTEXITCODE"
        }
    } else {
        Expand-Archive -Path $tempZip -DestinationPath $parentDir -Force -ErrorAction Stop
    }
} catch {
    Write-Host ''
    Write-Host 'UPDATE FAILED -extraction error.' -ForegroundColor Red
    Write-Host $_.Exception.Message
    exit 4
} finally {
    Remove-Item $tempZip -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path $expectedNewDir)) {
    Write-Host ''
    Write-Host "UPDATE FAILED -extracted ZIP did not produce expected folder:" -ForegroundColor Red
    Write-Host "  $expectedNewDir"
    Write-Host ''
    Write-Host 'The ZIP layout may have changed; inspect the asset and update this script.'
    exit 4
}

# --------------------------------------------------------------------------
# 6. Run the new install's setup.cmd. It rewrites Claude Desktop's
# config to point at the new paths and runs its own smoke-boot.
# --------------------------------------------------------------------------

$newSetup = Join-Path $expectedNewDir 'setup.cmd'
if (-not (Test-Path $newSetup)) {
    Write-Host ''
    Write-Host "UPDATE FAILED -new install has no setup.cmd at:" -ForegroundColor Red
    Write-Host "  $newSetup"
    exit 4
}

Write-Host ''
Write-Host '------------------------------------------------------------'
Write-Host "Running setup.cmd from the new install: $newSetup"
Write-Host 'Quit Claude Desktop from the system tray BEFORE this completes'
Write-Host 'or the config rewrite will not take effect.'
Write-Host '------------------------------------------------------------'
Write-Host ''

# Invoke directly (not via Start-Process) so its stdout/stderr stream
# into this console and its exit code propagates. Pass --no-pause so
# the new setup.cmd exits without a "press any key" prompt; this script
# has its own trailing summary and update.cmd's wrapper has its own
# pause for double-click users.
& cmd.exe /c "`"$newSetup`" --no-pause"
$setupRc = $LASTEXITCODE
if ($setupRc -ne 0) {
    Write-Host ''
    Write-Host "UPDATE FAILED -new setup.cmd exited with code $setupRc." -ForegroundColor Red
    Write-Host 'The new install is on disk but Claude Desktop config may be stale.'
    Write-Host "Inspect: $expectedNewDir"
    exit 5
}

Write-Host ''
Write-Host '============================================================'
Write-Host "Updated to $($latest.Version)." -ForegroundColor Green
Write-Host ''
Write-Host "New install: $expectedNewDir"
Write-Host "Old install: $InstallDir (kept on disk; delete when ready)"
Write-Host ''
Write-Host 'Fully quit Claude Desktop (system tray right-click then Quit)'
Write-Host 'and reopen it to load the new server.'
Write-Host '============================================================'
exit 0

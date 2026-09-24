<#
Brings a VLO folder's source up to date for update.bat: fast-forwards a Git
checkout, or converts a folder downloaded as a GitHub ZIP into one. update.sh
carries the same steps for macOS and Linux.

Before any local file is replaced or moved, the files are listed and the user
is asked (unless -ReplaceLocalFiles approved it up front); each one is saved
under .vlo-update-backups first.

Exit codes: 0 updated, 1 failed, 2 refused or cancelled with nothing changed.
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Branch,
    [switch]$ReplaceLocalFiles
)

Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

$Utf8 = New-Object System.Text.UTF8Encoding $false
$PreviewLimit = 20
$Root = [System.IO.Path]::GetFullPath($Root.TrimEnd('\'))
$BackupRoot = Join-Path $Root '.vlo-update-backups'
$GitExe = (Get-Command git -CommandType Application | Select-Object -First 1).Source

function Write-Info([string]$Message) { Write-Host "[INFO]  $Message" }
function Write-Failure([string]$Message) { [Console]::Error.WriteLine("[ERROR] $Message") }

# Thrown to stop with nothing changed after the reason has been printed.
class UpdateRefused : System.Exception {}

# Windows PowerShell 5.1 has no ProcessStartInfo.ArgumentList, so quote each
# argument the way the C runtime that parses git's command line expects.
function ConvertTo-ProcessArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

# Run git for data rather than display: UTF-8 both ways, NULs preserved, and
# stdin fed from a string. PowerShell's own native pipes would re-encode both.
function Invoke-GitData {
    param(
        [string[]]$Arguments,
        [string]$WorkingDirectory = $Root,
        [string]$InputText = '',
        [string]$IndexFile = '',
        [int[]]$AllowedExitCodes = @(0)
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $GitExe
    $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' ')
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = $Utf8
    $startInfo.StandardErrorEncoding = $Utf8
    if ($IndexFile) { $startInfo.EnvironmentVariables['GIT_INDEX_FILE'] = $IndexFile }

    $process = [System.Diagnostics.Process]::Start($startInfo)
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if ($InputText.Length -gt 0) {
        $bytes = $Utf8.GetBytes($InputText)
        $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    }
    $process.StandardInput.Close()
    $process.WaitForExit()

    if ($AllowedExitCodes -notcontains $process.ExitCode) {
        throw "git $($Arguments -join ' ') failed: $($stderr.Result.Trim())"
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.Result }
}

# Run git for display, letting its progress on stderr reach the console as-is.
function Invoke-GitVisible([string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    & $GitExe @Arguments | Out-Host
    return $LASTEXITCODE
}

function Split-NulList([string]$Text) {
    return @($Text.Split([char]0) | Where-Object { $_.Length -gt 0 })
}

function Get-LocalPath([string]$RelativePath) {
    return Join-Path $Root ($RelativePath -replace '/', '\')
}

function Get-LocalEntry([string]$RelativePath) {
    return Get-Item -LiteralPath (Get-LocalPath $RelativePath) -Force -ErrorAction SilentlyContinue
}

# LinkType rather than the ReparsePoint attribute: OneDrive placeholders are
# reparse points too, and they are ordinary files and folders to VLO.
function Test-LinkedEntry($Entry) {
    return $null -ne $Entry -and @('Junction', 'SymbolicLink') -contains $Entry.LinkType
}

function Show-Preview([string]$Title, [string[]]$Paths) {
    if ($Paths.Count -eq 0) { return }
    Write-Host ''
    Write-Host $Title
    $Paths | Select-Object -First $PreviewLimit | ForEach-Object { Write-Host "    $_" }
    if ($Paths.Count -gt $PreviewLimit) {
        Write-Host "    ... and $($Paths.Count - $PreviewLimit) more"
    }
}

function Format-ManifestSection([string]$Title, [string[]]$Paths) {
    if ($Paths.Count -eq 0) { return @() }
    return @('', $Title) + @($Paths | ForEach-Object { "    $_" })
}

# Move an entry into the backup at the same relative path, then remove any
# folders the move emptied so stale directory trees do not linger.
function Move-Aside([string]$RelativePath) {
    $source = Get-LocalPath $RelativePath
    if ($null -eq (Get-LocalEntry $RelativePath)) { return }
    $target = Join-Path $script:BackupDir ($RelativePath -replace '/', '\')
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Move-Item -LiteralPath $source -Destination $target

    $parent = Split-Path -Parent $source
    while ($parent.Length -gt $Root.Length -and
        @([System.IO.Directory]::GetFileSystemEntries($parent)).Count -eq 0) {
        Remove-Item -LiteralPath $parent -Force
        $parent = Split-Path -Parent $parent
    }
}

function New-Plan([string]$GitDir, [string]$IndexFile) {
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    # Staging inside the installation keeps the final .git move a rename,
    # which a cross-volume Move-Item could not do.
    $script:StageDir = Join-Path $BackupRoot ('.stage-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:StageDir -Force | Out-Null
    return [pscustomobject]@{
        GitDir = $GitDir
        IndexFile = $IndexFile
        Overwritten = @()
        InTheWay = @()
        Leftovers = @()
    }
}

# Git as the plan sees it: the plan's repository and index against this
# folder. The index holds the tree the folder is about to be reset to.
function Invoke-PlanGit($Plan, [string[]]$Arguments) {
    $prefix = @("--git-dir=$($Plan.GitDir)", "--work-tree=$Root")
    return Invoke-GitData -Arguments ($prefix + $Arguments) -IndexFile $Plan.IndexFile
}

# Tracked paths whose local copy differs from the plan's index. A path
# reported missing may really be hidden behind a file or a link in one of its
# parent folders, or be occupied by a folder; a reset would delete either, or
# swap the link for an empty folder.
function Add-TrackedChanges($Plan) {
    $overwritten = New-Object System.Collections.Generic.List[string]
    $inTheWay = New-Object System.Collections.Generic.SortedSet[string]
    $linked = New-Object System.Collections.Generic.SortedSet[string]
    $prefixKinds = @{}
    $diff = Invoke-PlanGit $Plan @('diff', '--name-status', '-z', '--no-renames')
    $status = @(Split-NulList $diff.Output)
    for ($index = 0; $index + 1 -lt $status.Count; $index += 2) {
        $kind = $status[$index]
        $path = $status[$index + 1]
        if ($kind -ne 'D') {
            $overwritten.Add($path)
            continue
        }

        $segments = $path.Split('/')
        $prefix = ''
        $blocked = $false
        for ($depth = 0; $depth -lt $segments.Count - 1; $depth++) {
            $prefix = if ($prefix) { "$prefix/$($segments[$depth])" } else { $segments[$depth] }
            if (-not $prefixKinds.ContainsKey($prefix)) {
                $entry = Get-LocalEntry $prefix
                $prefixKinds[$prefix] = if ($null -eq $entry) { 'missing' }
                    elseif (Test-LinkedEntry $entry) { 'linked' }
                    elseif ($entry.PSIsContainer) { 'folder' }
                    else { 'file' }
            }
            switch ($prefixKinds[$prefix]) {
                'linked' { [void]$linked.Add($prefix); $blocked = $true }
                'file' { [void]$inTheWay.Add($prefix); $blocked = $true }
                'missing' { $blocked = $true }
            }
            if ($blocked) { break }
        }
        if (-not $blocked -and $null -ne (Get-LocalEntry $path)) {
            [void]$inTheWay.Add($path)
        }
    }

    # Refuse rather than replace a linked folder with a real one: the data
    # behind the link would survive, but VLO would stop seeing it. Only
    # symbolic links get here; Git for Windows reads through a junction as if
    # it were a folder and leaves it in place.
    if ($linked.Count -gt 0) {
        Write-Failure 'These folders are links, but VLO tracks files inside them:'
        $linked | ForEach-Object { [Console]::Error.WriteLine("    $_") }
        Write-Failure 'Updating would replace each link with an empty folder. Move their contents into normal folders, then rerun the updater. Nothing was changed.'
        throw (New-Object UpdateRefused)
    }

    $Plan.Overwritten = @($overwritten | Sort-Object)
    $Plan.InTheWay = @($inTheWay)
}

# Files a ZIP folder has that the fetched version does not track. Anything
# ignored by either the ZIP's own rules or the fetched version's rules is local
# data and stays put; the rest is source the new version no longer has.
function Add-ZipLeftovers($Plan) {
    $rulesDir = Join-Path $script:StageDir 'ignore-rules'
    New-Item -ItemType Directory -Path $rulesDir -Force | Out-Null
    $tree = Invoke-PlanGit $Plan @('ls-tree', '-r', '-z', '--name-only', 'HEAD')
    foreach ($path in @(Split-NulList $tree.Output)) {
        if ($path -ne '.gitignore' -and -not $path.EndsWith('/.gitignore')) { continue }
        $target = Join-Path $rulesDir ($path -replace '/', '\')
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        $rules = (Invoke-PlanGit $Plan @('show', "HEAD:$path")).Output
        [System.IO.File]::WriteAllText($target, $rules, $Utf8)
    }
    $candidates = (Invoke-PlanGit $Plan @(
        'ls-files', '--others', '--exclude-standard', '--exclude=/.vlo-update-backups/', '-z'
    )).Output
    if ($candidates.Length -eq 0) { return }

    $rulesResult = Invoke-GitData -Arguments @(
        "--git-dir=$($Plan.GitDir)", "--work-tree=$rulesDir",
        'check-ignore', '--no-index', '--stdin', '-z', '-v', '-n'
    ) -WorkingDirectory $rulesDir -InputText $candidates -AllowedExitCodes @(0, 1)
    # Records are source, line, pattern, path; an empty pattern means no rule
    # matched, and a negated one means the path is explicitly kept.
    $leftovers = New-Object System.Collections.Generic.List[string]
    $records = $rulesResult.Output.Split([char]0)
    for ($index = 0; $index + 3 -lt $records.Count; $index += 4) {
        $pattern = $records[$index + 2]
        $path = $records[$index + 3].TrimEnd('/')
        if ($pattern.Length -gt 0 -and -not $pattern.StartsWith('!')) { continue }
        $insideMovedFolder = $false
        foreach ($item in $Plan.InTheWay) {
            if ($path.StartsWith("$item/")) { $insideMovedFolder = $true; break }
        }
        if (-not $insideMovedFolder) { $leftovers.Add($path) }
    }
    $Plan.Leftovers = @($leftovers | Sort-Object)
}

# List what the plan would replace or move, ask (unless approved up front),
# then save each file under a new backup folder. Nothing is asked when nothing
# local would change.
function Confirm-AndBackUp($Plan, [string]$Label, [string]$Intro, [string]$Activity, [string]$LeftoverTitle) {
    if ($Plan.Overwritten.Count + $Plan.InTheWay.Count + $Plan.Leftovers.Count -eq 0) { return }
    $backupDir = Join-Path $BackupRoot ("$Label-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))

    Write-Host ''
    Write-Info $Intro
    Show-Preview "Differ from VLO's version (a copy is saved, then the file is replaced):" $Plan.Overwritten
    Show-Preview "In the way of VLO's files (moved into the backup):" $Plan.InTheWay
    Show-Preview "$LeftoverTitle (moved into the backup):" $Plan.Leftovers
    Write-Host ''
    Write-Host "Everything listed is saved under $($backupDir.Substring($Root.Length + 1))"
    Write-Host ''

    if (-not $ReplaceLocalFiles) {
        if ([Console]::IsInputRedirected) {
            Write-Failure 'Rerun the updater from a terminal to approve these changes, or pass --replace-local-files. Nothing was changed.'
            throw (New-Object UpdateRefused)
        }
        $answer = Read-Host 'Continue? [y/N]'
        if (@('y', 'yes') -notcontains $answer.Trim().ToLowerInvariant()) {
            Write-Info 'Update cancelled. Nothing was changed.'
            throw (New-Object UpdateRefused)
        }
    }

    $script:ReplacingLocalFiles = $true
    $script:BackupDir = $backupDir
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $manifest = @(
        "Saved by update.bat on $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) while $Activity.",
        'Each entry is stored at its original path relative to the VLO folder.'
    )
    $manifest += Format-ManifestSection "Copied, then replaced by VLO's version:" $Plan.Overwritten
    $manifest += Format-ManifestSection "Moved aside because it was in the way of VLO's files:" $Plan.InTheWay
    $manifest += Format-ManifestSection "Moved aside; $($LeftoverTitle):" $Plan.Leftovers
    [System.IO.File]::WriteAllLines((Join-Path $backupDir 'MANIFEST.txt'), [string[]]$manifest, $Utf8)

    foreach ($path in $Plan.Overwritten) {
        $target = Join-Path $backupDir ($path -replace '/', '\')
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Get-LocalPath $path) -Destination $target -Force
    }
    foreach ($path in $Plan.InTheWay) { Move-Aside $path }
    foreach ($path in $Plan.Leftovers) { Move-Aside $path }
}

function Complete-Plan {
    if ($script:StageDir -and (Test-Path -LiteralPath $script:StageDir)) {
        Remove-Item -LiteralPath $script:StageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    $script:StageDir = $null
    if ((Test-Path -LiteralPath $BackupRoot) -and
        @([System.IO.Directory]::GetFileSystemEntries($BackupRoot)).Count -eq 0) {
        Remove-Item -LiteralPath $BackupRoot -Force -ErrorAction SilentlyContinue
    }
}

function Write-BackupLocation {
    if ($script:BackupDir) { Write-Info "Saved the replaced and moved files to $($script:BackupDir)" }
}

function Update-GitCheckout {
    $inside = Invoke-GitData -Arguments @('-C', $Root, 'rev-parse', '--is-inside-work-tree') -AllowedExitCodes @(0, 128)
    if ($inside.ExitCode -ne 0) {
        Write-Failure 'The .git entry exists but is not a usable Git checkout.'
        throw (New-Object UpdateRefused)
    }

    # Plan against a scratch index holding HEAD, so the checkout's own index
    # (and anything staged in it) is untouched unless the reset is approved.
    $gitDir = (Invoke-GitData -Arguments @('-C', $Root, 'rev-parse', '--absolute-git-dir')).Output.Trim()
    $plan = New-Plan $gitDir ''
    $plan.IndexFile = Join-Path $script:StageDir 'index'
    Invoke-PlanGit $plan @('read-tree', 'HEAD') | Out-Null
    Add-TrackedChanges $plan
    # Files added to the checkout's index but never committed: a reset to HEAD
    # deletes them.
    $added = Invoke-GitData -Arguments @(
        '-C', $Root, 'diff', '--cached', '--name-only', '--diff-filter=A', '--no-renames', '-z'
    )
    $plan.Leftovers = @(Split-NulList $added.Output | Sort-Object)

    Confirm-AndBackUp $plan 'local-changes' `
        'Updating will discard local changes to these files:' `
        'discarding local changes before updating a Git checkout' `
        'Added locally, not part of VLO'
    if ($script:ReplacingLocalFiles) {
        Invoke-GitData -Arguments @('-C', $Root, 'reset', '--hard', '--quiet', 'HEAD') | Out-Null
        $script:ReplacingLocalFiles = $false
        Write-BackupLocation
    }
    Complete-Plan

    Write-Info 'Fetching updates for the existing Git checkout...'
    if ((Invoke-GitVisible @('-C', $Root, 'pull', '--ff-only')) -ne 0) {
        Write-Failure 'Git could not fast-forward this checkout. Resolve its branch or upstream configuration, then rerun the updater.'
        throw (New-Object UpdateRefused)
    }
}

function Convert-ZipInstallation {
    $plan = New-Plan '' ''
    $stageRepository = Join-Path $script:StageDir 'repository'
    $plan.GitDir = Join-Path $stageRepository '.git'
    $plan.IndexFile = Join-Path $plan.GitDir 'index'

    Write-Info 'This VLO folder is not a Git checkout; preparing to convert the ZIP installation...'
    if ((Invoke-GitVisible @('clone', '--depth', '1', '--branch', $Branch, '--no-checkout', $Repository, $stageRepository)) -ne 0) {
        throw "Git could not fetch $Repository ($Branch)."
    }
    Invoke-PlanGit $plan @('read-tree', 'HEAD') | Out-Null
    Add-TrackedChanges $plan
    Add-ZipLeftovers $plan

    Confirm-AndBackUp $plan 'zip-import' `
        'Converting this folder to a Git checkout will change these local files:' `
        "converting a ZIP installation into a Git checkout of $Repository ($Branch)" `
        'No longer part of VLO'

    $script:ReplacingLocalFiles = $true
    Invoke-PlanGit $plan @('reset', '--hard', '--quiet', 'HEAD') | Out-Null
    Move-Item -LiteralPath $plan.GitDir -Destination (Join-Path $Root '.git')
    $script:ReplacingLocalFiles = $false
    Complete-Plan

    Write-BackupLocation
    Write-Info "Converted this folder to a Git checkout tracking $Repository ($Branch)."
}

$script:StageDir = $null
$script:BackupDir = $null
$script:ReplacingLocalFiles = $false
$exitCode = 0
try {
    if (Test-Path -LiteralPath (Join-Path $Root '.git')) {
        Update-GitCheckout
    } else {
        Convert-ZipInstallation
    }
} catch [UpdateRefused] {
    $exitCode = 2
} catch {
    Write-Failure $_.Exception.Message
    $exitCode = 1
} finally {
    if ($exitCode -ne 0 -and $script:ReplacingLocalFiles) {
        if ($script:BackupDir) {
            Write-Failure "The update stopped partway. Local files it had already set aside are in $($script:BackupDir); its MANIFEST.txt lists them."
        } else {
            Write-Failure 'The update stopped partway. None of the local files had been replaced; rerun the updater.'
        }
    }
    Complete-Plan
}
exit $exitCode

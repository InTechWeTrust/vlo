<#
Converts a VLO folder that was downloaded as a GitHub ZIP into a Git checkout.
update.bat runs this; update.sh carries the same steps for macOS and Linux.

Exit codes: 0 converted, 1 failed, 2 refused or cancelled with nothing changed.
#>
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][string]$Branch,
    [switch]$Confirmed
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
function Move-Aside([string]$RelativePath, [string]$BackupDir) {
    $source = Get-LocalPath $RelativePath
    if ($null -eq (Get-LocalEntry $RelativePath)) { return }
    $target = Join-Path $BackupDir ($RelativePath -replace '/', '\')
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Move-Item -LiteralPath $source -Destination $target

    $parent = Split-Path -Parent $source
    while ($parent.Length -gt $Root.Length -and
        @([System.IO.Directory]::GetFileSystemEntries($parent)).Count -eq 0) {
        Remove-Item -LiteralPath $parent -Force
        $parent = Split-Path -Parent $parent
    }
}

function Invoke-Conversion {
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
    # Staging inside the installation keeps the final .git move a rename,
    # which a cross-volume Move-Item could not do.
    $script:StageDir = Join-Path $BackupRoot ('.stage-' + [guid]::NewGuid().ToString('N'))
    $stageRepository = Join-Path $script:StageDir 'repository'
    $gitDir = Join-Path $stageRepository '.git'
    $rulesDir = Join-Path $script:StageDir 'ignore-rules'
    New-Item -ItemType Directory -Path $rulesDir -Force | Out-Null
    $stage = @("--git-dir=$gitDir", "--work-tree=$Root")

    Write-Info 'This VLO folder is not a Git checkout; preparing to convert the ZIP installation...'
    # git reports clone progress on stderr, which must reach the console as-is.
    $ErrorActionPreference = 'Continue'
    & $GitExe clone --depth 1 --branch $Branch --no-checkout $Repository $stageRepository | Out-Host
    $cloneStatus = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($cloneStatus -ne 0) { throw "Git could not fetch $Repository ($Branch)." }
    Invoke-GitData ($stage + @('read-tree', 'HEAD')) | Out-Null

    # 1. Tracked paths whose local copy differs from the fetched version. A path
    #    reported missing may really be hidden behind a file or a link in one
    #    of its parent folders, or be occupied by a folder.
    $overwritten = New-Object System.Collections.Generic.List[string]
    $inTheWay = New-Object System.Collections.Generic.SortedSet[string]
    $linked = New-Object System.Collections.Generic.SortedSet[string]
    $prefixKinds = @{}
    $diff = Invoke-GitData ($stage + @('diff', '--name-status', '-z', '--no-renames'))
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

    # 2. Refuse rather than replace a linked folder with a real one: the data
    #    behind the link would survive, but VLO would stop seeing it. Only
    #    symbolic links get here; Git for Windows reads through a junction as
    #    if it were a folder and leaves it in place.
    if ($linked.Count -gt 0) {
        Write-Failure 'These folders are links, but the new version tracks files inside them:'
        $linked | ForEach-Object { [Console]::Error.WriteLine("    $_") }
        Write-Failure 'Converting would replace each link with an empty folder. Move their contents into normal folders, then rerun the updater. Nothing was changed.'
        return 2
    }

    # 3. Files the fetched version does not track. Anything ignored by either
    #    the ZIP's own rules or the fetched version's rules is local data and
    #    stays put; the rest is source the new version no longer has.
    $tree = Invoke-GitData ($stage + @('ls-tree', '-r', '-z', '--name-only', 'HEAD'))
    $tracked = @(Split-NulList $tree.Output)
    foreach ($path in $tracked) {
        if ($path -ne '.gitignore' -and -not $path.EndsWith('/.gitignore')) { continue }
        $target = Join-Path $rulesDir ($path -replace '/', '\')
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        $rules = (Invoke-GitData ($stage + @('show', "HEAD:$path"))).Output
        [System.IO.File]::WriteAllText($target, $rules, $Utf8)
    }
    $candidates = (Invoke-GitData ($stage + @(
        'ls-files', '--others', '--exclude-standard', '--exclude=/.vlo-update-backups/', '-z'
    ))).Output
    $leftovers = New-Object System.Collections.Generic.List[string]
    if ($candidates.Length -gt 0) {
        $rulesResult = Invoke-GitData -Arguments @(
            '-C', $rulesDir, "--git-dir=$gitDir", "--work-tree=$rulesDir",
            'check-ignore', '--no-index', '--stdin', '-z', '-v', '-n'
        ) -WorkingDirectory $rulesDir -InputText $candidates -AllowedExitCodes @(0, 1)
        # Records are source, line, pattern, path; an empty pattern means no
        # rule matched, and a negated one means the path is explicitly kept.
        $records = $rulesResult.Output.Split([char]0)
        for ($index = 0; $index + 3 -lt $records.Count; $index += 4) {
            $pattern = $records[$index + 2]
            $path = $records[$index + 3].TrimEnd('/')
            if ($pattern.Length -gt 0 -and -not $pattern.StartsWith('!')) { continue }
            $insideMovedFolder = $false
            foreach ($item in $inTheWay) {
                if ($path.StartsWith("$item/")) { $insideMovedFolder = $true; break }
            }
            if (-not $insideMovedFolder) { $leftovers.Add($path) }
        }
    }

    # 4. Nothing local changes when the ZIP matches the fetched version, so
    #    only ask when a file would be replaced or moved.
    $overwrittenList = @($overwritten | Sort-Object)
    $inTheWayList = @($inTheWay)
    $leftoverList = @($leftovers | Sort-Object)
    $backupDir = Join-Path $BackupRoot ('zip-import-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
    if ($overwrittenList.Count + $inTheWayList.Count + $leftoverList.Count -gt 0) {
        Write-Host ''
        Write-Info 'Converting this folder to a Git checkout will change these local files:'
        Show-Preview 'Differ from the new version (a copy is saved, then the file is replaced):' $overwrittenList
        Show-Preview 'In the way of new files (moved into the backup):' $inTheWayList
        Show-Preview 'No longer part of VLO (moved into the backup):' $leftoverList
        Write-Host ''
        Write-Host "Everything listed is saved under $($backupDir.Substring($Root.Length + 1))"
        Write-Host ''

        if (-not $Confirmed) {
            if ([Console]::IsInputRedirected) {
                Write-Failure 'Rerun the updater from a terminal to approve these changes, or pass --confirm-zip-conversion. Nothing was changed.'
                return 2
            }
            $answer = Read-Host 'Continue? [y/N]'
            if (@('y', 'yes') -notcontains $answer.Trim().ToLowerInvariant()) {
                Write-Info 'Update cancelled. Nothing was changed.'
                return 2
            }
        }

        $script:BackupDir = $backupDir
        New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
        $manifest = @(
            "Saved by update.bat on $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')) while converting a ZIP installation into a",
            "Git checkout of $Repository ($Branch).",
            'Each entry is stored at its original path relative to the VLO folder.'
        )
        $manifest += Format-ManifestSection 'Copied, then replaced by the new version:' $overwrittenList
        $manifest += Format-ManifestSection 'Moved aside because it was in the way of new files:' $inTheWayList
        $manifest += Format-ManifestSection 'Moved aside because VLO no longer includes it:' $leftoverList
        [System.IO.File]::WriteAllLines((Join-Path $backupDir 'MANIFEST.txt'), [string[]]$manifest, $Utf8)

        foreach ($path in $overwrittenList) {
            $target = Join-Path $backupDir ($path -replace '/', '\')
            New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
            Copy-Item -LiteralPath (Get-LocalPath $path) -Destination $target -Force
        }
        foreach ($path in $inTheWayList) { Move-Aside $path $backupDir }
        foreach ($path in $leftoverList) { Move-Aside $path $backupDir }
    }

    $script:ConversionInProgress = $true
    Invoke-GitData ($stage + @('reset', '--hard', '--quiet', 'HEAD')) | Out-Null
    Move-Item -LiteralPath $gitDir -Destination (Join-Path $Root '.git')
    $script:ConversionInProgress = $false

    if ($script:BackupDir) { Write-Info "Saved the replaced and moved files to $($script:BackupDir)" }
    Write-Info "Converted this folder to a Git checkout tracking $Repository ($Branch)."
    return 0
}

$script:StageDir = $null
$script:BackupDir = $null
$script:ConversionInProgress = $false
$exitCode = 1
try {
    $exitCode = Invoke-Conversion
} catch {
    Write-Failure $_.Exception.Message
    if ($script:BackupDir) {
        Write-Failure "The ZIP conversion stopped partway. Local files it had already set aside are in $($script:BackupDir); its MANIFEST.txt lists them."
    } elseif ($script:ConversionInProgress) {
        Write-Failure 'The ZIP conversion stopped partway. None of the local files had been replaced; rerun the updater.'
    }
    $exitCode = 1
} finally {
    if ($script:StageDir -and (Test-Path -LiteralPath $script:StageDir)) {
        Remove-Item -LiteralPath $script:StageDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ((Test-Path -LiteralPath $BackupRoot) -and
        @([System.IO.Directory]::GetFileSystemEntries($BackupRoot)).Count -eq 0) {
        Remove-Item -LiteralPath $BackupRoot -Force -ErrorAction SilentlyContinue
    }
}
exit $exitCode

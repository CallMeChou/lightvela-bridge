param(
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$')][string]$Version = '1.0.0',
    [string]$OutputDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist')
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repo = Split-Path $PSScriptRoot -Parent
$out = [IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($out)
$baseName = 'LightVela-Bridge-v' + $Version + '-windows-x64'
$package = Join-Path $out $baseName
$zip = Join-Path $out ($baseName + '.zip')
if ((Test-Path -LiteralPath $package) -or (Test-Path -LiteralPath $zip)) { throw 'Output exists; choose a new output directory.' }

# Explicit allowlist: never copy app state, browser profiles, caches or databases.
$files = @(
    'LightVela-Bridge.exe', 'LightVela-CCSwitch.cmd',
    'server.mjs', 'lv-client.mjs', 'desktop-worker.mjs', 'ccswitch-import.mjs',
    'vendor\webview2\Microsoft.Web.WebView2.Core.dll',
    'vendor\webview2\Microsoft.Web.WebView2.WinForms.dll',
    'vendor\webview2\WebView2Loader.dll',
    'vendor\webview2\LICENSE.txt', 'vendor\webview2\NOTICE.txt'
)
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $file) -PathType Leaf)) { throw ('Missing runtime file: ' + $file) }
}
[void][IO.Directory]::CreateDirectory($package)
foreach ($file in $files) {
    $target = Join-Path $package $file
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $target
}
$readme = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'WINDOWS-README.md')).Replace('v1.0.0-windows-x64.zip', ('v' + $Version + '-windows-x64.zip'))
[IO.File]::WriteAllText((Join-Path $package 'README.md'), $readme, (New-Object Text.UTF8Encoding($false)))
Copy-Item -LiteralPath (Join-Path $repo 'PRIVACY.md') -Destination (Join-Path $package 'PRIVACY.md')
[IO.Compression.ZipFile]::CreateFromDirectory($package, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
# The separate EXE is for replacing an existing full installation only.
$exe = Join-Path $out 'LightVela-Bridge.exe'
if (Test-Path -LiteralPath $exe) { throw 'EXE output exists; choose a new output directory.' }
Copy-Item -LiteralPath (Join-Path $package 'LightVela-Bridge.exe') -Destination $exe
$lines = foreach ($asset in @($zip, $exe)) {
    (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($asset)
}
[IO.File]::WriteAllText((Join-Path $out 'SHA256SUMS.txt'), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
Write-Output ('Created ' + $baseName + '.zip, LightVela-Bridge.exe and SHA256SUMS.txt (allowlist only).')

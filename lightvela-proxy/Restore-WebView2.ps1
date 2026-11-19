param([string]$PackagePath)
$ErrorActionPreference = 'Stop'
$version = '1.0.4314.35'
$expected = '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4'
$vendor = Join-Path $PSScriptRoot 'vendor\webview2'
$cacheDir = Join-Path $vendor '.cache'
[void][IO.Directory]::CreateDirectory($cacheDir)
if (-not $PackagePath) {
    $PackagePath = Join-Path $cacheDir ('microsoft.web.webview2.' + $version + '.nupkg')
    if (-not (Test-Path -LiteralPath $PackagePath)) {
        $url = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/' + $version + '/microsoft.web.webview2.' + $version + '.nupkg'
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $PackagePath
    }
}
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
if ((Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash -ne $expected) { throw 'WebView2 package SHA256 mismatch; no files were extracted.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($PackagePath)
try {
    $files = @{
        'lib/net462/Microsoft.Web.WebView2.Core.dll' = 'Microsoft.Web.WebView2.Core.dll'
        'lib/net462/Microsoft.Web.WebView2.WinForms.dll' = 'Microsoft.Web.WebView2.WinForms.dll'
        'runtimes/win-x64/native/WebView2Loader.dll' = 'WebView2Loader.dll'
        'LICENSE.txt' = 'LICENSE.txt'
        'NOTICE.txt' = 'NOTICE.txt'
    }
    foreach ($entryName in $files.Keys) {
        $entry = $archive.GetEntry($entryName)
        if (-not $entry) { throw ('Missing official SDK file: ' + $entryName) }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $vendor $files[$entryName]), $true)
    }
} finally { $archive.Dispose() }
Write-Output ('WebView2 ' + $version + ' restored; SHA256 verified (Windows x64).')

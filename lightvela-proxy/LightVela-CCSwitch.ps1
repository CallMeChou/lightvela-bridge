param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
try {
    $root = $PSScriptRoot
    $vendor = Join-Path $root 'vendor\webview2'
    $node = (Get-Command node -ErrorAction Stop).Source
    $env:PATH = $vendor + ';' + $env:PATH
    Add-Type -AssemblyName System.Windows.Forms,System.Drawing,System.Web.Extensions,System.Security,System.Net.Http
    [void][Reflection.Assembly]::LoadFrom((Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll'))
    [void][Reflection.Assembly]::LoadFrom((Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll'))
    $references = @('System.dll','System.Core.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll','System.Security.dll','System.Net.Http.dll',(Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll'),(Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll'))
    Add-Type -Path (Join-Path $root 'DesktopBridge.cs') -ReferencedAssemblies $references
    if ($CheckOnly) { Write-Output 'Desktop compilation OK'; exit 0 }
    [Windows.Forms.Application]::EnableVisualStyles()
    $form = New-Object LightVelaBridge.MainWindow($root, $node)
    [Windows.Forms.Application]::Run($form)
} catch {
    if ($CheckOnly) { Write-Error $_; exit 1 }
    Add-Type -AssemblyName System.Windows.Forms
    [void][Windows.Forms.MessageBox]::Show('LightVela Bridge 启动失败。请确认 Node.js 与 Edge WebView2 Runtime 已安装；运行同目录启动脚本可检查详细错误。','LightVela Bridge')
    exit 1
}
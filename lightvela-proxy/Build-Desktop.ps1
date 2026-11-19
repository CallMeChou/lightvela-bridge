param([string]$OutputName = 'LightVela-Bridge.exe')
$ErrorActionPreference = 'Stop'
if ([IO.Path]::GetFileName($OutputName) -ne $OutputName -or [IO.Path]::GetExtension($OutputName) -ne '.exe') { throw 'OutputName must be an executable file name' }
$vendor = Join-Path $PSScriptRoot 'vendor\webview2'
$refs = @('System.dll','System.Core.dll','System.Windows.Forms.dll','System.Drawing.dll','System.Web.Extensions.dll','System.Security.dll','System.Net.Http.dll',(Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll'),(Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll'))
Add-Type -Path (Join-Path $PSScriptRoot 'DesktopBridge.cs') -ReferencedAssemblies $refs -OutputAssembly (Join-Path $PSScriptRoot $OutputName) -OutputType WindowsApplication
Write-Output 'Desktop application built successfully'

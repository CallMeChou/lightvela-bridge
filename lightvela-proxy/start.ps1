$ErrorActionPreference = 'Stop'
if (-not $env:LV_SESSION_TOKEN) { throw '请先通过安全方式设置 LV_SESSION_TOKEN，或使用桌面登录工具。' }
Push-Location $PSScriptRoot
try { node server.mjs } finally { Pop-Location }

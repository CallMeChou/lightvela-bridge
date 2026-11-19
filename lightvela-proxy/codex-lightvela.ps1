param([ValidateRange(1024,65535)][int]$Port = 8790)
$ErrorActionPreference = 'Stop'
# Start the proxy separately; do not rewrite user profiles or inherit a real API key.
$previousKey = $env:LIGHTVELA_PROXY_KEY
try {
    $env:LIGHTVELA_PROXY_KEY = 'local-lightvela'
    $baseConfig = 'model_providers.lightvela.base_url="http://127.0.0.1:' + $Port + '/v1"'
    & codex -m auto -c 'model_provider="lightvela"' `
        -c 'model_providers.lightvela.name="LightVela"' `
        -c $baseConfig `
        -c 'model_providers.lightvela.wire_api="responses"' `
        -c 'model_providers.lightvela.env_key="LIGHTVELA_PROXY_KEY"'
} finally { $env:LIGHTVELA_PROXY_KEY = $previousKey }

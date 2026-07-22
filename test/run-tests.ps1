# test/run-tests.ps1
# Orchestrates mock server, smoke tests, and cleanup for the Chrome extension test harness.
#
# Usage:
#   pwsh test/run-tests.ps1              # Run mock server + API smoke tests
#   pwsh test/run-tests.ps1 -WithChrome  # Also open Chrome with test page + side panel test

param(
  [switch]$WithChrome
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path $PSScriptRoot -Parent

# --- Load .env ---
$envFile = Join-Path $ProjectRoot ".env"
$Port = 8001
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $key, $val = $line -split "=", 2
      if ($key.Trim() -eq "TEST_PORT") { $Port = [int]$val.Trim() }
    }
  }
}

$BaseUrl = "http://localhost:$Port"

Write-Host ""
Write-Host "=== Chrome Extension Test Harness ===" -ForegroundColor Cyan
Write-Host "Port:    $Port"
Write-Host "Base URL: $BaseUrl"
Write-Host ""

# --- Cleanup function ---
$ServerProcess = $null
$Script:CleanedUp = $false

function Stop-ProcessOnPort {
  param([int]$PortNum)
  # Try Get-NetTCPConnection (PowerShell 3.0+), fall back to netstat parsing
  $pids = @()
  try {
    $conns = Get-NetTCPConnection -LocalPort $PortNum -State Listen -ErrorAction Stop
    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    # Fallback: parse netstat output
    $lines = netstat -ano 2>$null | Select-String ":$PortNum\s.*LISTEN"
    foreach ($line in $lines) {
      if ($line -match '\s(\d+)$') { $pids += [int]$Matches[1] }
    }
  }
  foreach ($pid in ($pids | Select-Object -Unique)) {
    if ($pid -gt 0) {
      Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
  }
}

function Stop-MockServer {
  if ($Script:CleanedUp) { return }
  $Script:CleanedUp = $true
  # Kill the tracked process if we started it
  if ($ServerProcess -and -not $ServerProcess.HasExited) {
    Write-Host ""
    Write-Host "Stopping mock server (PID $($ServerProcess.Id))..." -ForegroundColor Yellow
    Stop-Process -Id $ServerProcess.Id -Force -ErrorAction SilentlyContinue
  }
  # Also kill anything still on the port (covers orphaned processes)
  Stop-ProcessOnPort -PortNum $Port
  Start-Sleep -Milliseconds 300
  Write-Host "Mock server stopped." -ForegroundColor Green
}

# Register cleanup on exit
Register-EngineEvent PowerShell.Exiting -Action { Stop-MockServer } | Out-Null

try {
  # --- Kill anything on the port first ---
  Stop-ProcessOnPort -PortNum $Port
  Start-Sleep -Milliseconds 500

  # --- Start mock server ---
  Write-Host "Starting mock server..." -ForegroundColor Cyan
  $ServerProcess = Start-Process -FilePath "node" -ArgumentList "test/mock-llm-server.mjs" -WorkingDirectory $ProjectRoot -PassThru -NoNewWindow

  # Wait for server to be ready
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 300
    try {
      $null = Invoke-RestMethod -Uri "$BaseUrl/models" -TimeoutSec 2
      $ready = $true
      break
    } catch {
      # Not ready yet
    }
  }

  if (-not $ready) {
    throw "Mock server failed to start on port $Port within 6 seconds."
  }

  Write-Host "Mock server is ready." -ForegroundColor Green
  Write-Host ""

  # --- Smoke tests ---
  $pass = 0
  $fail = 0

  function Test-Endpoint {
    param([string]$Name, [string]$Url, [string]$Method = "GET", [string]$Body = $null)

    try {
      $params = @{
        Uri = $Url
        TimeoutSec = 5
        UseBasicParsing = $true
      }
      if ($Method -ne "GET") { $params.Method = $Method }
      if ($Body) { $params.Body = $Body; $params.ContentType = "application/json" }

      $response = Invoke-RestMethod @params
      Write-Host "  PASS  $Name" -ForegroundColor Green
      return $response
    } catch {
      Write-Host "  FAIL  $Name  ($($_.Exception.Message))" -ForegroundColor Red
      return $null
    }
  }

  Write-Host "Running smoke tests..." -ForegroundColor Cyan
  Write-Host ""

  # Test 1: /models returns mock-agent
  $models = Test-Endpoint -Name "GET /models" -Url "$BaseUrl/models"
  if ($models.data | Where-Object { $_.id -eq "mock-agent" }) {
    $pass++
  } else {
    Write-Host "          Expected mock-agent in model list" -ForegroundColor Red
    $fail++
  }

  # Test 2: /test-api returns network works
  $api = Test-Endpoint -Name "GET /test-api" -Url "$BaseUrl/test-api"
  if ($api.ok -eq $true -and $api.message -eq "network works") {
    $pass++
  } else {
    Write-Host "          Expected { ok: true, message: 'network works' }" -ForegroundColor Red
    $fail++
  }

  # Test 3: /test-config returns correct port
  $config = Test-Endpoint -Name "GET /test-config" -Url "$BaseUrl/test-config"
  if ($config.port -eq $Port) {
    $pass++
  } else {
    Write-Host "          Expected port $Port, got $($config.port)" -ForegroundColor Red
    $fail++
  }

  # Test 4: /chat/completions returns invalid tool call (step 0)
  $chat = Test-Endpoint -Name "POST /chat/completions" -Url "$BaseUrl/chat/completions" -Method "POST" -Body '{"messages":[]}'
  $tc = $chat.choices[0].message.tool_calls
  if ($tc -and $tc[0].function.name -eq "wait") {
    $pass++
  } else {
    Write-Host "          Expected wait tool call with ms: -100" -ForegroundColor Red
    $fail++
  }

  # Test 5: /chat/completions step 2 (after tool result)
  $step2Body = '{"messages":[{"role":"assistant","content":"Testing tool schema validation.","tool_calls":[{"id":"call_test_invalid","type":"function","function":{"name":"wait","arguments":"{\"ms\":-100}"}}]},{"role":"tool","tool_call_id":"call_test_invalid","content":"invalid_tool_call: ms must be >= 1"}]}'
  $chat2 = Test-Endpoint -Name "POST /chat/completions (step 2)" -Url "$BaseUrl/chat/completions" -Method "POST" -Body $step2Body
  $tc2 = $chat2.choices[0].message.tool_calls
  if ($tc2 -and $tc2[0].function.name -eq "get_page_info") {
    $pass++
  } else {
    Write-Host "          Expected get_page_info tool call" -ForegroundColor Red
    $fail++
  }

  # Test 6: /test-page returns HTML
  try {
    $page = Invoke-WebRequest -Uri "$BaseUrl/test-page" -TimeoutSec 5 -UseBasicParsing
    if ($page.Content -match "Agent Test Page" -and $page.Content -match "test-button") {
      Write-Host "  PASS  GET /test-page returns valid HTML" -ForegroundColor Green
      $pass++
    } else {
      Write-Host "  FAIL  GET /test-page missing expected content" -ForegroundColor Red
      $fail++
    }
  } catch {
    Write-Host "  FAIL  GET /test-page ($($_.Exception.Message))" -ForegroundColor Red
    $fail++
  }

  Write-Host ""
  Write-Host "Results: $pass passed, $fail failed" -ForegroundColor $(if ($fail -eq 0) { "Green" } else { "Red" })
  Write-Host ""

  # --- Chrome integration (optional) ---
  if ($WithChrome) {
    Write-Host "Opening Chrome with test page..." -ForegroundColor Cyan
    Write-Host "  1. The test page will open at $BaseUrl/test-page"
    Write-Host "  2. Click the extension icon to bind the side panel"
    Write-Host "  3. Configure Settings: Base URL = $BaseUrl, Model = mock-agent, Max tool steps = 12"
    Write-Host "  4. Right-click side panel -> Inspect -> Console"
    Write-Host "  5. Paste the contents of test/sidepanel-test.js"
    Write-Host ""
    Write-Host "Press Enter when done (this will stop the mock server)..." -ForegroundColor Yellow
    Start-Process "chrome.exe" "$BaseUrl/test-page"
    Read-Host
  } else {
    Write-Host "Mock server is still running on $BaseUrl" -ForegroundColor Yellow
    Write-Host "Press Enter to stop it, or Ctrl+C to leave it running..." -ForegroundColor Yellow
    Read-Host
  }

} catch {
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
} finally {
  Stop-MockServer
}

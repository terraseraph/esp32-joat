# Push the de-esp32 Node-RED palette to a live editor (npm pack + POST /nodes).
param(
    [string]$HostName = "",
    [int]$Port = 1880
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pkg = Join-Path $root "nodered\node-red-contrib-de-esp32"
$statePath = Join-Path $PSScriptRoot "nodered_state.json"

if (-not $HostName) {
    if (Test-Path $statePath) {
        try {
            $st = Get-Content $statePath -Raw | ConvertFrom-Json
            if ($st.host) { $HostName = [string]$st.host }
            if ($st.port) { $Port = [int]$st.port }
        } catch {}
    }
}
if (-not $HostName) { $HostName = "192.168.0.132" }

Push-Location $pkg
try {
    $ver = node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); const n=p.version.split('.').map(Number); n[2]=(n[2]||0)+1; p.version=n.join('.'); fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n'); process.stdout.write(p.version);"
    Write-Host "palette version $ver"
    $tgz = (npm pack --silent | Select-Object -Last 1).Trim()
    if (-not $tgz -or -not (Test-Path $tgz)) {
        throw "npm pack did not write a tarball"
    }
    $tgzPath = (Resolve-Path $tgz).Path
} finally {
    Pop-Location
}

function Invoke-CurlCode([string[]]$CurlArgs) {
    $raw = & curl.exe -sS -w "`n%{http_code}" @CurlArgs
    $code = ($raw -split "`n")[-1]
    $body = (($raw -split "`n") | Select-Object -SkipLast 1) -join "`n"
    return @{ Code = $code; Body = $body }
}

function Publish-Flows([string]$JsonPath) {
    return Invoke-CurlCode @(
        "-X", "POST", $flowsUri,
        "-H", "Content-Type: application/json",
        "-H", "Node-RED-Deployment-Type: full",
        "--data-binary", "@$JsonPath"
    )
}

$flowsUri = "http://${HostName}:${Port}/flows"
$uri = "http://${HostName}:${Port}/nodes"
$mod = "node-red-contrib-de-esp32"
$parkJs = Join-Path $PSScriptRoot "nodered_flows_park.js"
$work = Join-Path $env:TEMP "de-esp32-nodered-push"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$origRaw = Join-Path $work "flows-orig-raw.json"
$origPath = Join-Path $work "flows-orig.json"
$parkPath = Join-Path $work "flows-park.json"
$parked = $false

Write-Host "GET $flowsUri"
curl.exe -sS -f -o $origRaw $flowsUri
if ($LASTEXITCODE -ne 0) {
    Write-Error "GET /flows failed"
    exit 1
}
node $parkJs array $origRaw $origPath
node $parkJs park $origRaw $parkPath

Write-Host "DELETE $uri/$mod"
$del = Invoke-CurlCode @("-X", "DELETE", "$uri/$mod")
if ($del.Code -eq "400" -and $del.Body -match "type_in_use") {
    Write-Host "types in use; parking de-esp32 nodes"
    $putPark = Publish-Flows $parkPath
    if ($putPark.Code -ne "200" -and $putPark.Code -ne "204") {
        Write-Error "park flows failed HTTP $($putPark.Code)`n$($putPark.Body)"
        exit 1
    }
    $parked = $true
    $del = Invoke-CurlCode @("-X", "DELETE", "$uri/$mod")
}
if ($del.Code -ne "200" -and $del.Code -ne "204" -and $del.Code -ne "404") {
    Write-Host "uninstall HTTP $($del.Code) (continuing)"
}

Write-Host "POST $uri  ($tgz)"
$resp = Invoke-CurlCode @("-F", "tarball=@$tgzPath", $uri)
if ($resp.Code -ne "200") {
    if ($parked) {
        Write-Host "restore flows after failed install"
        Publish-Flows $origPath | Out-Null
    }
    Write-Error "Node-RED install failed HTTP $($resp.Code)`n$($resp.Body)"
    exit 1
}

if ($parked) {
    Write-Host "restore flows"
    $putBack = Publish-Flows $origPath
    if ($putBack.Code -ne "200" -and $putBack.Code -ne "204") {
        Write-Error "restore flows failed HTTP $($putBack.Code)`n$($putBack.Body)"
        exit 1
    }
}

$body = $resp.Body

@{ host = $HostName; port = $Port; last_push = (Get-Date).ToString("o") } |
    ConvertTo-Json | Set-Content -Path $statePath -Encoding utf8

Write-Host $body
$probe = Invoke-CurlCode @("http://${HostName}:${Port}/de-esp32/pinout-template")
if ($probe.Code -ne "200") {
    Write-Host "pinout-template HTTP $($probe.Code) - runtime did not reload new routes"
} else {
    Write-Host "pinout-template ok"
}
Write-Host "Installed. Reload the Node-RED editor (browser refresh) to pick up nodes."

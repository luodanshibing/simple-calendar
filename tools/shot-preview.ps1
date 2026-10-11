# ============================================================
#  Render tools/preview.html with headless Edge -> tools/preview.png
#  ASCII-only on purpose: PowerShell 5.1 reads .ps1 as ANSI when the
#  file has no BOM, so non-ASCII inside a script gets mangled.
#  Edge cannot start inside the restricted sandbox -> run this with a
#  one-shot danger-full-access escalation.
# ============================================================
$ErrorActionPreference = 'Stop'

$dir  = $PSScriptRoot
$html = Join-Path $dir 'preview.html'
$out  = Join-Path $dir 'preview.png'
if (-not (Test-Path $html)) { throw "missing: $html" }
if (Test-Path $out) { Remove-Item $out -Force }

# file:// URI with percent-encoded non-ASCII bytes
$abs = $html.Replace('\', '/')
$sb = New-Object Text.StringBuilder
foreach ($b in [Text.Encoding]::UTF8.GetBytes($abs)) {
  if ($b -lt 128) { [void]$sb.Append([char]$b) } else { [void]$sb.Append('%' + $b.ToString('X2')) }
}
$uri = 'file:///' + $sb.ToString()

$exe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $exe)) { throw "Edge not found: $exe" }

Write-Output "rendering: $uri"
Start-Process -FilePath $exe -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  "--user-data-dir=$env:TEMP\edge-simple-calendar", '--virtual-time-budget=6000', '--hide-scrollbars',
  '--window-size=1120,520', "--screenshot=$out", $uri
) -Wait -NoNewWindow

if (Test-Path $out) {
  Write-Output ("OK: {0} ({1} KB)" -f $out, [math]::Round((Get-Item $out).Length / 1KB))
  Write-Output 'remember: copy it to assets/preview.png for the README'
} else {
  throw 'screenshot failed'
}

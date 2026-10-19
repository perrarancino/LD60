# Собирает release\LD60Editor.exe — один файл: редактор уровней в браузере по умолчанию.
#   1) npm run build (tsc + vite: редактор и игра)  2) dist -> zip (без .map)  3) компиляция Editor.cs встроенным csc.exe
# Запуск: npm run editor:exe   (или: powershell -ExecutionPolicy Bypass -File tools\launcher\build-editor-exe.ps1)
# Exe лежит в release\ внутри проекта — работает с ним (и сам пересобирает страницы, когда код изменился); вне проекта спрашивает папку проекта
# с data\ и assets\ (запоминает) и открывает вшитую копию редактора.
param(
  [string]$Version = '0.1.0'
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "Не найден csc.exe ($csc): нужен .NET Framework 4.x" }

Write-Host '==> npm run build'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Сборка не удалась' }

$work = Join-Path $root 'release\.build-editor'
New-Item -ItemType Directory -Force $work | Out-Null
$zipPath = Join-Path $work 'dist.zip'
Remove-Item $zipPath -ErrorAction SilentlyContinue

Write-Host '==> dist -> dist.zip'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$distDir = (Resolve-Path 'dist').Path
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  Get-ChildItem $distDir -Recurse -File | Where-Object { $_.Extension -ne '.map' } | ForEach-Object {
    $rel = $_.FullName.Substring($distDir.Length).TrimStart('\', '/').Replace('\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, 'Optimal')
  }
} finally { $zip.Dispose() }

$ico = Join-Path $work 'icon.ico'
$icoArg = @()
try {
  python -I -c "from PIL import Image; im=Image.open(r'assets/sprites/tiles/tileset.png').convert('RGBA'); im=im.crop((0,0,32,32)); c=Image.new('RGBA',(32,32),(0,0,0,0)); c.paste(im,(0,0)); c.resize((256,256),Image.NEAREST).save(r'$ico',sizes=[(16,16),(32,32),(48,48),(256,256)])" 2>$null
  if (Test-Path $ico) { $icoArg = @("/win32icon:$ico") }
} catch { }

Write-Host '==> csc'
$numeric = ($Version -split '-')[0]
$asmInfo = Join-Path $work 'AssemblyInfo.cs'
@"
using System.Reflection;
[assembly: AssemblyTitle("LD60 Level Editor")]
[assembly: AssemblyProduct("LD60 Level Editor")]
[assembly: AssemblyVersion("$numeric.0")]
[assembly: AssemblyFileVersion("$numeric.0")]
[assembly: AssemblyInformationalVersion("$Version")]
"@ | Set-Content -Path $asmInfo -Encoding UTF8

$out = Join-Path $root 'release\LD60Editor.exe'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
# Запущенный exe заблокирован для записи, но его можно переименовать — старый продолжит работать, новый встанет на его место
if (Test-Path $out) {
  try { Remove-Item $out -Force -ErrorAction Stop }
  catch {
    $old = Join-Path $root 'release\LD60Editor.old.exe'
    Remove-Item $old -Force -ErrorAction SilentlyContinue
    Move-Item $out $old -Force
    Write-Host 'Старый LD60Editor.exe сейчас запущен: переименован (закройте редактор, чтобы удалить .old.exe)'
  }
}
& $csc /nologo /codepage:65001 /target:winexe "/out:$out" "/resource:$zipPath,dist.zip" `
  /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll /reference:System.Web.Extensions.dll @icoArg `
  (Join-Path $PSScriptRoot 'Editor.cs') $asmInfo
if ($LASTEXITCODE -ne 0) { throw 'Компиляция не удалась' }

Write-Host ("Готово: {0} ({1:N0} КБ)" -f $out, ((Get-Item $out).Length / 1KB))

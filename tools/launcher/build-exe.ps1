# Собирает release\LD60.exe — один файл, запускающий игру в браузере.
# Если exe лежит в папке release внутри проекта, он при каждой перезагрузке страницы сам пересобирает игру (npm run build), когда
# исходники изменились; иначе берёт вшитую копию (dist.zip, версия на момент сборки exe).
#   1) npm run build (tsc + vite)  2) dist -> zip (без .map)  3) компиляция Launcher.cs встроенным csc.exe
# Запуск: npm run exe   (или: powershell -ExecutionPolicy Bypass -File tools\launcher\build-exe.ps1)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "Не найден csc.exe ($csc): нужен .NET Framework 4.x" }

Write-Host '==> npm run build'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Сборка игры не удалась' }

$work = Join-Path $root 'release\.build'
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

# Иконка из спрайта героя (если есть Python + Pillow)
$ico = Join-Path $work 'icon.ico'
$icoArg = @()
try {
  python -I -c "from PIL import Image; im=Image.open(r'assets/sprites/player/player.png').convert('RGBA'); im=im.crop(im.getbbox()); s=max(im.size); c=Image.new('RGBA',(s,s),(0,0,0,0)); c.paste(im,((s-im.width)//2,(s-im.height)//2)); c.resize((256,256),Image.NEAREST).save(r'$ico',sizes=[(16,16),(32,32),(48,48),(256,256)])" 2>$null
  if (Test-Path $ico) { $icoArg = @("/win32icon:$ico") }
} catch { }

Write-Host '==> csc'
$out = Join-Path $root 'release\LD60.exe'
# Запущенный exe заблокирован для записи, но его можно переименовать — старый продолжит работать, новый встанет на его место
if (Test-Path $out) {
  try { Remove-Item $out -Force -ErrorAction Stop }
  catch {
    $old = Join-Path $root 'release\LD60.old.exe'
    Remove-Item $old -Force -ErrorAction SilentlyContinue
    Move-Item $out $old -Force
    Write-Host 'Старый LD60.exe сейчас запущен: переименован в LD60.old.exe (закройте игру, чтобы удалить)'
  }
}
& $csc /nologo /codepage:65001 /target:winexe "/out:$out" "/resource:$zipPath,dist.zip" `
  /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll @icoArg `
  (Join-Path $PSScriptRoot 'Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Компиляция лаунчера не удалась' }

Write-Host ("Готово: {0} ({1:N0} КБ)" -f $out, ((Get-Item $out).Length / 1KB))

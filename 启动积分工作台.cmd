@echo off
rem ===========================================================
rem 本文件必须保存为 ANSI/GBK 编码 + CRLF 换行。
rem 改用 UTF-8 或 LF 会导致 CMD 解析错乱（把提示文字当成命令）。
rem ===========================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 未检测到 Node.js，请先安装 Node.js 18 或更高版本。
  echo   下载地址: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "credit-workbench.html" (
  echo.
  echo   [错误] 当前目录找不到 credit-workbench.html。
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { Invoke-WebRequest 'http://127.0.0.1:8797/api/health' -UseBasicParsing -TimeoutSec 1 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "积分同步服务" /min cmd /c "node sync\server.js"
  timeout /t 2 >nul
)

start "" "credit-workbench.html"
endlocal

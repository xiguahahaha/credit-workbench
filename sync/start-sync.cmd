@echo off
rem 本文件必须保存为 ANSI/GBK 编码 + CRLF 换行（勿改为 UTF-8 或 LF）。
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

node server.js
pause
endlocal

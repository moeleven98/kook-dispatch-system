@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没找到 Node.js，请先到 https://nodejs.org 安装 LTS 版本（22.5 或更高）。
  pause
  exit /b 1
)
node scripts\start.mjs
pause

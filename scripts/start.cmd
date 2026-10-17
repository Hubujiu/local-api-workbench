@echo off
cd /d "%~dp0.."
where node >nul 2>nul || (echo Install Node.js 24 LTS first. & pause & exit /b 1)
start "Local API" http://127.0.0.1:4318
node src/server.mjs
pause

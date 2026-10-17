@echo off
cd /d "%~dp0.."
where node >nul 2>nul || (echo Install Node.js 24 LTS first. & pause & exit /b 1)
echo Open the local URL printed below. It contains a per-run access token.
node src/server.mjs
pause

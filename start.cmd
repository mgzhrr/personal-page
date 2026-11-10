@echo off
rem Start the local preview server and open the site. Needs Node.js. Optional: start.cmd 3000
cd /d "%~dp0"
set PORT=%1
if "%PORT%"=="" set PORT=8080
start "" http://localhost:%PORT%/
node serve.mjs %PORT%

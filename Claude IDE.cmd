@echo off
rem Starts the Claude IDE server and opens it in its own app window.
rem Keep this console open: closing it stops any Claude sessions running inside the IDE.
cd /d "%~dp0"
title Claude IDE server
if not exist node_modules (
  echo Installing dependencies...
  call npm install || exit /b 1
)
node server\index.js --app

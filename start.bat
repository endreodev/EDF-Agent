@echo off
title Agente WhatsApp - Claude
cd /d "%~dp0"
if not exist node_modules call npm install
:loop
node src\index.js
echo.
echo Processo encerrado. Reiniciando em 5 segundos... (Ctrl+C para sair)
timeout /t 5 /nobreak >nul
goto loop

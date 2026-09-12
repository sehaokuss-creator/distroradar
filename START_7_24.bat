@echo off
title DistroRadar Pro 7/24
cd /d "%~dp0"
echo ========================================================
echo  DistroRadar Pro 7/24 Kesintisiz Sunucu Baslatiliyor...
echo ========================================================
start /b node server.js
timeout /t 2 /nobreak >nul
.\cloudflared.exe tunnel --url http://localhost:3000
pause

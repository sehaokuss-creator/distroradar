@echo off
chcp 65001 >nul
title DistroRadar Pro - Cloudflare & Sunucu Başlatıcı
cd /d "%~dp0"
color 0b

echo =====================================================================
echo       🎵 DISTRORADAR PRO - KESİNTİSİZ SUNUCU & CLOUDFLARE TÜNELİ
echo =====================================================================
echo.
echo  [1/3] Node.js sunucusu kontrol ediliyor...

netstat -ano | findstr :3000 | findstr LISTENING >nul
if %errorlevel% equ 0 (
    echo  [OK] Node.js sunucusu (Port 3000) zaten aktif calisiyor!
) else (
    echo  [!] Sunucu baslatiliyor (node server.js)...
    start /min "DistroRadar Node Server" cmd /c "node server.js"
    timeout /t 2 /nobreak >nul
)

echo.
echo  [2/3] Tarayıcı açılıyor...
start https://distrofind.vercel.app

echo.
echo  [3/3] Cloudflare Tüneli Başlatılıyor...
echo  -----------------------------------------------------------------
echo  * Vercel Kalıcı Link : https://distrofind.vercel.app
echo  * Admin Paneli       : https://distrofind.vercel.app/admin-panel
echo  * Cloudflare Linki   : Aşağıda belirecektir (https://...trycloudflare.com)
echo  -----------------------------------------------------------------
echo.

.\cloudflared.exe tunnel --url http://localhost:3000

pause

@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 邻波 LinkWave - 打包安卓 APK
echo 正在打包安卓完整应用...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-android.ps1"
if errorlevel 1 goto failed
if not exist "%~dp0dist\邻波-LinkWave-Android.apk" goto failed
echo.
echo 打包完成：%~dp0dist\邻波-LinkWave-Android.apk
if /i "%LINKWAVE_BUILD_NONINTERACTIVE%"=="1" exit /b 0
start "" explorer.exe /select,"%~dp0dist\邻波-LinkWave-Android.apk"
pause
exit /b 0
:failed
echo.
echo 安卓打包失败，请查看上方错误信息。
if /i not "%LINKWAVE_BUILD_NONINTERACTIVE%"=="1" pause
exit /b 1

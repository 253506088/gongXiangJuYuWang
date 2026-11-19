@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 邻波 LinkWave - Windows 完整版
echo 邻波 Windows 完整版：自动发现、文件互传、影音共享、下载链接。
echo 保持此窗口运行，关闭服务请按 Ctrl+C。
if exist LinkWave.exe (LinkWave.exe --lan %*) else if exist dist\LinkWave.exe (dist\LinkWave.exe --lan %*) else (
  echo 未找到 LinkWave.exe，请先解压完整 Windows 压缩包。
  pause
  exit /b 1
)
if errorlevel 1 pause

@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
title 邻波 LinkWave - 一键打包
echo.
echo  邻波 LinkWave 一键打包
echo  将生成 Windows EXE、便携 ZIP、Android APK 和源码 ZIP。
echo  参数 --windows-only 可以只打包 Windows。
echo.
where node >nul 2>nul
if errorlevel 1 goto missing_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if not errorlevel 1 goto ready
where nvm >nul 2>nul
if errorlevel 1 goto old_node
echo 正在通过 nvm 切换至 Node 24...
call nvm use 24
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if not errorlevel 1 goto ready
call nvm use 22
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto old_node
:ready
echo 当前 Node 版本：
node --version
if exist node_modules\@yao-pkg\pkg\lib-es5\bin.js goto build
echo 安装锁定版本的依赖...
call npm ci --no-audit --no-fund
if errorlevel 1 goto failed
:build
node scripts\build.js %*
if errorlevel 1 goto failed
echo.
echo 打包成功，文件位于 dist 文件夹。
start "" explorer.exe "%cd%\dist"
pause
exit /b 0
:missing_node
echo 未找到 Node.js。请安装 Node 22 或 24，或用 nvm 配置。
goto failed
:old_node
echo 需要 Node 22 或 24。请通过 nvm 切换后重新运行。
goto failed
:failed
echo.
echo 打包未完成，请查看上方的错误信息。
pause
exit /b 1

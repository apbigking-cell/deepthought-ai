@echo off
chcp 65001 >nul
echo ========================================
echo   深念 DeepThought - AI 陪聊机器人
echo   启动 Web 管理面板 + 微信 Bot
echo ========================================
echo.

set NODE_PATH=D:\workbuddy\DeepThought\node_modules

"D:\workbuddy\node24\node-v24.11.0-win-x64\node.exe" "D:\workbuddy\DeepThought\src\index.js" --webui

pause

@echo off
chcp 65001 > nul
title 화물진행정보 모니터링 서버

echo.
echo  ============================================
echo   화물진행정보 모니터링 서버 시작 중...
echo  ============================================
echo.

cd /d "%~dp0"

:: Node.js 설치 확인
where node >nul 2>&1
if errorlevel 1 (
    echo  [오류] Node.js가 설치되어 있지 않습니다.
    echo  https://nodejs.org 에서 설치 후 다시 실행하세요.
    pause
    exit /b
)

:: 서버 시작 후 3초 뒤 브라우저 자동 오픈
start "" /b timeout /t 3 /nobreak >nul && start http://localhost:3000

node server.js

pause

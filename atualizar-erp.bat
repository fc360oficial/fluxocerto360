@echo off
title Atualizando FC360...
cd /d C:\fc360\claude_code_\claude_code_
echo.
echo [1/3] Buscando atualizacoes...
git fetch origin
echo.
echo [2/3] Aplicando atualizacoes...
git reset --hard origin/main
echo.
echo [3/3] Reiniciando servidor...
pm2 restart fc360
echo.
echo Pronto! Servidor atualizado e reiniciado.
echo.
pause

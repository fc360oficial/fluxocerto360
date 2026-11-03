@echo off
rem Agendador (FC360Push) a cada 5 min: sobe o processo continuo se ele caiu
cd /d %~dp0
node fc360-push.js >> data\push.log 2>&1

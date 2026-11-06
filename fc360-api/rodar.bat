@echo off
rem FC360 API no .254. Normalmente quem sobe este processo e o mantem vivo e o
rem Econômico Relatórios (lib/fc360-api-proxy.js). Este .bat serve pra subir na
rem mao ou por tarefa agendada (FC360Api, a cada 5 min, igual ao FC360Push).
cd /d %~dp0
node fc360-api.js >> data\api.log 2>&1

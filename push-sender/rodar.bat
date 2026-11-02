@echo off
rem Chamado pelo Agendador de Tarefas a cada 5 minutos (tarefa FC360Push)
cd /d %~dp0
node fc360-push.js >> data\push.log 2>&1

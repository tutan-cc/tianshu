@echo off
node "%~dp0serve-city-trial.cjs" --open
if errorlevel 1 pause

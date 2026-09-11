@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title Instalador QualityTech POS - Asocampo

rem ============================================================================
rem  Instalador / puesta a punto cero - Asocampo
rem
rem  Uso:
rem    instalar-asocampo.bat
rem        Respalda la base de produccion y la deja en punto cero.
rem
rem    instalar-asocampo.bat "D:\ruta\flo.db"
rem        Ademas promueve esa base a produccion antes del punto cero.
rem
rem    instalar-asocampo.bat "" "D:\carpeta-de-datos"
rem        Trabaja sobre otra carpeta de datos (util para ensayar).
rem
rem  No necesita sqlite3.exe: usa el modulo sqlite que viene dentro de Node.
rem ============================================================================

set "AQUI=%~dp0"
set "ORIGEN=%~1"
set "DATOS=%~2"
if "%DATOS%"=="" set "DATOS=%APPDATA%\QualityTech POS"
set "RESPALDOS=%DATOS%\respaldos-instalacion"
set "HERRAMIENTA=%AQUI%herramienta.js"
set "GUION=%AQUI%punto-cero.sql"

echo.
echo ============================================================
echo   QualityTech POS - Asocampo
echo ============================================================
echo.
echo   Carpeta de datos : %DATOS%
if not "%ORIGEN%"=="" echo   Base a promover  : %ORIGEN%
echo   Respaldos        : %RESPALDOS%
echo.
echo   Esto va a:
echo     1. Cerrar la aplicacion si esta abierta
echo     2. Respaldar la base actual
if not "%ORIGEN%"=="" echo     3. Reemplazar la base de produccion por la indicada
echo     4. Borrar ventas, caja y cierres (los productos y precios se quedan)
echo.

rem --- Comprobaciones previas -------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   [X] No se encontro Node.js en el PATH.
  echo       Instalelo desde https://nodejs.org ^(version 22 o superior^) y repita.
  goto :fin_error
)
for /f "delims=" %%v in ('node --version') do set "NODEV=%%v"
echo   Node detectado: !NODEV!

if not exist "%HERRAMIENTA%" (
  echo   [X] Falta herramienta.js junto a este .bat
  goto :fin_error
)
if not exist "%GUION%" (
  echo   [X] Falta punto-cero.sql junto a este .bat
  goto :fin_error
)
if not "%ORIGEN%"=="" if not exist "%ORIGEN%" (
  echo   [X] No existe la base de origen: %ORIGEN%
  goto :fin_error
)

echo.
set /p "RESP=   Escriba SI para continuar: "
if /i not "!RESP!"=="SI" goto :cancelado

rem --- 1. Cerrar la aplicacion ------------------------------------------------
echo.
echo   [1/5] Cerrando la aplicacion...
tasklist /FI "IMAGENAME eq QualityTech POS.exe" 2>nul | find /I "QualityTech POS.exe" >nul
if not errorlevel 1 (
  taskkill /F /IM "QualityTech POS.exe" /T >nul 2>&1
  echo         cerrada.
) else (
  echo         no estaba abierta.
)
rem SQLite necesita un momento para soltar el archivo -wal.
ping -n 4 127.0.0.1 >nul

rem --- 2. Respaldar -----------------------------------------------------------
echo.
echo   [2/5] Respaldando la base actual...
if exist "%DATOS%\flo.db" (
  node "%HERRAMIENTA%" respaldar "%DATOS%" "%RESPALDOS%"
  if errorlevel 1 goto :fin_error
) else (
  echo         no hay base todavia; nada que respaldar.
  if "%ORIGEN%"=="" (
    echo   [X] Sin base y sin origen que promover: no hay sobre que trabajar.
    echo       Instale primero la aplicacion, o pase la ruta de una base de origen.
    goto :fin_error
  )
)

rem --- 3. Promover la base indicada ------------------------------------------
echo.
if not "%ORIGEN%"=="" (
  echo   [3/5] Promoviendo la base indicada a produccion...
  node "%HERRAMIENTA%" promover "%ORIGEN%" "%DATOS%"
  if errorlevel 1 goto :fin_error
) else (
  echo   [3/5] Sin base de origen: se conserva la que ya estaba.
)

rem --- 4. Punto cero ----------------------------------------------------------
echo.
echo   [4/5] Dejando la base en punto cero...
node "%HERRAMIENTA%" puntocero "%DATOS%" "%GUION%"
if errorlevel 1 goto :fin_error

rem --- 5. Verificacion final --------------------------------------------------
echo.
echo   [5/5] Verificacion final...
node "%HERRAMIENTA%" verificar "%DATOS%"
if errorlevel 1 goto :fin_error

echo.
echo ============================================================
echo   LISTO. La caja arranca en cero y el catalogo quedo intacto.
echo.
echo   El respaldo esta en:
echo   %RESPALDOS%
echo.
echo   Abra QualityTech POS y confirme que ve sus productos.
echo ============================================================
goto :fin_ok

:cancelado
echo.
echo   Cancelado. No se toco nada.
echo.
pause
endlocal
exit /b 0

:fin_error
echo.
echo ============================================================
echo   SE DETUVO POR UN ERROR. No se completo el proceso.
echo   Si ya se hizo el respaldo, esta en:
echo   %RESPALDOS%
echo ============================================================
echo.
pause
endlocal
exit /b 1

:fin_ok
echo.
pause
endlocal
exit /b 0

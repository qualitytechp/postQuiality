@echo off
rem ============================================================================
rem  ESTRENAR — Asocampo
rem
rem  Deja el sistema como el primer dia: SOLO los clientes y los productos.
rem  Borra ventas, caja, compras, proveedores, cartera y cuentas por pagar.
rem
rem  Uso:
rem    estrenar-asocampo.bat "C:\ruta\flo.db"    promueve esa base y la estrena
rem    estrenar-asocampo.bat                     estrena la que ya esta instalada
rem
rem  Es lo mismo que instalar-asocampo.bat pero con el script de arranque
rem  limpio. Existe aparte para que nadie tenga que acordarse de un parametro
rem  el dia de la implementacion.
rem ============================================================================

call "%~dp0instalar-asocampo.bat" %1 %2 arranque-limpio.sql
exit /b %errorlevel%

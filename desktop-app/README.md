# AYLYES Launcher (app de escritorio)

App de Windows tipo GoLogin/Multilogin/Incogniton: eliges un pais desde una
ventana chiquita y se abre un Chrome real **en tu propia PC** usando el
proxy de ese pais -- misma cuenta y creditos que el panel web, mismo login
con Telegram+OTP.

A diferencia de la extension de Chrome, esta app no depende de que el
navegador soporte extensiones -- es un programa aparte, asi que sirve igual
aunque la persona use el Chrome oficial normal.

## Para usarla ya (sin instalar nada de nuevo)

Ya viene compilada. Descomprime `aylyes-launcher-windows.zip` en cualquier
carpeta y corre **`AYLYES Launcher.exe`**. Necesitas tener Chrome, Edge o
Brave ya instalado en esa PC (la app los usa, no trae uno propio).

## Antes de compartirla con un amigo

Edita `config.js` (dentro de `resources/app/config.js` en la carpeta ya
compilada, o `desktop-app/config.js` en el codigo fuente) con la URL real
del servidor AYLYES, y vuelve a compilar (ver abajo) si ya la habias hecho
con localhost.

## Compilar desde el codigo fuente

```bash
cd desktop-app
npm install
npm start                 # prueba la app en modo desarrollo (ventana normal)
npx electron-packager . "AYLYES Launcher" --platform=win32 --arch=x64 --out=dist --icon=icon.png --overwrite
```

Esto genera `dist/AYLYES Launcher-win32-x64/AYLYES Launcher.exe` -- comprime
esa carpeta completa (no solo el .exe, necesita todos los archivos de al
lado) y compartela.

## Como funciona por dentro

- Usa el mismo login por token que la extension de Chrome
  (`/api/extension/login`, `/verify-otp`, `/me`, `/countries`, `/proxy`).
- Para abrir Chrome real usa la misma tecnica que `browserLauncher.js` del
  servidor: Puppeteer + un mini-proxy local (`proxy-chain`) entre Chrome y
  el proxy real, para poder cambiar de IP sin reiniciar la ventana.
- El token de sesion se guarda en el perfil de usuario de Windows
  (`%APPDATA%\aylyes-launcher\session.json`), asi no hay que loguearse cada
  vez que se abre la app.

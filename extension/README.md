# Extension AYLYES PANEL (Chrome / Edge / Brave / Opera)

Elige un pais desde el icono de la extension y tu navegador real queda
usando ese proxy directo -- sin abrir ventanas aparte, sin reescritura de
HTML, compatibilidad total con cualquier pagina (Canva, YouTube, lo que
sea), porque el Chrome que ya usas es el que conecta.

## Instalar (modo desarrollador, sin subirla a ninguna tienda)

1. Antes de instalar, edita `config.js` y pon la URL real de tu servidor
   AYLYES en `API_BASE` (por defecto apunta a `http://localhost:3000`).
2. Abre `chrome://extensions` (o `edge://extensions`, `brave://extensions`).
3. Activa **Modo de desarrollador** (arriba a la derecha).
4. **Cargar descomprimida** -> selecciona esta carpeta (`extension/`).
5. Listo, ya aparece el icono de AYLYES en la barra de extensiones.

## Como se usa

1. Clic en el icono -> inicia sesion con tu usuario/clave de AYLYES.
2. Si tu cuenta tiene Telegram vinculado, te pide el codigo que te llega por
   el bot.
3. Elige un pais del menu y dale **Conectar**.
4. Listo -- cualquier pestaña nueva que abras (o recargues) sale con esa IP.
   El icono muestra el codigo del pais mientras esta conectado.
5. La sesion dura 10 minutos (igual que en el panel web). Te avisa 1 minuto
   antes y se desconecta sola al terminar -- vuelve a abrir la extension y
   elige pais de nuevo cuando quieras seguir.
6. **Desconectar** en cualquier momento vuelve tu navegador a su conexion
   normal.

## Notas

- Cada usuario de AYLYES gasta sus propias sesiones/creditos igual que con
  el modo "Navegar aqui" del panel -- comparten el mismo limite.
- El icono/nombre son genericos (`icons/icon*.png`, generados simples) --
  si quieres, reemplazalos por tu propio logo, mismo nombre de archivo.
- Si algun dia la quieres publicar en la Chrome Web Store, hay que pagar el
  registro de desarrollador de Google (25 USD, una sola vez) y pasar su
  revision. Mientras tanto, "cargar descomprimida" es gratis y funciona
  igual, solo que cada amigo tiene que instalarla asi en su propio Chrome.

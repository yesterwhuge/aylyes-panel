# AYLYES PANEL

Panel con login para navegar con proxies residenciales de Webshare, organizados por pais. Un solo servidor compartido: tus amigos entran con su propia cuenta y cada quien tiene su sesion aislada.

## Requisitos

- **Node.js** (v18 o mas reciente) — https://nodejs.org
- Una cuenta de **Webshare** con plan de proxies residenciales, y su API Key.
- (Opcional, solo para el modo "Chrome real") Google Chrome instalado en la maquina que corre el servidor.

## Instalacion

1. Copia esta carpeta a la computadora que va a hacer de servidor (la que queda prendida para que tus amigos se conecten).
2. Abre una terminal dentro de la carpeta y corre:
   ```
   npm install
   ```
3. Crea un archivo llamado `.env` (copia `.env.example` y renombralo):
   ```
   WEBSHARE_API_KEY=tu_api_key_aqui
   SESSION_SECRET=un_texto_largo_al_azar
   ```
   La API key se saca en https://proxy.webshare.io/userapi/keys

## Arrancar el servidor

```
npm start
```

Abre **http://localhost:3000** (o la IP/dominio de tu servidor si tus amigos se conectan desde otro lugar). Te va a pedir usuario y clave.

## Agregar amigos (cuentas)

Cada amigo necesita su propia cuenta para entrar. Tu (el dueno) las creas desde la terminal:

```
node auth.js add nombreamigo claveparaese_amigo
```

Eso le da acceso indefinido (como tu cuenta admin). Si quieres que se le venza el acceso
despues de X dias, agrega el numero de dias al final:

```
node auth.js add nombreamigo claveparaese_amigo 5
```

Pasados esos 5 dias, esa cuenta ya no puede entrar (y si estaba conectada, se le cierra
la sesion sola en la siguiente accion que haga).

Para darle mas dias a una cuenta que ya tiene (se suman a los que le queden, o empiezan
de hoy si ya se vencio):
```
node auth.js extend nombreamigo 7
```

Para quitar a alguien:
```
node auth.js remove nombreamigo
```

Para ver la lista de cuentas y cuando vencen:
```
node auth.js list
```

Para cambiar tu propio usuario/clave (o el de cualquiera):
```
node auth.js rename usuario_actual usuario_nuevo clave_nueva
```
(la clave nueva es opcional -- si la omites, solo cambia el nombre de usuario)

La cuenta admin ya no depende de llamarse "admin": el panel de administracion
lo ve quien tenga la marca de admin en su cuenta, asi que puedes renombrarte
sin perder el acceso al panel de administracion. Tambien puedes crear/gestionar
usuarios y ver el consumo de Webshare desde el propio panel web (boton "Admin"),
sin usar la terminal.

## Los dos modos de navegacion

Al elegir un pais, el panel pregunta que modo usar:

- **Chrome real** — abre una ventana de Chrome de verdad, pero SOLO se ve en la computadora donde corre el servidor. Util si tu mismo lo usas localmente.
- **Navegar aqui** — funciona para cualquiera conectado remotamente (esta es la opcion para tus amigos). Es un navegador embebido dentro de la pagina; algunos sitios muy pesados en JavaScript pueden no cargar perfecto.

## Notas importantes

- Todos los usuarios comparten el mismo pool de proxies de tu cuenta de Webshare (mismo consumo/plan).
- Sitios con deteccion de bots fuerte (Facebook, Amazon) pueden seguir pidiendo verificacion extra aunque la IP sea residencial de pago. Prime Video no puede funcionar por esta via porque requiere DRM de navegador con licencia.
- Si despliegas esto en un servidor en la nube (Railway, etc.), el modo "Chrome real" no va a funcionar ahi (no tiene pantalla) — usa "Navegar aqui" en ese caso.

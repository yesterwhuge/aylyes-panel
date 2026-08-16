# Auto-deploy: el servidor se actualiza solo con cada `git push`

Esto hace que en cuanto suben un cambio a GitHub, el servidor donde este
corriendo la app haga `git pull` y se reinicie solo, sin que nadie tenga que
entrar a tocarlo.

Estos pasos los sigue **la persona que tiene el servidor** (una sola vez).

## 1. Instalar pm2 (maneja el proceso de Node para que se pueda reiniciar solo)

```bash
npm install -g pm2
cd aylyes-panel
pm2 start server.js --name aylyes-panel
pm2 save
pm2 startup   # sigue las instrucciones que te da para que arranque solo si el servidor se reinicia
```

## 2. Generar un secreto para el webhook

Cualquier cadena larga random, por ejemplo:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Agrega esa cadena a tu `.env`:

```
GITHUB_WEBHOOK_SECRET=el_valor_que_generaste
WEBHOOK_PORT=4000
PM2_APP_NAME=aylyes-panel
```

## 3. Arrancar el listener del webhook (proceso aparte, siempre corriendo)

```bash
pm2 start deploy/webhook-server.js --name aylyes-webhook
pm2 save
```

## 4. Abrir el puerto 4000 hacia internet

GitHub necesita poder llegarle a este servidor por ese puerto. Segun donde
este alojado:
- **VPS con firewall (ufw, iptables, etc.)**: abre el puerto 4000.
- **Detras de un router casero**: hay que hacer port-forwarding del 4000 al
  servidor, y usar la IP publica de la casa (o mejor, poner un dominio con
  Cloudflare Tunnel / ngrok si no quieren exponer la IP directo).
- Lo mas simple y seguro si van a usar esto seguido: poner un dominio con
  proxy inverso (nginx) que redirija `/webhook` al puerto 4000, y usar HTTPS.

## 5. Configurar el webhook en GitHub

1. Entra a `https://github.com/yesterwhuge/aylyes-panel/settings/hooks`
2. **Add webhook**
3. **Payload URL**: `http://IP-O-DOMINIO-DEL-SERVIDOR:4000/webhook`
4. **Content type**: `application/json`
5. **Secret**: el mismo valor que pusiste en `GITHUB_WEBHOOK_SECRET`
6. **Which events**: "Just the push event"
7. Guardar.

GitHub manda un ping de prueba apenas lo guardas -- si en los logs del
servidor (`pm2 logs aylyes-webhook`) ves que llego, ya quedo funcionando.

## Como se ve el flujo de ahi en adelante

1. Se hace un cambio y `git push` (desde aqui, con Claude).
2. GitHub le avisa al servidor al instante.
3. El servidor valida que el aviso sea legitimo (compara la firma con el
   secreto -- por eso nadie mas puede forzar un deploy falso).
4. Hace `git pull`, instala dependencias nuevas si hizo falta, y reinicia
   `aylyes-panel` con pm2.
5. Todo esto sin que nadie entre a la terminal del servidor.

## Revisar que este funcionando

```bash
pm2 logs aylyes-webhook   # ve los deploys en vivo
pm2 status                # ve si aylyes-panel y aylyes-webhook estan "online"
```

# Runna.io

Corre y conquista tu ciudad. Cada carrera convierte tu recorrido en territorio en el mapa. Si corres por el territorio de un amigo, se lo robas. En las competiciones aparecen cofres con poderes.

- **App de iPhone**: SwiftUI nativa (iOS 17+) en [`ios/`](ios/README.md). Es el único cliente: la web se ha retirado.
- **API**: Cloudflare Worker (Hono) en [`worker/`](worker/), base de datos Turso (libSQL/SQLite) con Drizzle ORM.

## Estructura

```
runna-io/
├── ios/                    App nativa de iPhone (Xcode, SwiftUI)
├── worker/                 API en Cloudflare Workers (Hono)
│   └── src/
│       ├── index.ts        Entrada: fetch, cron (scheduled) y cola de territorio
│       ├── routes.ts       Endpoints /api/*
│       ├── cron.ts         Tareas programadas (se ejecutan dentro del Worker)
│       ├── pages.ts        Páginas públicas: /privacy, /terms, /support, /invite, /open
│       ├── garmin.ts       Garmin Connect (OAuth2 PKCE + Activity API push)
│       ├── coros.ts        COROS (OAuth2 + push de entrenamientos + ficheros FIT)
│       ├── auth.ts         Sesiones (Bearer token), admin, OAuth state, tareas
│       ├── passwords.ts    Hash de contraseñas (PBKDF2)
│       ├── pushHelper.ts   Notificaciones push APNs (iPhone)
│       ├── email.ts        Emails (SendGrid / Resend)
│       └── storage.ts      Acceso a datos
├── shared/schema.ts        Esquema de la base de datos (Drizzle)
├── migrations/             SQL de migraciones
├── wrangler.worker.toml    Configuración del Worker
├── scripts/e2e/            API local con datos de prueba (usada por el CI de iOS)
└── scripts/maintenance/    Scripts puntuales contra la base de datos (léelos antes de ejecutarlos)
```

## API en local

Necesitas Node.js 20 o superior.

```bash
npm ci --legacy-peer-deps
(cd worker && npm ci)
npm run check        # comprueba los tipos de shared/
```

La forma más rápida de tener una API local con datos es la de las pruebas end-to-end: ejecuta el Worker en Node con una base de datos SQLite de prueba y la llena con usuarios, amigos, carreras que crean y roban territorio, comentarios y una competición activa (cofres, poderes y resumen semanal).

```bash
mkdir -p scripts/e2e/.build
npx esbuild worker/src/index.ts --bundle --format=esm --platform=node --target=node20 \
  --outfile=scripts/e2e/.build/worker.mjs --alias:@libsql/client/web=@libsql/client --alias:cloudflare:sockets=./scripts/e2e/cloudflare-sockets-stub.mjs --external:@libsql/client
rm -f scripts/e2e/.build/e2e.db
DATABASE_URL=file:scripts/e2e/.build/e2e.db npx drizzle-kit push --force
node scripts/e2e/server.mjs      # API de prueba en http://127.0.0.1:8787
node scripts/e2e/seed.mjs        # en otra terminal; imprime un token y un userId de prueba
```

Con `E2E_RUN_CRON=1` (y opcionalmente `E2E_CRON_TIME`), `server.mjs` ejecuta una vez las tareas programadas al arrancar.

Para apuntar la app del simulador a esta API, ver [`ios/README.md`](ios/README.md). El workflow `.github/workflows/ios.yml` hace exactamente esto en un Mac de GitHub Actions y saca capturas de cada pantalla.

También puedes usar `wrangler dev` (`npm run worker:dev`, con wrangler instalado: `npm i -g wrangler` o `npx wrangler` desde `worker/`), que necesita los secretos en `.dev.vars`.

## Desplegar el Worker

```bash
(cd worker && npm ci)
npx wrangler deploy -c wrangler.worker.toml
```

`wrangler.worker.toml` declara un único Cron Trigger (`*/5 * * * *`). Cada ejecución corre dentro del propio Worker las tareas que tocan (horario Europe/Madrid, ver `worker/src/cron.ts`):

| Tarea | Cuándo |
|---|---|
| polar-auto-sync | cada 5 minutos |
| spawn-treasure | en el minuto 0 de cada hora (la tarea elige la hora del día) |
| inactivity-check | 10:00 y 19:00 |
| weekly-summary | domingos a las 20:00 |

**Upstash QStash ya no hace falta**: borra las programaciones antiguas. Los endpoints `/api/tasks/*` siguen aceptando `Authorization: Bearer <UPSTASH_CRON_SECRET>` (o una firma de QStash) para lanzarlos a mano.

La cola `territory-processing` (y su DLQ `territory-dlq`) se crea una vez con `npx wrangler queues create ...`.

### Secretos y variables del Worker

Los secretos se configuran con `npx wrangler secret put <NOMBRE> -c wrangler.worker.toml`.

| Nombre | Obligatorio | Para qué |
|---|---|---|
| `DATABASE_URL`, `TURSO_AUTH_TOKEN` | Sí | Base de datos Turso |
| `UPSTASH_CRON_SECRET` | Sí | Secreto de administración: endpoints `/api/admin/*` y lanzar `/api/tasks/*` a mano (`Authorization: Bearer <secreto>`). El nombre es histórico; ya no se usa Upstash |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_PRIVATE_KEY` | Sí | Notificaciones push en el iPhone ([ver guía](ios/README.md#notificaciones-push-apns)) |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY_TOKEN` | Para Strava | Conexión con Strava |
| `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET` | Para Polar | Conexión con Polar |
| `GMAIL_APP_PASSWORD` | Para emails | Contraseña de aplicación de la cuenta de Gmail que envía los emails (`GMAIL_USER` en `[vars]`): códigos de verificación, "He olvidado mi contraseña", avisos y denuncias. Ver [Emails](#emails) |
| `SENDGRID_API_KEY` / `RESEND_API_KEY` | No | Alternativas a Gmail (`EMAIL_PROVIDER` en `[vars]` elige el proveedor); las dos necesitan un dominio propio verificado |
| `GARMIN_CLIENT_ID`, `GARMIN_CLIENT_SECRET` | Para Garmin | Consumer key y secret de la app en el portal de Garmin ([ver abajo](#garmin)) |
| `GARMIN_WEBHOOK_SECRET` | No | Si está, la URL del webhook de Garmin debe llevar `?key=<secreto>` (Garmin no firma sus avisos) |
| `COROS_CLIENT_ID`, `COROS_CLIENT_SECRET` | Para COROS | Application ID y key que da COROS al aprobar la integración ([ver abajo](#coros)) |
| `COROS_WEBHOOK_SECRET` | No | Si está, la URL de push de COROS debe llevar `?key=<secreto>` |
| `COROS_PUSH_CLIENT`, `COROS_PUSH_SECRET` | No | *client* y *secret* que COROS manda en las cabeceras del push, si son distintos del application ID / key |
| `COROS_API_BASE` | No | Servidor de la API de COROS. Por defecto `https://open.coros.com`; `https://opentest.coros.com` mientras COROS prueba la integración |
| `WORKER_URL` | No | URL pública del Worker para enlaces de invitación y botones de los emails. Por defecto, el origen de la petición |
| `APP_DOWNLOAD_URL` | No | Enlace de App Store / TestFlight; si está, las páginas `/invite` y `/open` muestran "Descargar la app" |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | No | Solo si aún llamas a `/api/tasks/*` desde QStash |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | No | Web Push de la web retirada; no hacen falta para la app |

### Emails

Los emails salen por el servidor SMTP de la cuenta de Gmail de `GMAIL_USER` (`runna.io.service@gmail.com`). Es gratis, no necesita dominio propio y Gmail los firma, así que no acaban en spam. El límite es de unos 500 emails al día.

1. Entra en esa cuenta de Google y activa la **verificación en dos pasos** (myaccount.google.com → Seguridad). Sin ella, Google no deja crear contraseñas de aplicación.
2. Abre [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), crea una con el nombre "Runna Worker" y copia las 16 letras.
3. `npx wrangler secret put GMAIL_APP_PASSWORD -c wrangler.worker.toml` y pega las 16 letras (con o sin espacios).
4. Comprueba que funciona:

   ```bash
   curl -X POST -H "Authorization: Bearer $UPSTASH_CRON_SECRET" -H "Content-Type: application/json" \
     -d '{"to":"tu-email@ejemplo.com"}' https://runna-io-api.runna-io-api.workers.dev/api/admin/email/test
   ```

   Responde con el proveedor, el remitente, los problemas de configuración que vea (`problems`) y, si se pudo enviar, `"sent": true`. Si no, `error` trae la respuesta del servidor de correo (por ejemplo `535 ... Username and Password not accepted` si la contraseña de aplicación está mal).

Si cambias la contraseña de esa cuenta de Google, sus contraseñas de aplicación dejan de valer y tienes que crear otra.

Nunca subas credenciales al repositorio: `.env*` y `.dev.vars` están en `.gitignore` (hay una plantilla en `.env.example`).

## Garmin

Integración con el Garmin Connect Developer Program (Activity API), en `worker/src/garmin.ts`. Garmin **empuja** cada actividad (resumen + puntos GPS) al Worker unos minutos después de que el usuario sincronice el reloj con Garmin Connect; no hay sondeo. Con acceso Starter no hay histórico: solo llegan las actividades posteriores a la conexión.

1. En el [portal de desarrolladores](https://developerportal.garmin.com) crea la app con el permiso **Activity API** y copia el *consumer key* y el *consumer secret*:

   ```bash
   npx wrangler secret put GARMIN_CLIENT_ID -c wrangler.worker.toml
   npx wrangler secret put GARMIN_CLIENT_SECRET -c wrangler.worker.toml
   npx wrangler secret put GARMIN_WEBHOOK_SECRET -c wrangler.worker.toml   # una cadena aleatoria larga
   ```

2. Redirect URL de OAuth: `https://runna-io-api.runna-io-api.workers.dev/api/garmin/callback`.
3. En **Endpoint Configuration** (`https://apis.garmin.com/tools/endpoints`) apunta a `https://runna-io-api.runna-io-api.workers.dev/api/garmin/webhook?key=<GARMIN_WEBHOOK_SECRET>`, en modo **push** (también acepta ping), estos tipos: **Activity Details**, **Deregistrations** y **User Permissions Change**. Deja desactivados los demás.
4. La fila Garmin aparece en la app (Perfil → Servicios conectados) en cuanto `/api/garmin/status` dice `configured: true`.

Prueba end-to-end con Garmin simulado: compila el Worker como en "API en local" y ejecuta

```bash
rm -f scripts/e2e/.build/garmin.db
DATABASE_URL=file:scripts/e2e/.build/garmin.db npx drizzle-kit push --force
node scripts/e2e/garmin-test.mjs
```

## COROS

Integración con la API de partners de COROS, en `worker/src/coros.ts`. COROS **empuja** un resumen de cada entrenamiento al Worker unos 5 minutos después de que el usuario sincronice el reloj con la app COROS; el Worker descarga el fichero FIT, saca el recorrido GPS y lo convierte en territorio. Si un aviso se pierde, la tarea `coros-auto-sync` (cada hora, minuto 45) lo recoge, y «Sincronizar ahora» trae los últimos 30 días.

1. Pide acceso a la API con el formulario de COROS ([Submit an API Application](https://support.coros.com/hc/en-us/articles/17085887816340-Submit-an-API-Application)). Datos técnicos que pide:
   - *Authorized Callback Domain*: `https://runna-io-api.runna-io-api.workers.dev` (la redirect URI completa es `.../api/coros/callback`)
   - *Workout data receiving endpoint URL*: `https://runna-io-api.runna-io-api.workers.dev/api/coros/webhook?key=<COROS_WEBHOOK_SECRET>`
   - *Service status check URL*: `https://runna-io-api.runna-io-api.workers.dev/api/coros/webhook` (un GET responde 200)
   - Logos PNG de 144, 102, 120 y 300 px: `ios/AppStore/coros-logo-*.png`
2. Cuando COROS te dé el *application ID* (clientId) y la *key* (clientSecret):

   ```bash
   npx wrangler secret put COROS_CLIENT_ID -c wrangler.worker.toml
   npx wrangler secret put COROS_CLIENT_SECRET -c wrangler.worker.toml
   npx wrangler secret put COROS_WEBHOOK_SECRET -c wrangler.worker.toml   # la misma cadena aleatoria que pusiste en la URL de push
   ```

   Si COROS te asigna un *client* y *secret* distintos para las cabeceras del push, guárdalos en `COROS_PUSH_CLIENT` y `COROS_PUSH_SECRET`. Mientras COROS revisa la integración en su entorno de pruebas, añade `COROS_API_BASE = "https://opentest.coros.com"` en `[vars]` y quítalo al pasar a producción.
3. La fila COROS aparece en la app (Perfil → Servicios conectados) en cuanto `/api/coros/status` dice `configured: true`.
4. Avisa a COROS (api@coros.com) una semana antes de publicarlo, como piden sus condiciones.

El código sigue la *COROS API Reference V2.1.1* (septiembre de 2026), que COROS enlaza desde el formulario de solicitud: OAuth2 (§3), lista de entrenamientos (§4.2), push de resúmenes con cabeceras `client`/`secret` y respuesta `{"result":"0000"}` (§5.3) y enlace al FIT cuando falta (§5.4). El deporte se decide con el fichero FIT; los `mode` de COROS descartan bici, natación, triatlón y esquí sin descargar nada, y deciden si el FIT no trae deporte.

Prueba end-to-end con COROS simulado: compila el Worker como en "API en local" y ejecuta

```bash
rm -f scripts/e2e/.build/coros.db
DATABASE_URL=file:scripts/e2e/.build/coros.db npx drizzle-kit push --force
node scripts/e2e/coros-test.mjs
```

## Páginas que sirve el Worker

| Ruta | Qué es |
|---|---|
| `/privacy` | Política de privacidad (URL para App Store Connect) |
| `/terms` | Condiciones de uso |
| `/support` | Soporte (URL para App Store Connect) |
| `/invite/<token>` | Enlace de invitación de amistad: abre `runnaio://friends/accept/<token>` en la app |
| `/open?tab=<map\|rankings\|activity\|friends\|profile>` | Abre la app en una pestaña (lo usan los botones de los emails) |

En producción: `https://runna-io-api.runna-io-api.workers.dev/privacy`, `/terms` y `/support`.

## Seguridad de la API

- Al iniciar sesión o confirmar el registro, el servidor da un token de sesión. La app lo guarda en el llavero y lo envía como `Authorization: Bearer <token>`. En la base de datos solo se guarda su hash; `POST /api/auth/logout` lo revoca.
- Los endpoints con datos privados usan el usuario del token, no el ID que llegue en la URL o en el body.
- Las contraseñas se guardan con PBKDF2 (las antiguas se actualizan solas en el siguiente inicio de sesión).
- Límite de intentos (tabla `auth_attempts`, ver `worker/src/rateLimit.ts`): 10 contraseñas incorrectas por cuenta o 30 por IP en 15 minutos bloquean el inicio de sesión durante 15 minutos (respuesta 429 con `Retry-After`), y 5 códigos de verificación incorrectos bloquean ese paso igual. El error de inicio de sesión es el mismo si la cuenta no existe o si la contraseña está mal.
- Registro con email confirmado: `POST /api/auth/register/start` comprueba el formulario y que el email y el usuario no estén ya en uso (sin distinguir mayúsculas) y envía un código de 6 dígitos (válido 15 minutos; como mucho 4 códigos por hora y email y 10 registros por hora e IP). La cuenta no se crea hasta que `POST /api/auth/register/confirm` recibe el código; entonces se crea ya verificada e inicia sesión. `POST /api/auth/register/resend` manda un código nuevo. Mientras tanto, los datos esperan en `pending_signups` (contraseña y código con hash; se borran un día después). 5 códigos incorrectos anulan el código. `POST /api/users` ya no crea cuentas (responde 426 a las versiones antiguas de la app).
- "He olvidado mi contraseña": `POST /api/auth/password-reset/request` envía un código de 6 dígitos por email (válido 15 minutos, como mucho 3 emails por hora y cuenta; responde lo mismo exista o no la cuenta) y `POST /api/auth/password-reset/confirm` con el código y la contraseña nueva inicia sesión y cierra las demás sesiones. 5 códigos incorrectos anulan el código.
- Juego limpio: una carrera con un ritmo medio de más de 21 km/h (a partir de 1 km), o con una duración mayor que el tiempo entre su inicio y su final, no conquista territorio ni recoge cofres (`checkRunPlausibility` en `worker/src/territory.ts`). La app recibe un 422 con el motivo; las importadas de Strava, Polar o Suunto se guardan, pero no cuentan. La distancia que cuenta es la mayor entre la declarada y la longitud del recorrido GPS.
- Los endpoints `/api/admin/*` y `/api/tasks/*` exigen el secreto de administración (o la ejecución interna del cron).
- Denuncias y bloqueos (requisito 1.2 de Apple): los usuarios bloqueados se filtran del feed, comentarios, búsquedas, solicitudes e invitaciones en ambos sentidos. Cada denuncia se guarda y se avisa por email.
- Los tokens de push que Apple da por muertos (410, `BadDeviceToken`) se borran automáticamente.
- Borrar la cuenta desde la app elimina todos los datos del usuario.

## Licencia

MIT

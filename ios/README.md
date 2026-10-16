# Runna.io para iPhone

App nativa en SwiftUI (iOS 17 o superior). Es el único cliente de Runna.io: habla con la API del Cloudflare Worker (`worker/`).

## Qué incluye

- **Cuenta**: inicio de sesión, registro con verificación por email (edad mínima 14 años), cerrar sesión y borrar cuenta (Apple exige poder borrarla desde la app). Presentación inicial de cinco pantallas la primera vez.
- **Mapa**: tu territorio y el de tus amigos (MapKit), filtro por amigo, toca un territorio para ver de quién es, tus recorridos, fortificaciones y castillos.
- **Competiciones**: banner con la cuenta atrás, cofres en el mapa (común, raro, épico y legendario) que se recogen corriendo, **poderes** que se activan desde el botón ⚡, apodos, ranking de la competición, **resumen semanal** y podio final.
- **Correr**: GPS nativo que sigue grabando con la pantalla bloqueada, pausa/reanudar, aviso si la ubicación no es exacta, recuperación si iOS cierra la app a mitad de carrera, y cola sin conexión: la carrera se guarda en el móvil y se sube después (sin duplicados).
- **Después de correr**: territorio conquistado y robado, a quién se lo has robado, cofres recogidos, **animación de la ruta**, enviar una foto que solo puede verse una vez, renombrar la carrera. Las carreras que llegan de Strava, Polar o Apple Salud muestran el mismo resumen al abrir la app.
- **Actividad**: feed de tus amigos (carreras, robos, cofres, apodos, récords) con "me gusta"/"no me gusta" y comentarios con respuestas y @menciones; tus carreras con mapa, renombrar y borrar.
- **Ranking** de amigos y de la competición.
- **Amigos**: solicitudes, búsqueda, perfiles con sus amigos y actividades, enlace de invitación para compartir (`/invite/<token>` abre la app y pide confirmar).
- **Seguridad**: denunciar publicaciones, comentarios y usuarios; bloquear y desbloquear (Perfil → Usuarios bloqueados).
- **Perfil**: foto, nombre, color del territorio, estadísticas de robos, apariencia clara/oscura, Strava, Polar y **Apple Salud** (importa las carreras del Apple Watch) en "Conectar dispositivos", notificaciones, soporte y enlaces legales.
- **Notificaciones push** nativas (APNs): robos de territorio, solicitudes de amistad, comentarios, cofres, resumen semanal, importaciones automáticas, etc.

## Abrir y ejecutar (Mac)

1. Descarga el repositorio y abre `ios/Runna.xcodeproj` con Xcode 16 o superior.
2. Selecciona el target **Runna** → pestaña **Signing & Capabilities**:
   - En **Team** elige tu equipo de Apple Developer.
   - Cambia **Bundle Identifier** si quieres (ahora es `com.jpoves.runnaio`). Tiene que ser único en tu cuenta.
   - Xcode creará el App ID con las capacidades que ya trae el proyecto: Push Notifications, HealthKit y Background Modes (Location updates).
3. Elige tu iPhone y pulsa ▶︎.

La app habla con la API de producción (`AppConfig.apiBaseURL` en `Runna/Core/AppConfig.swift`).

Para probarla en el simulador contra una API local con datos de prueba (ver el [README principal](../README.md#api-en-local)), pasa en el esquema de Xcode las variables de entorno `RUNNA_API_BASE_URL=http://127.0.0.1:8787`, `RUNNA_TEST_TOKEN` y `RUNNA_TEST_USER_ID` (los imprime `scripts/e2e/seed.mjs`).

## Subir a TestFlight

1. En Xcode: **Product → Archive** (con "Any iOS Device" como destino).
2. En el Organizer: **Distribute App → App Store Connect → Upload**.
3. En [App Store Connect](https://appstoreconnect.apple.com), cuando termine de procesarse, añade la build a TestFlight.
4. Antes de cada nueva subida, incrementa **Build** (`CURRENT_PROJECT_VERSION`) en el target.

La app ya declara `ITSAppUsesNonExemptEncryption = NO`, así que TestFlight no te preguntará por cifrado.

## Notificaciones push (APNs)

El servidor envía las notificaciones directamente a Apple. Hay que darle una clave una sola vez:

1. En [developer.apple.com → Keys](https://developer.apple.com/account/resources/authkeys/list) crea una clave con **Apple Push Notifications service (APNs)** y descarga el `.p8`. Anota el **Key ID** y tu **Team ID**.
2. Configura los secretos del Worker (desde la carpeta del proyecto; en Windows funciona igual en PowerShell):

   ```
   npx wrangler secret put APNS_KEY_ID -c wrangler.worker.toml
   npx wrangler secret put APNS_TEAM_ID -c wrangler.worker.toml
   npx wrangler secret put APNS_BUNDLE_ID -c wrangler.worker.toml
   npx wrangler secret put APNS_PRIVATE_KEY -c wrangler.worker.toml
   ```

   En `APNS_BUNDLE_ID` pon el Bundle Identifier de la app. En `APNS_PRIVATE_KEY` pega el contenido completo del `.p8`, con las líneas `BEGIN/END PRIVATE KEY`.

Las builds de Xcode (Debug) se registran en el entorno *sandbox* de APNs. Las de TestFlight y App Store, en *production*. El servidor usa el que corresponda a cada dispositivo.

## Strava y Polar

La app abre el login de Strava/Polar en una ventana segura del sistema. Al terminar, el servidor la devuelve a la app con `runnaio://oauth/...`. No hace falta cambiar nada en Strava ni en Polar: la URL de callback sigue siendo la del Worker.

## Revisión de Apple: notas útiles

- **URLs para App Store Connect**:
  - Política de privacidad: `https://runna-io-api.runna-io-api.workers.dev/privacy`
  - Soporte: `https://runna-io-api.runna-io-api.workers.dev/support`
  - Condiciones de uso (opcional, como EULA o en la descripción): `https://runna-io-api.runna-io-api.workers.dev/terms`
- **Contenido generado por usuarios** (guideline 1.2): se puede denunciar y bloquear desde el perfil de un usuario, un comentario o una publicación. Las denuncias se revisan en 24 horas.

- **Ubicación en segundo plano**: solo se usa mientras grabas una carrera que has empezado tú. Si lo preguntan, explícalo en las notas de la revisión.
- **HealthKit**: solo lectura de entrenamientos de carrera y sus rutas, para crear territorio.
- **Borrar cuenta**: Perfil → Borrar cuenta.
- **Cuenta de prueba**: crea una cuenta con email ya verificado para el revisor y ponla en App Store Connect → App Review Information.
- **Nombre**: "Runna" ya existe en la App Store (es otra app de running). Puede que Apple pida un nombre distinto: piensa una alternativa.

## Compilación automática

`.github/workflows/ios.yml` se ejecuta en un Mac de GitHub Actions cada vez que cambia algo en `ios/` o en la API: compila la app (simulador y dispositivo, sin firmar), la abre en el simulador con una API local llena de datos de prueba (`scripts/e2e/`) y hace una captura de cada pestaña. Las capturas se descargan desde la ejecución, en "Artifacts".

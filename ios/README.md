# Runna.io para iPhone

App nativa en SwiftUI (iOS 17 o superior) que usa la misma API (Cloudflare Worker) que la web.

## Qué incluye

- **Cuenta**: inicio de sesión, registro con verificación por email, cerrar sesión y borrar cuenta (Apple exige poder borrarla desde la app).
- **Mapa**: tu territorio y el de tus amigos (MapKit), filtro por amigo, toca un territorio para ver de quién es, tesoros cuando hay competición.
- **Correr**: GPS nativo que sigue grabando con la pantalla bloqueada, pausa/reanudar, recuperación si iOS cierra la app a mitad de carrera, y si no hay conexión al terminar la carrera se guarda en el móvil y se sube después.
- **Después de correr**: territorio conquistado y robado, a quién se lo has robado, enviarle una foto que solo puede ver una vez, renombrar la carrera.
- **Actividad**: feed de tus amigos con "me gusta"/"no me gusta" y comentarios con respuestas; tus carreras con mapa, renombrar y borrar.
- **Ranking** de amigos (y de la competición cuando hay una).
- **Amigos**: solicitudes, búsqueda, enlace de invitación para compartir, invitaciones `runnaio://friends/accept/<token>`.
- **Perfil**: foto, nombre, color del territorio, estadísticas de robos, Strava, Polar y **Apple Salud** (importa las carreras del Apple Watch), notificaciones, enlaces legales.
- **Notificaciones push** nativas (APNs): robos de territorio, solicitudes de amistad, comentarios, etc.

Aún no está en la app (solo en la web): activar poderes de la competición, resúmenes semanales y la animación de la ruta.

## Abrir y ejecutar (Mac)

1. Descarga el repositorio y abre `ios/Runna.xcodeproj` con Xcode 16 o superior.
2. Selecciona el target **Runna** → pestaña **Signing & Capabilities**:
   - En **Team** elige tu equipo de Apple Developer.
   - Cambia **Bundle Identifier** si quieres (ahora es `com.jpoves.runnaio`). Tiene que ser único en tu cuenta.
   - Xcode creará el App ID con las capacidades que ya trae el proyecto: Push Notifications, HealthKit y Background Modes (Location updates).
3. Elige tu iPhone y pulsa ▶︎.

La app habla con la API de producción (`AppConfig.apiBaseURL` en `Runna/Core/AppConfig.swift`).

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

- **Ubicación en segundo plano**: solo se usa mientras grabas una carrera que has empezado tú. Si lo preguntan, explícalo en las notas de la revisión.
- **HealthKit**: solo lectura de entrenamientos de carrera y sus rutas, para crear territorio.
- **Borrar cuenta**: Perfil → Borrar cuenta.
- **Cuenta de prueba**: crea una cuenta con email ya verificado para el revisor y ponla en App Store Connect → App Review Information.
- **Nombre**: "Runna" ya existe en la App Store (es otra app de running). Puede que Apple pida un nombre distinto: piensa una alternativa.

## Compilación automática

`.github/workflows/ios.yml` se ejecuta en un Mac de GitHub Actions cada vez que cambia algo en `ios/` o en la API: compila la app (simulador y dispositivo, sin firmar), la abre en el simulador con una API local llena de datos de prueba (`scripts/e2e/`) y hace una captura de cada pestaña. Las capturas se descargan desde la ejecución, en "Artifacts".

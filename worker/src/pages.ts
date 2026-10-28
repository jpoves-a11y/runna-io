// Public static pages served by the Worker (the web app is discontinued; the only client is the
// iPhone app): privacy policy, terms, support, and landing pages that open the app through its
// URL scheme (friend invites and email buttons). Plain HTML with inline CSS, no external resources.
import type { Context, Hono } from 'hono';
import type { AppEnv } from './auth';

const DEFAULT_WORKER_URL = 'https://runna-io-api.runna-io-api.workers.dev';
const CONTACT_EMAIL = 'runna.io.service@gmail.com';
const APP_SCHEME = 'runnaio';
const APP_TABS = ['map', 'rankings', 'activity', 'friends', 'profile'] as const;

/** Public base URL of this Worker: env WORKER_URL, else the request origin. No trailing slash. */
export function publicBaseUrl(c: Context<AppEnv>): string {
  const configured = c.env?.WORKER_URL;
  if (configured) return configured.replace(/\/+$/, '');
  try {
    return new URL(c.req.url).origin;
  } catch {
    return DEFAULT_WORKER_URL;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) links are accepted for APP_DOWNLOAD_URL. */
function safeHttpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f7f8fa; --card: #ffffff; --text: #111827; --muted: #5b6472; --border: #e3e6eb;
  --accent: #2563eb; --accent-text: #ffffff; --soft: #eef2ff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --card: #161b22; --text: #e6edf3; --muted: #9aa4b2; --border: #2b323c;
    --accent: #3b82f6; --accent-text: #ffffff; --soft: #1b2333;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  padding: max(16px, env(safe-area-inset-top)) 16px max(32px, env(safe-area-inset-bottom));
}
main { max-width: 760px; margin: 0 auto; }
header { text-align: center; padding: 16px 0 20px; border-bottom: 2px solid var(--accent); margin-bottom: 24px; }
header h1 { font-size: 1.6rem; margin: 0 0 4px; }
header h2 { font-size: 1.3rem; margin: 0 0 12px; font-weight: 600; }
header p { margin: 2px 0; color: var(--muted); font-size: .95rem; }
section { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px 18px; margin: 0 0 16px; }
section h2 { font-size: 1.15rem; margin: 0 0 10px; }
section h3 { font-size: 1rem; margin: 14px 0 6px; }
p, li { color: var(--text); }
.muted { color: var(--muted); font-size: .95rem; }
ul, ol { padding-left: 1.3rem; margin: 6px 0; }
li { margin: 3px 0; }
a { color: var(--accent); }
table { width: 100%; border-collapse: collapse; font-size: .95rem; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { background: var(--soft); }
.table-wrap { overflow-x: auto; }
.note { background: var(--soft); border-radius: 10px; padding: 10px 12px; margin: 10px 0; }
footer { text-align: center; color: var(--muted); font-size: .9rem; padding-top: 16px; border-top: 1px solid var(--border); margin-top: 24px; }
footer a { margin: 0 6px; }
.landing { min-height: 70vh; display: flex; flex-direction: column; justify-content: center; text-align: center; }
.landing .logo { font-size: 3.5rem; line-height: 1; margin-bottom: 8px; }
.landing h1 { font-size: 1.6rem; margin: 8px 0; }
.button {
  display: block; width: 100%; max-width: 360px; margin: 12px auto; padding: 16px 20px;
  border-radius: 14px; font-size: 1.1rem; font-weight: 700; text-decoration: none; text-align: center;
  background: var(--accent); color: var(--accent-text);
}
.button.secondary { background: transparent; color: var(--accent); border: 2px solid var(--accent); }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

const FOOTER = `<footer>
<p>© 2026 Javier Poves Ruiz · Runna.io</p>
<p><a href="/privacy">Privacidad</a>·<a href="/terms">Términos</a>·<a href="/support">Soporte</a></p>
</footer>`;

const PRIVACY_HTML = page('Política de Privacidad · Runna.io', `
<header>
<h1>🏃 Runna.io</h1>
<h2>Política de Privacidad</h2>
<p><strong>Última actualización:</strong> 16 de octubre de 2026</p>
<p><strong>Responsable:</strong> Javier Poves Ruiz</p>
<p><strong>Contacto:</strong> <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
</header>

<section>
<p>Runna.io es una app para iPhone en la que sales a correr y conquistas territorio en el mapa; tus amigos pueden robártelo y competir contigo. Esta política explica qué datos tratamos, para qué y cuáles son tus derechos.</p>
</section>

<section id="responsable">
<h2>1. Responsable del tratamiento</h2>
<div class="table-wrap"><table><tbody>
<tr><td><strong>Responsable</strong></td><td>Javier Poves Ruiz (persona física)</td></tr>
<tr><td><strong>Email</strong></td><td><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></td></tr>
<tr><td><strong>País</strong></td><td>España</td></tr>
<tr><td><strong>Autoridad de control</strong></td><td>Agencia Española de Protección de Datos (AEPD)</td></tr>
</tbody></table></div>
</section>

<section id="datos">
<h2>2. ¿Qué datos recopilamos?</h2>
<h3>2.1. Datos de tu cuenta</h3>
<ul>
<li><strong>Nombre</strong> y <strong>nombre de usuario</strong> (@usuario): te identifican ante tus amigos y en los rankings.</li>
<li><strong>Correo electrónico:</strong> para verificar la cuenta y enviarte avisos que puedes desactivar.</li>
<li><strong>Contraseña:</strong> nunca se guarda en texto plano; se almacena cifrada con PBKDF2 y salt.</li>
<li><strong>Foto de perfil</strong> (opcional) y el color que eliges para tu territorio.</li>
</ul>
<h3>2.2. Carreras y ubicación</h3>
<ul>
<li>Cuando grabas una carrera, la app usa la <strong>ubicación del iPhone</strong> mientras dura la grabación, también con la pantalla bloqueada, para registrar el recorrido. Fuera de una grabación no usamos tu ubicación en segundo plano.</li>
<li>De cada carrera guardamos la <strong>ruta GPS</strong>, la distancia, la duración y la fecha y hora, y el territorio que conquistas con ella.</li>
</ul>
<h3>2.3. Apple Health (HealthKit)</h3>
<ul>
<li>Solo si tú lo activas, la app lee de Apple Health tus <strong>entrenamientos de carrera y sus rutas</strong> para importarlos como carreras. El acceso es de <strong>solo lectura</strong>: no escribimos nada en Apple Health.</li>
<li>Los datos de HealthKit <strong>nunca se usan para publicidad</strong> ni se comparten con terceros, salvo el proveedor de alojamiento que guarda las carreras importadas.</li>
<li>Puedes retirar el permiso cuando quieras en Ajustes del iPhone → Salud → Acceso a datos y dispositivos → Runna.io.</li>
</ul>
<h3>2.4. Strava, Polar, Suunto y Garmin (opcional)</h3>
<p>Si conectas tu cuenta de Strava, Polar Flow, Suunto o Garmin Connect, importamos tus actividades de carrera (identificador, distancia, duración, fecha y ruta GPS) y guardamos los tokens de acceso que esos servicios nos dan. De Suunto guardamos además tu nombre de usuario de Suunto, que usamos solo para saber a quién pertenece cada aviso de entrenamiento nuevo que nos envía Suunto. De Garmin guardamos tu identificador de usuario de la API de Garmin, que usamos solo para saber a quién pertenece cada actividad que nos envía Garmin. Puedes desconectarlas desde tu perfil o desde Garmin Connect; al desconectar Garmin o borrar tu cuenta avisamos a Garmin para que deje de enviarnos tus datos.</p>
<h4>Datos de Garmin</h4>
<ul>
<li><strong>Qué recibimos y para qué:</strong> solo tus actividades de carrera, caminata y senderismo (tipo, fecha, distancia, duración, modelo de reloj y ruta GPS). Las usamos únicamente para crear tus carreras en Runna.io, calcular tu territorio y rankings y mostrarlas a tus amigos. No recibimos datos de salud (sueño, frecuencia cardiaca diaria, etc.).</li>
<li><strong>Quién los trata:</strong> solo los proveedores de la sección 5 que alojan el servicio: Cloudflare (servidor), Turso (base de datos) y Apple APNs (el aviso de «carrera registrada», sin la ruta). Ningún otro tercero recibe datos de Garmin.</li>
<li><strong>No los vendemos</strong> ni los compartimos con terceros para fines propios de ellos.</li>
<li><strong>Sin inteligencia artificial:</strong> ningún sistema de IA procesa tus datos de Garmin, y no se usan para entrenar, evaluar ni mejorar modelos de IA.</li>
<li><strong>Tu control:</strong> puedes ver y borrar cada actividad importada en Perfil → Servicios conectados → Garmin → Actividades importadas; pedir una copia (JSON) o la corrección de tus datos escribiendo a <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>; y retirar tu consentimiento desconectando Garmin en la app o quitando Runna.io en Garmin Connect (Ajustes → Aplicaciones conectadas). Al borrar tu cuenta se eliminan todos tus datos de Garmin.</li>
</ul>
<h3>2.5. Fotos y cámara</h3>
<ul>
<li>Puedes enviar a un amigo una <strong>foto de un solo uso</strong> (para picarle cuando le robas territorio). Usamos la cámara o tu fototeca solo cuando tú eliges hacerlo. La foto se <strong>borra al verla</strong> y, si nadie la ve, a las 24 horas.</li>
<li>La foto de perfil se guarda hasta que la cambies o borres tu cuenta.</li>
</ul>
<h3>2.6. Notificaciones push</h3>
<p>Si las permites, guardamos el <strong>token de dispositivo</strong> que da Apple para enviarte avisos (solicitudes de amistad, territorio robado, comentarios, tesoros…) a través del servicio Apple Push Notification service (APNs). Puedes desactivarlas en Ajustes del iPhone.</p>
<h3>2.7. Contenido social</h3>
<p>Comentarios y reacciones que publicas en el feed, tus amistades y, si los usas, las denuncias y bloqueos que haces.</p>
<div class="note"><strong>Sin rastreo:</strong> la app no incluye SDK de publicidad, analítica ni seguimiento, y no rastrea tu actividad en otras apps o webs.</div>
</section>

<section id="uso">
<h2>3. ¿Para qué usamos tus datos?</h2>
<div class="table-wrap"><table>
<thead><tr><th>Finalidad</th><th>Base legal (RGPD)</th></tr></thead>
<tbody>
<tr><td>Gestionar tu cuenta</td><td>Ejecución del contrato (art. 6.1.b)</td></tr>
<tr><td>Grabar carreras y calcular territorios y rankings</td><td>Ejecución del contrato (art. 6.1.b)</td></tr>
<tr><td>Importar de Apple Health, Strava, Polar, Suunto o Garmin</td><td>Consentimiento (art. 6.1.a)</td></tr>
<tr><td>Enviar notificaciones push y emails</td><td>Consentimiento (art. 6.1.a)</td></tr>
<tr><td>Moderar denuncias y evitar abusos</td><td>Interés legítimo (art. 6.1.f)</td></tr>
</tbody>
</table></div>
<h3>Lo que NO hacemos</h3>
<ul>
<li>No vendemos tus datos.</li>
<li>No mostramos publicidad ni creamos perfiles de marketing.</li>
<li>No compartimos datos de salud ni de ubicación con terceros para fines propios de ellos.</li>
</ul>
</section>

<section id="visibilidad">
<h2>4. ¿Quién ve tus datos?</h2>
<ul>
<li>Tus amigos ven tu nombre, usuario, foto, color, territorio y tus carreras en el feed.</li>
<li>Durante una competición, los participantes pueden ver el territorio y la posición en el ranking de los demás.</li>
<li>Si bloqueas a alguien, dejáis de ver el contenido del otro y se elimina la amistad.</li>
</ul>
</section>

<section id="terceros">
<h2>5. Proveedores (encargados del tratamiento)</h2>
<div class="table-wrap"><table>
<thead><tr><th>Servicio</th><th>Finalidad</th><th>Ubicación</th></tr></thead>
<tbody>
<tr><td>Cloudflare</td><td>Alojamiento del servidor</td><td>Global</td></tr>
<tr><td>Turso</td><td>Base de datos</td><td>UE</td></tr>
<tr><td>Apple (APNs)</td><td>Notificaciones push</td><td>EE. UU.</td></tr>
<tr><td>SendGrid / Resend</td><td>Emails de la cuenta</td><td>EE. UU.</td></tr>
<tr><td>Strava</td><td>Importación (opcional)</td><td>EE. UU.</td></tr>
<tr><td>Polar Flow</td><td>Importación (opcional)</td><td>Finlandia (UE)</td></tr>
<tr><td>Suunto</td><td>Importación (opcional)</td><td>Finlandia (UE)</td></tr>
<tr><td>Garmin</td><td>Importación (opcional)</td><td>EE. UU. / UE</td></tr>
</tbody>
</table></div>
<p class="muted">Las transferencias fuera de la UE se amparan en las cláusulas contractuales tipo de la Comisión Europea o en el Marco de Privacidad de Datos UE-EE. UU.</p>
</section>

<section id="conservacion">
<h2>6. Conservación y borrado de la cuenta</h2>
<ul>
<li>Guardamos tus datos mientras tengas la cuenta.</li>
<li>Puedes borrar la cuenta desde la app: <strong>Perfil → Borrar cuenta</strong>. Se eliminan de inmediato y de forma irreversible tus datos: perfil, carreras, territorios, fotos, comentarios, amistades, tokens de notificaciones y conexiones con Strava, Polar, Suunto y Garmin.</li>
</ul>
</section>

<section id="moderacion">
<h2>7. Denuncias y bloqueos</h2>
<p>Puedes denunciar usuarios, comentarios, publicaciones o fotos desde la app y bloquear a cualquier usuario. Revisamos las denuncias y podemos retirar contenido o suspender cuentas que incumplan los <a href="/terms">Términos</a>. Guardamos la denuncia (quién la hace, qué se denuncia y el motivo) solo para gestionarla.</p>
</section>

<section id="derechos">
<h2>8. Tus derechos (RGPD)</h2>
<div class="table-wrap"><table>
<thead><tr><th>Derecho</th><th>Descripción</th></tr></thead>
<tbody>
<tr><td>Acceso (art. 15)</td><td>Pedir una copia de tus datos</td></tr>
<tr><td>Rectificación (art. 16)</td><td>Corregir tus datos desde el perfil</td></tr>
<tr><td>Supresión (art. 17)</td><td>Borrar tu cuenta y todos tus datos</td></tr>
<tr><td>Portabilidad (art. 20)</td><td>Recibir tus datos en formato JSON</td></tr>
<tr><td>Oposición (art. 21)</td><td>Oponerte a un tratamiento</td></tr>
<tr><td>Retirar el consentimiento</td><td>En cualquier momento, sin efecto retroactivo</td></tr>
</tbody>
</table></div>
<p>Para ejercerlos, escribe a <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. Respondemos en un plazo máximo de 30 días.</p>
</section>

<section id="seguridad">
<h2>9. Seguridad</h2>
<ul>
<li>Cifrado HTTPS/TLS en todas las comunicaciones.</li>
<li>Contraseñas cifradas con PBKDF2 y salt.</li>
<li>La sesión de la app se guarda en el Llavero (Keychain) del iPhone.</li>
<li>Base de datos con cifrado en reposo y tokens de servicios externos guardados de forma segura.</li>
</ul>
</section>

<section id="edad">
<h2>10. Edad mínima</h2>
<p><strong>14 años.</strong> Según el artículo 7 de la LOPDGDD, la edad de consentimiento digital en España es 14 años. Los menores de 14 años no pueden crear una cuenta.</p>
</section>

<section id="contacto">
<h2>11. Contacto y reclamaciones</h2>
<p>Consultas de privacidad: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
<p>Si crees que no hemos tratado bien tus datos, puedes reclamar ante la <strong>Agencia Española de Protección de Datos (AEPD)</strong>: www.aepd.es · 901 100 099.</p>
<p class="muted">Si cambiamos esta política te lo indicaremos en la app.</p>
</section>
${FOOTER}`);

const TERMS_HTML = page('Términos y Condiciones · Runna.io', `
<header>
<h1>🏃 Runna.io</h1>
<h2>Términos y Condiciones</h2>
<p><strong>Última actualización:</strong> 16 de octubre de 2026</p>
<p><strong>Responsable:</strong> Javier Poves Ruiz</p>
<p><strong>Contacto:</strong> <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
</header>

<section>
<h2>1. Aceptación</h2>
<p>Al crear una cuenta o usar Runna.io aceptas estos Términos y la <a href="/privacy">Política de Privacidad</a>. Si no estás de acuerdo, no uses la app.</p>
</section>

<section>
<h2>2. El servicio</h2>
<p>Runna.io es una app para iPhone que permite:</p>
<ul>
<li>Grabar tus carreras con el GPS del iPhone o importarlas desde Apple Health, Strava, Polar Flow, Suunto o Garmin Connect.</li>
<li>Conquistar territorio virtual en el mapa a partir de tus rutas.</li>
<li>Robar territorio a tus amigos y competir en rankings y competiciones con tesoros y poderes.</li>
<li>Seguir a tus amigos en el feed, comentar, reaccionar y enviar fotos de un solo uso.</li>
</ul>
<p>La app es gratuita.</p>
</section>

<section>
<h2>3. Requisitos</h2>
<ul>
<li>Debes tener al menos <strong>14 años</strong>. Si detectamos que un usuario es menor, eliminaremos su cuenta.</li>
<li>Debes tener capacidad legal para aceptar estos términos.</li>
</ul>
</section>

<section>
<h2>4. Tu cuenta</h2>
<ul>
<li>Da información veraz y mantén tu contraseña en secreto. Avísanos si sospechas un uso no autorizado.</li>
<li>Una cuenta por persona; las cuentas son personales e intransferibles y no se permiten cuentas automatizadas.</li>
<li>Podemos suspender o eliminar cuentas que incumplan estos términos, den información falsa, hagan trampas o abusen del servicio.</li>
</ul>
</section>

<section>
<h2>5. Uso aceptable y contenido de los usuarios</h2>
<h3>Puedes</h3>
<ul>
<li>Registrar tus carreras reales y competir de forma justa.</li>
<li>Invitar a tus amigos y compartir tus logros.</li>
</ul>
<h3>No puedes</h3>
<ul>
<li><strong>Hacer trampas:</strong> falsear la ubicación (GPS spoofing), usar vehículos o subir actividades que no has hecho.</li>
<li><strong>Acosar</strong>, insultar, amenazar o intimidar a otros usuarios.</li>
<li>Publicar contenido <strong>ofensivo, sexual, violento, discriminatorio o ilegal</strong> en nombres, comentarios o fotos.</li>
<li>Crear varias cuentas, usar bots o scripts, o intentar acceder a sistemas internos.</li>
</ul>
<div class="note"><strong>Tolerancia cero</strong> con el contenido inaceptable y el acoso. Puedes <strong>denunciar</strong> usuarios, comentarios, publicaciones y fotos y <strong>bloquear</strong> a cualquier usuario desde la app. Revisamos las denuncias en un plazo de 24 horas y retiramos el contenido y expulsamos a quien lo publique cuando incumpla estas normas.</div>
</section>

<section>
<h2>6. Propiedad intelectual</h2>
<ul>
<li>El código, el diseño, los logotipos y la marca Runna.io son de Javier Poves Ruiz.</li>
<li>Tus datos y tus carreras son tuyos. Nos das permiso para tratarlos como explica la Política de Privacidad.</li>
</ul>
</section>

<section>
<h2>7. Servicios de terceros</h2>
<p>Apple Health, Strava, Polar Flow, Suunto y Garmin Connect son opcionales y requieren tu permiso. Puedes desconectarlos cuando quieras. No somos responsables de cambios o caídas de esos servicios.</p>
</section>

<section>
<h2>8. Territorios y competiciones</h2>
<ul>
<li>El territorio se conquista corriendo físicamente por una zona; otros usuarios pueden robártelo corriendo por encima.</li>
<li>Los tesoros, poderes y premios de las competiciones son virtuales y no tienen valor económico.</li>
<li>Podemos invalidar actividades sospechosas y ajustar las reglas del juego para mantenerlo justo.</li>
</ul>
</section>

<section>
<h2>9. Seguridad al correr</h2>
<p>Corre con prudencia, respeta las normas de tráfico y la propiedad privada, y no mires el móvil mientras corres. Eres responsable de tu seguridad y de tu salud.</p>
</section>

<section>
<h2>10. Limitación de responsabilidad</h2>
<p>El servicio se ofrece «tal cual». No garantizamos que esté siempre disponible ni libre de errores. En la medida que permita la ley, no respondemos de daños indirectos. Nada de esto limita los derechos que te reconoce la normativa de consumo.</p>
</section>

<section>
<h2>11. Baja</h2>
<ul>
<li>Puedes borrar tu cuenta cuando quieras en <strong>Perfil → Borrar cuenta</strong>. El borrado es inmediato e irreversible e incluye tus carreras, territorios, fotos, comentarios y conexiones con Strava, Polar, Suunto y Garmin. Tu territorio queda libre para que otros lo conquisten.</li>
<li>Podemos cerrar cuentas por incumplir estos términos; en casos graves, de inmediato.</li>
</ul>
</section>

<section>
<h2>12. Ley aplicable</h2>
<p>Estos términos se rigen por la ley española (RGPD y LOPDGDD). Son competentes los tribunales de España, sin perjuicio de tus derechos como consumidor. Para la protección de datos, la autoridad es la AEPD.</p>
</section>

<section>
<h2>13. Contacto</h2>
<p><a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
</section>
${FOOTER}`);

const SUPPORT_HTML = page('Soporte · Runna.io', `
<header>
<h1>🏃 Runna.io</h1>
<h2>Centro de soporte</h2>
<p>¿Necesitas ayuda? Estamos aquí para ti.</p>
</header>

<section>
<h2>Contacto</h2>
<p>Para cualquier duda, problema técnico, denuncia o sugerencia, escríbenos:</p>
<a class="button" href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>
<p class="muted">Respondemos normalmente en 24-48 horas.</p>
</section>

<section>
<h2>Grabar carreras</h2>
<ul>
<li>Abre la app, ve al <strong>Mapa</strong> y pulsa el botón de empezar a correr.</li>
<li>Permite el acceso a la ubicación («Al usar la app»): la grabación sigue con la pantalla bloqueada.</li>
<li>Al terminar, la carrera se sube y verás el territorio conquistado y lo que has robado. Si no hay conexión, la app la guarda y la sube más tarde.</li>
</ul>
</section>

<section>
<h2>Importar carreras</h2>
<h3>Apple Health</h3>
<p>Perfil → Conectar dispositivos → Apple Health. Se importan tus entrenamientos de carrera con ruta. Puedes retirar el permiso en Ajustes → Salud → Acceso a datos y dispositivos.</p>
<h3>Strava</h3>
<p>Perfil → Conectar dispositivos → Conectar con Strava y autoriza el acceso. Tus carreras con GPS se importan automáticamente.</p>
<h3>Polar Flow</h3>
<p>Perfil → Conectar dispositivos → Conectar con Polar. Los ejercicios con GPS se sincronizan solos cada pocos minutos.</p>
<h3>Suunto</h3>
<p>Perfil → Conectar dispositivos → Conectar con Suunto e inicia sesión con tu cuenta de la app Suunto. Cuando sincronizas el reloj con la app Suunto, tus carreras, caminatas y rutas de senderismo con GPS se importan solas en unos minutos. También puedes usar «Sincronizar ahora» para traer los últimos 30 días. Los entrenamientos sin GPS (cinta, piscina…) y los de otros deportes no se importan.</p>
<h3>Garmin</h3>
<p>Perfil → Conectar dispositivos → Conectar con Garmin, inicia sesión con tu cuenta de Garmin Connect y deja activado el permiso «Actividades». Cuando sincronizas el reloj con Garmin Connect, tus carreras, caminatas y rutas de senderismo con GPS se importan solas en unos minutos. Las actividades anteriores a la conexión no se importan. Los entrenamientos sin GPS (cinta…) y los de otros deportes no se importan.</p>
</section>

<section>
<h2>Preguntas frecuentes</h2>
<h3>¿Cómo añado amigos?</h3>
<p>En la pestaña <strong>Amigos</strong> busca por nombre de usuario o comparte tu enlace de invitación.</p>
<h3>¿Cómo denuncio o bloqueo a alguien?</h3>
<p>Desde el perfil del usuario, un comentario o una publicación, usa la opción <strong>Denunciar</strong> o <strong>Bloquear</strong>. Puedes desbloquear desde tu perfil.</p>
<h3>¿Puedo borrar una carrera?</h3>
<p>Sí, desde tu actividad. El territorio asociado se recalcula.</p>
<h3>¿Cómo borro mi cuenta?</h3>
<p>En <strong>Perfil → Borrar cuenta</strong>. Se eliminan todos tus datos de forma inmediata e irreversible.</p>
<h3>¿Cuesta algo?</h3>
<p>No. Runna.io es gratuita, sin suscripciones ni pagos.</p>
</section>

<section>
<h2>Documentos legales</h2>
<ul>
<li><a href="/privacy">Política de Privacidad</a></li>
<li><a href="/terms">Términos y Condiciones</a></li>
</ul>
</section>
${FOOTER}`);

function landing(c: Context<AppEnv>, options: { title: string; heading: string; text: string; appLink: string }): string {
  const download = safeHttpUrl(c.env?.APP_DOWNLOAD_URL);
  const appLink = escapeHtml(options.appLink);
  return page(options.title, `
<div class="landing">
<div class="logo">🏃</div>
<h1>${escapeHtml(options.heading)}</h1>
<p>${escapeHtml(options.text)}</p>
<a class="button" id="open-app" href="${appLink}">Abrir en la app</a>
${download ? `<a class="button secondary" href="${escapeHtml(download)}">Descargar la app</a>` : ''}
<p class="muted">Si no se abre nada, instala primero Runna.io en tu iPhone${download ? '' : ' (pide el enlace de descarga a quien te invitó)'} y vuelve a pulsar «Abrir en la app».</p>
</div>
${FOOTER}`);
}

/** Only tokens made of URL-safe characters are put in the deep link. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function registerPublicPages(app: Hono<AppEnv>): void {
  const html = (c: Context<AppEnv>, body: string, status: 200 | 404 = 200) => {
    c.header('Cache-Control', 'public, max-age=300');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    return c.html(body, status);
  };

  app.get('/privacy', (c) => html(c, PRIVACY_HTML));
  app.get('/terms', (c) => html(c, TERMS_HTML));
  app.get('/support', (c) => html(c, SUPPORT_HTML));

  app.get('/invite/:token', (c) => {
    const token = c.req.param('token');
    if (!TOKEN_PATTERN.test(token)) {
      return html(c, page('Invitación no válida · Runna.io', `
<div class="landing">
<div class="logo">🏃</div>
<h1>Invitación no válida</h1>
<p>Este enlace de invitación no es correcto. Pide a tu amigo que te envíe uno nuevo.</p>
</div>
${FOOTER}`), 404);
    }
    c.header('Cache-Control', 'no-store');
    return c.html(landing(c, {
      title: 'Invitación a Runna.io',
      heading: 'Te han invitado a Runna.io',
      text: 'Un amigo quiere que corras con él y os robéis territorio. Abre la invitación en la app para aceptarla.',
      appLink: `${APP_SCHEME}://friends/accept/${token}`,
    }));
  });

  app.get('/open', (c) => {
    const requested = c.req.query('tab') ?? 'map';
    const tab = (APP_TABS as readonly string[]).includes(requested) ? requested : 'map';
    return html(c, landing(c, {
      title: 'Abrir Runna.io',
      heading: 'Abre Runna.io',
      text: 'Sal a correr, conquista territorio y defiéndelo de tus amigos.',
      appLink: `${APP_SCHEME}://tab/${tab}`,
    }));
  });
}

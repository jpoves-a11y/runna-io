import { useEffect } from 'react';
import { X } from 'lucide-react';

export default function PrivacyPage() {
  useEffect(() => {
    document.title = 'Política de Privacidad - Runna.io';
  }, []);

  const handleClose = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = '/';
    }
  };

  return (
    <div className="min-h-screen bg-background overflow-y-auto overflow-x-hidden h-screen" style={{ WebkitOverflowScrolling: 'touch' }}>
      {/* Botón X para cerrar */}
      <button
        onClick={handleClose}
        className="fixed right-4 z-50 p-2 rounded-full bg-background/80 backdrop-blur-sm border shadow-lg hover:bg-muted transition-colors"
        style={{ top: 'max(1rem, env(safe-area-inset-top, 1rem))' }}
        aria-label="Cerrar"
      >
        <X className="h-6 w-6" />
      </button>

      <div className="container max-w-4xl mx-auto px-4 py-8" style={{ paddingTop: 'max(2rem, calc(env(safe-area-inset-top, 0px) + 1rem))' }}>
        <header className="text-center mb-12 pb-6 border-b-2 border-primary">
          <h1 className="text-3xl font-bold mb-2">🏃 Runna.io</h1>
          <h2 className="text-2xl font-semibold text-foreground mb-4">Política de Privacidad</h2>
          <div className="text-muted-foreground text-sm space-y-1">
            <p><strong>Última actualización:</strong> 4 de febrero de 2026</p>
            <p><strong>Responsable:</strong> Javier Poves Ruiz</p>
            <p><strong>Contacto:</strong> runna.io.service@gmail.com</p>
          </div>
        </header>

        <nav className="bg-muted p-6 rounded-lg mb-8">
          <h3 className="font-semibold mb-3">📋 Índice</h3>
          <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
            <li><a href="#responsable" className="hover:text-primary">Información del responsable</a></li>
            <li><a href="#datos" className="hover:text-primary">¿Qué datos recopilamos?</a></li>
            <li><a href="#uso" className="hover:text-primary">¿Para qué usamos tus datos?</a></li>
            <li><a href="#cookies" className="hover:text-primary">Cookies y almacenamiento local</a></li>
            <li><a href="#terceros" className="hover:text-primary">Servicios de terceros</a></li>
            <li><a href="#push" className="hover:text-primary">Notificaciones push</a></li>
            <li><a href="#derechos" className="hover:text-primary">Tus derechos (RGPD)</a></li>
            <li><a href="#seguridad" className="hover:text-primary">Seguridad</a></li>
            <li><a href="#edad" className="hover:text-primary">Edad mínima</a></li>
            <li><a href="#contacto" className="hover:text-primary">Contacto</a></li>
          </ol>
        </nav>

        <section id="responsable" className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">1. Información del Responsable</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b"><td className="py-2 font-medium">Responsable</td><td className="py-2">Javier Poves Ruiz (persona física)</td></tr>
                <tr className="border-b"><td className="py-2 font-medium">Email</td><td className="py-2">runna.io.service@gmail.com</td></tr>
                <tr className="border-b"><td className="py-2 font-medium">País</td><td className="py-2">España</td></tr>
                <tr><td className="py-2 font-medium">Autoridad de control</td><td className="py-2">Agencia Española de Protección de Datos (AEPD)</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="datos" className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">2. ¿Qué Datos Recopilamos?</h2>
          
          <h3 className="font-medium mt-4 mb-2">2.1. Datos que TÚ proporcionas</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
            <li><strong>Nombre completo:</strong> Para identificarte en la app</li>
            <li><strong>Nombre de usuario:</strong> Para tu perfil público (@tunombre)</li>
            <li><strong>Correo electrónico:</strong> Para comunicaciones</li>
            <li><strong>Contraseña:</strong> Almacenada con hash SHA-256 con salt (nunca en texto plano)</li>
          </ul>

          <h3 className="font-medium mt-4 mb-2">2.2. Datos de actividades (Polar/Strava/COROS)</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
            <li>ID de ejercicio y tipo de actividad</li>
            <li>Distancia y duración</li>
            <li>Fecha y hora de inicio</li>
            <li>Ruta GPS (polyline codificado o track points)</li>
          </ul>

          <h3 className="font-medium mt-4 mb-2">2.3. Cloudflare Analytics</h3>
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border-l-4 border-yellow-500 p-4 rounded-r">
            <p className="text-sm"><strong>⚠️ Importante:</strong> Solo usamos Cloudflare Analytics (privacy-first, sin cookies de tracking). No usamos Google Analytics ni Facebook Pixel.</p>
          </div>
        </section>

        <section id="uso" className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">3. ¿Para Qué Usamos Tus Datos?</h2>
          
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead><tr className="bg-muted"><th className="py-2 px-3 text-left">Propósito</th><th className="py-2 px-3 text-left">Base legal (RGPD)</th></tr></thead>
              <tbody>
                <tr className="border-b"><td className="py-2 px-3">Gestionar tu cuenta</td><td className="py-2 px-3">Ejecución del contrato (Art. 6.1.b)</td></tr>
                <tr className="border-b"><td className="py-2 px-3">Mostrar actividades y territorios</td><td className="py-2 px-3">Ejecución del contrato (Art. 6.1.b)</td></tr>
                <tr className="border-b"><td className="py-2 px-3">Sincronizar con Polar/Strava/COROS</td><td className="py-2 px-3">Consentimiento (Art. 6.1.a)</td></tr>
                <tr><td className="py-2 px-3">Enviar notificaciones por email</td><td className="py-2 px-3">Consentimiento (Art. 6.1.a)</td></tr>
              </tbody>
            </table>
          </div>

          <div className="bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 p-4 rounded-r">
            <h4 className="font-medium mb-2">❌ Lo que NO hacemos:</h4>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
              <li>NO vendemos tus datos</li>
              <li>NO usamos Google Analytics ni Facebook Pixel</li>
              <li>NO mostramos publicidad personalizada</li>
              <li>NO creamos perfiles para marketing</li>
            </ul>
          </div>
        </section>

        <section id="cookies" className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">4. Cookies y Almacenamiento Local</h2>
          
          <h3 className="font-medium mt-4 mb-2">Cookies utilizadas</h3>
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead><tr className="bg-muted"><th className="py-2 px-3 text-left">Cookie</th><th className="py-2 px-3 text-left">Propósito</th><th className="py-2 px-3 text-left">Duración</th></tr></thead>
              <tbody>
                <tr><td className="py-2 px-3"><code className="bg-muted px-1 rounded">sidebar_state</code></td><td className="py-2 px-3">Estado del menú lateral</td><td className="py-2 px-3">7 días</td></tr>
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted-foreground">Esta cookie es estrictamente funcional y no requiere consentimiento según la Directiva ePrivacy.</p>
        </section>

        <section id="terceros" className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">5. Servicios de Terceros</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="bg-muted"><th className="py-2 px-3 text-left">Servicio</th><th className="py-2 px-3 text-left">Propósito</th><th className="py-2 px-3 text-left">Ubicación</th></tr></thead>
              <tbody>
                <tr className="border-b"><td className="py-2 px-3">Turso</td><td className="py-2 px-3">Base de datos</td><td className="py-2 px-3">UE</td></tr>
                <tr className="border-b"><td className="py-2 px-3">Cloudflare</td><td className="py-2 px-3">Hosting, CDN, Analytics</td><td className="py-2 px-3">Global</td></tr>
                <tr className="border-b"><td className="py-2 px-3">Resend</td><td className="py-2 px-3">Emails transaccionales</td><td className="py-2 px-3">EE.UU.</td></tr>
                <tr className="border-b"><td className="py-2 px-3">Polar Flow</td><td className="py-2 px-3">Sincronización (opcional)</td><td className="py-2 px-3">Finlandia (UE)</td></tr>
                <tr className="border-b"><td className="py-2 px-3">Strava</td><td className="py-2 px-3">Sincronización (opcional)</td><td className="py-2 px-3">EE.UU.</td></tr>
                <tr><td className="py-2 px-3">COROS</td><td className="py-2 px-3">Sincronización (opcional)</td><td className="py-2 px-3">Global</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section id="push" className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">6. Notificaciones Push</h2>
          <div className="bg-green-50 dark:bg-green-900/20 border-l-4 border-green-500 p-4 rounded-r">
            <ul className="space-y-1 text-sm">
              <li>✅ Usamos Web Push API nativa del navegador</li>
              <li>✅ NO usamos Firebase, OneSignal ni otros servicios externos</li>
              <li>✅ Son completamente opcionales</li>
            </ul>
          </div>
        </section>

        <section id="derechos" className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">7. Tus Derechos (RGPD)</h2>
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead><tr className="bg-muted"><th className="py-2 px-3 text-left">Derecho</th><th className="py-2 px-3 text-left">Descripción</th></tr></thead>
              <tbody>
                <tr className="border-b"><td className="py-2 px-3">Acceso (Art. 15)</td><td className="py-2 px-3">Solicitar copia de todos tus datos</td></tr>
                <tr className="border-b"><td className="py-2 px-3">Rectificación (Art. 16)</td><td className="py-2 px-3">Corregir datos desde tu perfil</td></tr>
                <tr className="border-b"><td className="py-2 px-3">Supresión (Art. 17)</td><td className="py-2 px-3">Eliminar tu cuenta y todos tus datos</td></tr>
                <tr className="border-b"><td className="py-2 px-3">Portabilidad (Art. 20)</td><td className="py-2 px-3">Exportar datos en formato JSON</td></tr>
                <tr><td className="py-2 px-3">Oposición (Art. 21)</td><td className="py-2 px-3">Oponerte al procesamiento</td></tr>
              </tbody>
            </table>
          </div>
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 p-4 rounded">
            <h4 className="font-medium mb-2">📧 ¿Cómo ejercer estos derechos?</h4>
            <p className="text-sm">Envía un email a: <strong>runna.io.service@gmail.com</strong></p>
            <p className="text-sm text-muted-foreground">Plazo de respuesta: 30 días</p>
          </div>
        </section>

        <section id="seguridad" className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">8. Seguridad</h2>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Cifrado HTTPS/TLS en todas las comunicaciones</li>
            <li>Base de datos Turso con cifrado en reposo</li>
            <li>Contraseñas hasheadas con SHA-256 y salt</li>
            <li>Tokens OAuth almacenados de forma segura</li>
            <li>Protección DDoS con Cloudflare</li>
          </ul>
        </section>

        <section id="edad" className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">9. Edad Mínima</h2>
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border-l-4 border-yellow-500 p-4 rounded-r">
            <p className="font-medium">Requisito de edad: 14 años</p>
            <p className="text-sm text-muted-foreground mt-1">Según el artículo 7 de la LOPD-GDD española, la edad de consentimiento digital en España es 14 años. Los menores de 14 años no pueden crear una cuenta.</p>
          </div>
        </section>

        <section id="contacto" className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">10. Contacto y Reclamaciones</h2>
          
          <div className="bg-muted p-4 rounded mb-4">
            <h4 className="font-medium mb-2">📧 Consultas de privacidad</h4>
            <p className="text-sm">runna.io.service@gmail.com</p>
          </div>

          <div className="bg-muted p-4 rounded">
            <h4 className="font-medium mb-2">🏛️ Autoridad de control</h4>
            <p className="text-sm font-medium">Agencia Española de Protección de Datos (AEPD)</p>
            <p className="text-sm text-muted-foreground">Web: www.aepd.es</p>
            <p className="text-sm text-muted-foreground">Teléfono: 901 100 099</p>
          </div>
        </section>

        <section className="mb-10 p-6 bg-muted rounded-lg">
          <h2 className="text-xl font-semibold mb-4">📊 Resumen</h2>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>Cookies de tracking</div><div className="text-red-500 font-medium">❌ No usamos</div>
            <div>Google Analytics</div><div className="text-red-500 font-medium">❌ No usamos</div>
            <div>Facebook Pixel</div><div className="text-red-500 font-medium">❌ No usamos</div>
            <div>Publicidad</div><div className="text-red-500 font-medium">❌ No mostramos</div>
            <div>Venta de datos</div><div className="text-red-500 font-medium">❌ No vendemos</div>
            <div>Cloudflare Analytics</div><div className="text-green-500 font-medium">✅ Único analytics</div>
            <div>Push notifications</div><div className="text-green-500 font-medium">✅ Web Push nativo</div>
            <div>Edad mínima</div><div className="font-medium">14 años</div>
          </div>
        </section>

        <footer className="text-center pt-8 pb-16 border-t text-muted-foreground text-sm" style={{ paddingBottom: 'max(4rem, env(safe-area-inset-bottom))' }}>
          <p>© 2026 Javier Poves Ruiz - Runna.io</p>
          <p className="mt-2">
            <a href="/" className="text-primary hover:underline">← Volver a Runna.io</a>
          </p>
        </footer>
      </div>
    </div>
  );
}

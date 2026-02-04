import { useEffect } from 'react';
import { X } from 'lucide-react';

export default function TermsPage() {
  useEffect(() => {
    document.title = 'Términos y Condiciones - Runna.io';
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
        className="fixed top-4 right-4 z-50 p-2 rounded-full bg-background/80 backdrop-blur-sm border shadow-lg hover:bg-muted transition-colors"
        aria-label="Cerrar"
      >
        <X className="h-6 w-6" />
      </button>

      <div className="container max-w-4xl mx-auto px-4 py-8">
        <header className="text-center mb-12 pb-6 border-b-2 border-primary">
          <h1 className="text-3xl font-bold mb-2">🏃 Runna.io</h1>
          <h2 className="text-2xl font-semibold text-foreground mb-4">Términos y Condiciones</h2>
          <div className="text-muted-foreground text-sm space-y-1">
            <p><strong>Última actualización:</strong> 4 de febrero de 2026</p>
            <p><strong>Responsable:</strong> Javier Poves Ruiz</p>
            <p><strong>Contacto:</strong> runna.io.service@gmail.com</p>
          </div>
        </header>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">1. Aceptación de los Términos</h2>
          <p className="text-muted-foreground mb-4">
            Al crear una cuenta o utilizar Runna.io, aceptas estos Términos y Condiciones y nuestra{' '}
            <a href="/privacy" className="text-primary hover:underline">Política de Privacidad</a>.
          </p>
          <p className="text-muted-foreground">
            Si no estás de acuerdo con estos términos, no utilices el servicio.
          </p>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">2. Descripción del Servicio</h2>
          <p className="text-muted-foreground mb-4">Runna.io es una aplicación web que permite:</p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Registrar actividades deportivas (correr, caminar, ciclismo)</li>
            <li>Conquistar territorios virtuales basados en tus rutas GPS</li>
            <li>Competir con otros usuarios por el control de zonas</li>
            <li>Sincronizar actividades desde Polar Flow y Strava</li>
            <li>Conectar con amigos y ver sus territorios</li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">3. Elegibilidad</h2>
          
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border-l-4 border-yellow-500 p-4 rounded-r mb-4">
            <h3 className="font-medium mb-2">Edad mínima: 14 años</h3>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
              <li>Los menores de 14 años <strong>no pueden</strong> crear una cuenta</li>
              <li>No disponemos de mecanismo de verificación de consentimiento parental</li>
              <li>Si detectamos que un usuario es menor de 14 años, eliminaremos su cuenta</li>
            </ul>
          </div>

          <h3 className="font-medium mt-4 mb-2">Capacidad legal</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Debes tener capacidad legal para aceptar estos términos</li>
            <li>Si actúas en nombre de una organización, debes tener autoridad para vincularla</li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">4. Cuenta de Usuario</h2>
          
          <h3 className="font-medium mt-4 mb-2">Registro</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
            <li>Debes proporcionar información veraz y actualizada</li>
            <li>Eres responsable de mantener la confidencialidad de tu contraseña</li>
            <li>Debes notificarnos inmediatamente si sospechas uso no autorizado</li>
          </ul>

          <h3 className="font-medium mt-4 mb-2">Una cuenta por persona</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
            <li>Cada usuario puede tener una sola cuenta</li>
            <li>Las cuentas son personales e intransferibles</li>
            <li>No puedes crear cuentas automatizadas (bots)</li>
          </ul>

          <h3 className="font-medium mt-4 mb-2">Suspensión o eliminación</h3>
          <p className="text-muted-foreground mb-2">Podemos suspender o eliminar tu cuenta si:</p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Violas estos términos</li>
            <li>Proporcionas información falsa</li>
            <li>Realizas actividades fraudulentas</li>
            <li>Abusas del sistema</li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">5. Uso Aceptable</h2>
          
          <div className="bg-green-50 dark:bg-green-900/20 border-l-4 border-green-500 p-4 rounded-r mb-4">
            <h3 className="font-medium mb-2">✅ Lo que PUEDES hacer:</h3>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
              <li>Registrar tus actividades deportivas reales</li>
              <li>Sincronizar con Polar/Strava con tu consentimiento</li>
              <li>Competir de forma justa con otros usuarios</li>
              <li>Invitar amigos a la plataforma</li>
              <li>Compartir tus logros en redes sociales</li>
            </ul>
          </div>

          <div className="bg-red-50 dark:bg-red-900/20 border-l-4 border-red-500 p-4 rounded-r">
            <h3 className="font-medium mb-2">❌ Lo que NO puedes hacer:</h3>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
              <li><strong>GPS spoofing:</strong> Falsificar ubicación para conquistar territorios sin actividad real</li>
              <li><strong>Múltiples cuentas:</strong> Crear varias cuentas para ventaja competitiva</li>
              <li><strong>Automatización abusiva:</strong> Scripts o bots que interactúen con la plataforma</li>
              <li><strong>Acoso:</strong> Hostigar, acosar o intimidar a otros usuarios</li>
              <li><strong>Contenido ilegal:</strong> Publicar contenido que viole leyes aplicables</li>
              <li><strong>Ingeniería inversa:</strong> Intentar acceder al código fuente o sistemas internos</li>
            </ul>
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">6. Propiedad Intelectual</h2>
          
          <h3 className="font-medium mt-4 mb-2">De Runna.io</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
            <li>El código, diseño, logotipos y marca son propiedad de Javier Poves Ruiz</li>
            <li>No puedes copiar, modificar o distribuir el software sin autorización</li>
          </ul>

          <h3 className="font-medium mt-4 mb-2">De los usuarios</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Tus datos de actividades deportivas te pertenecen</li>
            <li>Nos otorgas licencia para procesarlos según la Política de Privacidad</li>
            <li>Puedes exportar tus datos en cualquier momento (portabilidad RGPD)</li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">7. Integraciones con Terceros</h2>
          
          <h3 className="font-medium mt-4 mb-2">Polar Flow</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
            <li>La conexión es opcional y requiere tu consentimiento explícito</li>
            <li>Accedemos solo a los datos que autorizas (ejercicios, rutas)</li>
            <li>Puedes desconectar en cualquier momento desde tu perfil</li>
          </ul>

          <h3 className="font-medium mt-4 mb-2">Strava</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
            <li>La conexión es opcional y requiere tu consentimiento explícito</li>
            <li>Accedemos solo a los datos que autorizas (actividades, rutas)</li>
            <li>Puedes desconectar en cualquier momento desde tu perfil</li>
          </ul>

          <p className="text-sm text-muted-foreground">
            No somos responsables de cambios en las APIs de terceros. Si un servicio externo falla, algunas funcionalidades pueden no estar disponibles.
          </p>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">8. Territorios y Competencia</h2>
          
          <h3 className="font-medium mt-4 mb-2">Mecánica del juego</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
            <li>Los territorios se conquistan corriendo/caminando físicamente por una zona</li>
            <li>Otros usuarios pueden "robar" tus territorios corriendo por encima</li>
            <li>El área total conquistada determina tu posición en el ranking</li>
          </ul>

          <h3 className="font-medium mt-4 mb-2">Fair play</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Solo se permiten actividades reales registradas con GPS</li>
            <li>El GPS spoofing o cualquier forma de trampa resulta en suspensión</li>
            <li>Nos reservamos el derecho de invalidar actividades sospechosas</li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">9. Limitación de Responsabilidad</h2>
          
          <h3 className="font-medium mt-4 mb-2">El servicio se proporciona "tal cual"</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
            <li>No garantizamos disponibilidad ininterrumpida</li>
            <li>No garantizamos que el servicio esté libre de errores</li>
            <li>Nos esforzamos por mantener el servicio funcionando, pero pueden ocurrir caídas</li>
          </ul>

          <h3 className="font-medium mt-4 mb-2">Exclusión de daños</h3>
          <p className="text-muted-foreground">
            En la máxima medida permitida por la ley, no somos responsables de daños indirectos, incidentales o consecuentes.
            Nuestra responsabilidad máxima se limita a los importes pagados (actualmente €0, servicio gratuito).
          </p>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">10. Terminación</h2>
          
          <h3 className="font-medium mt-4 mb-2">Por el usuario</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground mb-4">
            <li>Puedes eliminar tu cuenta en cualquier momento</li>
            <li>La eliminación es inmediata e irreversible</li>
            <li>Tus territorios se liberan para que otros puedan conquistarlos</li>
          </ul>

          <h3 className="font-medium mt-4 mb-2">Por Runna.io</h3>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Podemos terminar o suspender tu cuenta por violación de estos términos</li>
            <li>En casos graves, la terminación puede ser inmediata</li>
            <li>Te notificaremos la razón (excepto si hay obligación legal de no hacerlo)</li>
          </ul>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">11. Ley Aplicable y Jurisdicción</h2>
          
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b"><td className="py-2 font-medium">Ley aplicable</td><td className="py-2">Leyes de España (RGPD + LOPD-GDD)</td></tr>
                <tr className="border-b"><td className="py-2 font-medium">Jurisdicción</td><td className="py-2">Tribunales de España</td></tr>
                <tr><td className="py-2 font-medium">Derechos RGPD</td><td className="py-2">Agencia Española de Protección de Datos (AEPD)</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4 pb-2 border-b">12. Contacto</h2>
          <div className="bg-muted p-4 rounded">
            <p className="text-sm"><strong>Email:</strong> runna.io.service@gmail.com</p>
          </div>
        </section>

        <section className="mb-10 p-6 bg-muted rounded-lg">
          <h2 className="text-xl font-semibold mb-4">📊 Resumen</h2>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>Edad mínima</div><div className="font-medium">14 años</div>
            <div>Servicio</div><div className="font-medium">Gratuito</div>
            <div>Tus datos</div><div className="font-medium">Te pertenecen (RGPD)</div>
            <div>Integraciones</div><div className="font-medium">Polar + Strava (opcionales)</div>
            <div>Ley aplicable</div><div className="font-medium">España</div>
            <div>Jurisdicción</div><div className="font-medium">España</div>
          </div>
        </section>

        <section className="mb-10 p-6 bg-primary/10 border border-primary/30 rounded-lg">
          <h2 className="text-lg font-semibold mb-3">Al crear una cuenta, confirmas que:</h2>
          <ol className="list-decimal list-inside space-y-2 text-sm">
            <li>Tienes al menos <strong>14 años</strong></li>
            <li>Has leído y aceptas estos <strong>Términos y Condiciones</strong></li>
            <li>Has leído y aceptas la <a href="/privacy" className="text-primary hover:underline">Política de Privacidad</a></li>
          </ol>
        </section>

        <footer className="text-center pt-8 pb-16 border-t text-muted-foreground text-sm" style={{ paddingBottom: 'max(4rem, env(safe-area-inset-bottom))' }}>
          <p>© 2026 Javier Poves Ruiz - Runna.io</p>
          <p className="mt-2">
            <a href="/" className="text-primary hover:underline">← Volver a Runna.io</a>
            {' • '}
            <a href="/privacy" className="text-primary hover:underline">Política de Privacidad</a>
          </p>
        </footer>
      </div>
    </div>
  );
}

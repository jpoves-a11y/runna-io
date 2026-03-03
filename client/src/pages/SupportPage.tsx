import { useEffect } from 'react';
import { X, Mail, ExternalLink, Link as LinkIcon } from 'lucide-react';

export default function SupportPage() {
  useEffect(() => {
    document.title = 'Soporte - Runna.io';
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
          <h2 className="text-2xl font-semibold text-foreground mb-4">Centro de Soporte</h2>
          <p className="text-muted-foreground">¿Necesitas ayuda? Estamos aquí para ti</p>
        </header>

        <div className="space-y-8">
          {/* Contacto */}
          <section className="bg-card border rounded-lg p-6">
            <h3 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              Contacto
            </h3>
            <p className="text-muted-foreground mb-4">
              Para cualquier consulta, problema técnico o sugerencia, puedes contactarnos en:
            </p>
            <a 
              href="mailto:runna.io.service@gmail.com" 
              className="inline-flex items-center gap-2 text-primary hover:underline font-medium"
            >
              <Mail className="h-4 w-4" />
              runna.io.service@gmail.com
            </a>
          </section>

          {/* Integraciones */}
          <section className="bg-card border rounded-lg p-6">
            <h3 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <LinkIcon className="h-5 w-5 text-primary" />
              Integraciones con Plataformas de Fitness
            </h3>
            
            <div className="space-y-6">
              {/* Strava */}
              <div>
                <h4 className="font-semibold text-lg mb-2">Strava</h4>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p><strong>Cómo conectar:</strong> Ve a tu perfil → Toca el botón "Conectar con Strava" → Autoriza el acceso</p>
                  <p><strong>Qué sincroniza:</strong> Actividades de running con GPS (distancia, duración, ruta)</p>
                  <p><strong>Cómo desconectar:</strong> Perfil → "Desconectar Strava"</p>
                </div>
              </div>

              {/* Polar */}
              <div>
                <h4 className="font-semibold text-lg mb-2">Polar Flow</h4>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p><strong>Cómo conectar:</strong> Ve a tu perfil → Toca el botón "Conectar con Polar" → Autoriza el acceso</p>
                  <p><strong>Qué sincroniza:</strong> Ejercicios de running/walking con GPS</p>
                  <p><strong>Sincronización manual:</strong> Usa el botón "Sincronizar" en tu perfil para actualizar actividades</p>
                  <p><strong>Cómo desconectar:</strong> Perfil → "Desconectar Polar"</p>
                </div>
              </div>

              {/* COROS */}
              <div>
                <h4 className="font-semibold text-lg mb-2">COROS</h4>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p><strong>Cómo conectar:</strong> Ve a tu perfil → Toca el botón "Conectar con COROS" → Autoriza el acceso</p>
                  <p><strong>Qué sincroniza:</strong> Workouts de running/trail con datos GPS automáticamente</p>
                  <p><strong>Sincronización automática:</strong> Los workouts se sincronizan automáticamente al completarse en tu reloj COROS</p>
                  <p><strong>Cómo desconectar:</strong> Perfil → "Desconectar COROS"</p>
                </div>
              </div>
            </div>
          </section>

          {/* FAQ */}
          <section className="bg-card border rounded-lg p-6">
            <h3 className="text-xl font-semibold mb-4">❓ Preguntas Frecuentes</h3>
            
            <div className="space-y-4">
              <div>
                <h4 className="font-semibold mb-1">¿Mis actividades sincronizadas aparecen automáticamente en el mapa?</h4>
                <p className="text-sm text-muted-foreground">
                  Sí. Una vez conectes tu cuenta de Strava, Polar o COROS, las actividades de running se procesarán automáticamente 
                  y aparecerán como territorio en el mapa.
                </p>
              </div>

              <div>
                <h4 className="font-semibold mb-1">¿Puedo eliminar actividades ya sincronizadas?</h4>
                <p className="text-sm text-muted-foreground">
                  Sí. Desde tu perfil puedes ver todas tus actividades sincronizadas y eliminarlas individualmente. 
                  El territorio asociado se eliminará automáticamente.
                </p>
              </div>

              <div>
                <h4 className="font-semibold mb-1">¿Qué pasa si desconecto mi cuenta de Strava/Polar/COROS?</h4>
                <p className="text-sm text-muted-foreground">
                  Al desconectar, las actividades ya sincronizadas permanecerán en tu perfil, pero no se importarán nuevas actividades. 
                  Puedes reconectar en cualquier momento.
                </p>
              </div>

              <div>
                <h4 className="font-semibold mb-1">¿Runna.io es seguro? ¿Qué datos se almacenan?</h4>
                <p className="text-sm text-muted-foreground">
                  Sí. Solo almacenamos los datos GPS de tus rutas, distancia y duración. Revisa nuestra{' '}
                  <a href="/privacy" className="text-primary hover:underline">Política de Privacidad</a> para más detalles.
                </p>
              </div>

              <div>
                <h4 className="font-semibold mb-1">¿Hay algún coste por usar Runna.io?</h4>
                <p className="text-sm text-muted-foreground">
                  No. Runna.io es completamente gratuito, sin subscripciones ni pagos ocultos.
                </p>
              </div>
            </div>
          </section>

          {/* Privacidad y Términos */}
          <section className="bg-card border rounded-lg p-6">
            <h3 className="text-xl font-semibold mb-4 flex items-center gap-2">
              <ExternalLink className="h-5 w-5 text-primary" />
              Documentación Legal
            </h3>
            <div className="space-y-2">
              <a 
                href="/privacy" 
                className="block text-primary hover:underline"
              >
                📜 Política de Privacidad
              </a>
              <a 
                href="/terms" 
                className="block text-primary hover:underline"
              >
                📋 Términos de Servicio
              </a>
            </div>
          </section>

          {/* Portal de Login */}
          <section className="bg-card border rounded-lg p-6">
            <h3 className="text-xl font-semibold mb-4">🔑 Portal de Acceso</h3>
            <p className="text-muted-foreground mb-4">
              Para acceder a tu cuenta de Runna.io:
            </p>
            <a 
              href="/" 
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
            >
              Ir a Runna.io
              <ExternalLink className="h-4 w-4" />
            </a>
          </section>
        </div>

        {/* Footer */}
        <footer className="mt-12 pt-6 border-t text-center text-sm text-muted-foreground">
          <p>© 2026 Runna.io - Javier Poves Ruiz</p>
          <p className="mt-1">Para soporte técnico: runna.io.service@gmail.com</p>
        </footer>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Map, Trophy, Users, Bell, Share, Plus,
  ChevronRight, ChevronLeft, X, Smartphone,
  Activity, Swords, MessageCircle, Check
} from 'lucide-react';
import {
  requestNotificationPermission,
  registerServiceWorker,
  subscribeToPushNotifications,
} from '@/lib/pushNotifications';

const ONBOARDING_KEY = 'runna_onboarding_done';

interface OnboardingTutorialProps {
  userId?: string;
  onComplete: () => void;
}

interface Step {
  icon: React.ReactNode;
  title: string;
  description: string;
  extra?: React.ReactNode;
}

function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

export function OnboardingTutorial({ userId, onComplete }: OnboardingTutorialProps) {
  const [step, setStep] = useState(0);
  const [notifStatus, setNotifStatus] = useState<'idle' | 'granted' | 'denied'>('idle');

  const handleComplete = () => {
    localStorage.setItem(ONBOARDING_KEY, 'true');
    onComplete();
  };

  const handleNotifications = async () => {
    if (!userId) return;
    const perm = await requestNotificationPermission();
    if (perm === 'granted') {
      setNotifStatus('granted');
      const reg = await registerServiceWorker();
      if (reg) await subscribeToPushNotifications(reg, userId);
    } else {
      setNotifStatus('denied');
    }
  };

  const pwaStep: Step = (() => {
    if (isStandalone()) {
      return {
        icon: <Check className="h-10 w-10 text-green-400" />,
        title: 'App instalada correctamente',
        description: 'Ya tienes Runna.io como app. Funciona mejor que en el navegador: pantalla completa, sin barra de direcciones y con mejor rendimiento GPS.',
      };
    }
    if (isIOS()) {
      return {
        icon: <Smartphone className="h-10 w-10 text-blue-400" />,
        title: 'Instala la app en tu iPhone',
        description: 'Para la mejor experiencia (GPS, notificaciones, pantalla completa):',
        extra: (
          <div className="mt-3 space-y-3 text-left text-sm">
            <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/10">
              <div className="w-7 h-7 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0 text-xs font-bold text-blue-400">1</div>
              <p className="text-slate-300">Pulsa el icono <Share className="inline h-4 w-4 text-blue-400 mx-0.5" /> de <strong>compartir</strong> en la barra inferior de Safari</p>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/10">
              <div className="w-7 h-7 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0 text-xs font-bold text-blue-400">2</div>
              <p className="text-slate-300">Busca y pulsa <strong>&quot;Agregar a pantalla de inicio&quot;</strong> <Plus className="inline h-4 w-4 text-blue-400 mx-0.5" /></p>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/10">
              <div className="w-7 h-7 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0 text-xs font-bold text-blue-400">3</div>
              <p className="text-slate-300">Pulsa <strong>&quot;Agregar&quot;</strong> y abre la app desde el icono en tu pantalla de inicio</p>
            </div>
          </div>
        ),
      };
    }
    if (isAndroid()) {
      return {
        icon: <Smartphone className="h-10 w-10 text-green-400" />,
        title: 'Instala la app en tu Android',
        description: 'Para la mejor experiencia (GPS, notificaciones, pantalla completa):',
        extra: (
          <div className="mt-3 space-y-3 text-left text-sm">
            <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/10">
              <div className="w-7 h-7 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0 text-xs font-bold text-green-400">1</div>
              <p className="text-slate-300">Pulsa el menu <strong>&#8942;</strong> (tres puntos) de Chrome arriba a la derecha</p>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/10">
              <div className="w-7 h-7 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0 text-xs font-bold text-green-400">2</div>
              <p className="text-slate-300">Pulsa <strong>&quot;Instalar app&quot;</strong> o <strong>&quot;Agregar a pantalla de inicio&quot;</strong></p>
            </div>
          </div>
        ),
      };
    }
    return {
      icon: <Smartphone className="h-10 w-10 text-blue-400" />,
      title: 'Instala la app',
      description: 'Usa tu movil para acceder a runna.io y agrega la app a tu pantalla de inicio para la mejor experiencia con GPS y notificaciones.',
    };
  })();

  const notifStep: Step = {
    icon: <Bell className="h-10 w-10 text-yellow-400" />,
    title: 'Activa las notificaciones',
    description: 'Recibe avisos cuando alguien conquiste tu territorio, te mencione en un comentario o interactue con tus rutas.',
    extra: (
      <div className="mt-4">
        {notifStatus === 'idle' ? (
          <Button
            size="lg"
            className="w-full h-12 text-base font-semibold bg-yellow-500 hover:bg-yellow-600 text-black"
            onClick={handleNotifications}
          >
            <Bell className="h-5 w-5 mr-2" />
            Activar notificaciones
          </Button>
        ) : notifStatus === 'granted' ? (
          <div className="flex items-center justify-center gap-2 p-3 rounded-xl bg-green-500/20 border border-green-500/30">
            <Check className="h-5 w-5 text-green-400" />
            <span className="text-green-400 font-semibold">Notificaciones activadas</span>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-2 p-3 rounded-xl bg-red-500/20 border border-red-500/30">
            <X className="h-5 w-5 text-red-400" />
            <span className="text-red-400 text-sm">Denegadas. Puedes activarlas luego en ajustes.</span>
          </div>
        )}
      </div>
    ),
  };

  const steps: Step[] = [
    {
      icon: (
        <div className="relative">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-green-500 to-green-700 flex items-center justify-center shadow-lg shadow-green-500/30">
            <span className="text-4xl font-black text-white">R</span>
          </div>
        </div>
      ),
      title: 'Bienvenido a Runna.io',
      description: 'Corre, conquista territorio y compite contra tus amigos en el mapa. Cada ruta que corres expande tu zona de dominio.',
    },
    {
      icon: <Map className="h-10 w-10 text-green-400" />,
      title: 'Conquista territorio',
      description: 'Al correr, el area que rodea tu ruta se convierte en tu territorio con tu color. Puedes robar territorios de otros corredores pasando por encima.',
      extra: (
        <div className="mt-3 flex items-center gap-2 p-3 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300">
          <Swords className="h-5 w-5 text-red-400 flex-shrink-0" />
          <span>Si alguien corre por tu zona, te roba ese territorio</span>
        </div>
      ),
    },
    {
      icon: <Activity className="h-10 w-10 text-primary" />,
      title: 'Graba o importa rutas',
      description: 'Graba tus rutas GPS directamente desde la app con el boton verde, o importa actividades desde Polar y Strava conectando tu cuenta.',
      extra: (
        <div className="mt-3 flex items-center gap-2 p-3 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-500 to-green-700 flex items-center justify-center flex-shrink-0">
            <span className="text-white text-lg">&#9654;</span>
          </div>
          <span>El boton verde en la barra inferior inicia la grabacion GPS</span>
        </div>
      ),
    },
    {
      icon: <Trophy className="h-10 w-10 text-yellow-400" />,
      title: 'Rankings y competicion',
      description: 'Compite en el ranking por territorio total conquistado. Sube posiciones corriendo mas y robando territorio a otros.',
    },
    {
      icon: <Users className="h-10 w-10 text-purple-400" />,
      title: 'Amigos y feed social',
      description: 'Agrega amigos con su codigo, ve sus rutas en el mapa, comenta y reacciona a sus actividades en el feed social.',
      extra: (
        <div className="mt-3 flex items-center gap-2 p-3 rounded-xl bg-white/5 border border-white/10 text-sm text-slate-300">
          <MessageCircle className="h-5 w-5 text-blue-400 flex-shrink-0" />
          <span>Usa @nombre para mencionar amigos en los comentarios</span>
        </div>
      ),
    },
    pwaStep,
    notifStep,
  ];

  const totalSteps = steps.length;
  const currentStep = steps[step];
  const isLast = step === totalSteps - 1;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/95 backdrop-blur-md flex flex-col">
      {/* Skip button */}
      <div className="flex justify-end p-3" style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}>
        <button
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors px-3 py-1.5 rounded-full border border-slate-700"
          onClick={handleComplete}
        >
          Saltar tutorial
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        {/* Icon */}
        <div className="mb-6 animate-scale-in">
          {currentStep.icon}
        </div>

        {/* Title */}
        <h2 className="text-2xl font-bold text-white mb-3 animate-fade-in">
          {currentStep.title}
        </h2>

        {/* Description */}
        <p className="text-slate-400 text-sm leading-relaxed max-w-sm animate-fade-in">
          {currentStep.description}
        </p>

        {/* Extra content */}
        {currentStep.extra && (
          <div className="w-full max-w-sm animate-fade-in mt-1">
            {currentStep.extra}
          </div>
        )}
      </div>

      {/* Bottom: dots + nav */}
      <div className="p-6 space-y-4" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)' }}>
        {/* Dots */}
        <div className="flex items-center justify-center gap-1.5">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`rounded-full transition-all duration-300 ${
                i === step ? 'w-6 h-2 bg-primary' : 'w-2 h-2 bg-slate-700'
              }`}
            />
          ))}
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-3">
          {step > 0 && (
            <Button
              variant="outline"
              size="lg"
              className="flex-1 h-12 border-slate-700 text-slate-300 hover:bg-slate-800"
              onClick={() => setStep(step - 1)}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Anterior
            </Button>
          )}
          <Button
            size="lg"
            className={`flex-1 h-12 font-semibold ${isLast ? 'gradient-primary border-0' : 'bg-primary hover:bg-primary/90'}`}
            onClick={isLast ? handleComplete : () => setStep(step + 1)}
          >
            {isLast ? (
              <>Empezar</>
            ) : (
              <>
                Siguiente
                <ChevronRight className="h-4 w-4 ml-1" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function shouldShowOnboarding(): boolean {
  return localStorage.getItem(ONBOARDING_KEY) !== 'true';
}

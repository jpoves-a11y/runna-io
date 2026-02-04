import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { LogIn, UserPlus, Sparkles, Eye, EyeOff, X } from 'lucide-react';
import { getRandomUserColor } from '@/lib/colors';

interface LoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogin: (userId: string) => void;
}

export function LoginDialog({ open, onOpenChange, onLogin }: LoginDialogProps) {
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerUsername, setRegisterUsername] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerName, setRegisterName] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showRegisterPassword, setShowRegisterPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const { toast } = useToast();

  const loginMutation = useMutation({
    mutationFn: async (data: { username: string; password: string }) => {
      const response = await apiRequest('POST', '/api/auth/login', data);
      return response.json();
    },
    onSuccess: (user) => {
      onLogin(user.id);
      toast({
        title: 'Sesion iniciada',
        description: 'Bienvenido de nuevo!',
      });
      onOpenChange(false);
      setLoginUsername('');
      setLoginPassword('');
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo iniciar sesion',
        variant: 'destructive',
      });
    },
  });

  const registerMutation = useMutation({
    mutationFn: async (data: { username: string; email: string; name: string; password: string }) => {
      const response = await apiRequest('POST', '/api/users', {
        username: data.username,
        email: data.email,
        name: data.name,
        password: data.password,
        color: getRandomUserColor(),
        avatar: null,
      });
      return response.json();
    },
    onSuccess: (user) => {
      onLogin(user.id);
      toast({
        title: 'Cuenta creada',
        description: 'Bienvenido a Runna.io!',
      });
      onOpenChange(false);
      setRegisterUsername('');
      setRegisterName('');
      setRegisterPassword('');
        setRegisterEmail('');
      setAcceptedTerms(false);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo crear la cuenta',
        variant: 'destructive',
      });
    },
  });

  const handleLogin = () => {
    if (!loginUsername.trim()) {
      toast({
        title: 'Error',
        description: 'Ingresa tu nombre de usuario',
        variant: 'destructive',
      });
      return;
    }
    if (!loginPassword) {
      toast({
        title: 'Error',
        description: 'Ingresa tu contraseña',
        variant: 'destructive',
      });
      return;
    }
    loginMutation.mutate({ username: loginUsername, password: loginPassword });
  };

  const handleRegister = () => {
    if (!registerUsername.trim() || !registerName.trim() || !registerEmail.trim()) {
      toast({
        title: 'Error',
        description: 'Completa todos los campos',
        variant: 'destructive',
      });
      return;
    }
    if (!registerEmail.includes('@')) {
      toast({
        title: 'Error',
        description: 'Ingresa un email válido',
        variant: 'destructive',
      });
      return;
    }
    if (!registerPassword || registerPassword.length < 4) {
      toast({
        title: 'Error',
        description: 'La contraseña debe tener al menos 4 caracteres',
        variant: 'destructive',
      });
      return;
    }
    if (!acceptedTerms) {
      toast({
        title: 'Error',
        description: 'Debes aceptar los términos y condiciones para continuar',
        variant: 'destructive',
      });
      return;
    }
    registerMutation.mutate({ 
      username: registerUsername,
      email: registerEmail,
      name: registerName,
      password: registerPassword,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-2xl">
            <div className="relative">
              <Sparkles className="h-6 w-6 text-primary" />
            </div>
            Runna.io
          </DialogTitle>
          <DialogDescription>
            Inicia sesion o crea una cuenta para empezar a conquistar
          </DialogDescription>
        </DialogHeader>
        
        <Tabs defaultValue="login" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Iniciar sesion</TabsTrigger>
            <TabsTrigger value="register">Registrarse</TabsTrigger>
          </TabsList>
          
          <TabsContent value="login" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="login-username">Nombre de usuario</Label>
              <Input
                id="login-username"
                placeholder="@tunombre"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                data-testid="input-login-username"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="login-password">Contraseña</Label>
              <div className="relative">
                <Input
                  id="login-password"
                  type={showLoginPassword ? 'text' : 'password'}
                  placeholder="Tu contraseña"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  data-testid="input-login-password"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0"
                  onClick={() => setShowLoginPassword(!showLoginPassword)}
                  data-testid="button-toggle-login-password"
                >
                  {showLoginPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <Button
              onClick={handleLogin}
              disabled={loginMutation.isPending}
              className="w-full"
              data-testid="button-login"
            >
              <LogIn className="h-5 w-5 mr-2" />
              {loginMutation.isPending ? 'Iniciando...' : 'Iniciar sesion'}
            </Button>
          </TabsContent>
          
          <TabsContent value="register" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="register-name">Nombre completo</Label>
              <Input
                id="register-name"
                placeholder="Juan Perez"
                value={registerName}
                onChange={(e) => setRegisterName(e.target.value)}
                data-testid="input-register-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="register-username">Nombre de usuario</Label>
              <Input
                id="register-username"
                placeholder="@tunombre"
                value={registerUsername}
                onChange={(e) => setRegisterUsername(e.target.value)}
                data-testid="input-register-username"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="register-email">Correo electrónico</Label>
              <Input
                id="register-email"
                type="email"
                placeholder="tu@correo.com"
                value={registerEmail}
                onChange={(e) => setRegisterEmail(e.target.value)}
                data-testid="input-register-email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="register-password">Contraseña</Label>
              <div className="relative">
                <Input
                  id="register-password"
                  type={showRegisterPassword ? 'text' : 'password'}
                  placeholder="Minimo 4 caracteres"
                  value={registerPassword}
                  onChange={(e) => setRegisterPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                  data-testid="input-register-password"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0"
                  onClick={() => setShowRegisterPassword(!showRegisterPassword)}
                  data-testid="button-toggle-register-password"
                >
                  {showRegisterPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="flex items-start space-x-2 pt-2">
              <Checkbox 
                id="accept-terms" 
                checked={acceptedTerms}
                onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                data-testid="checkbox-accept-terms"
              />
              <div className="grid gap-1.5 leading-none">
                <label
                  htmlFor="accept-terms"
                  className="text-sm text-muted-foreground leading-relaxed cursor-pointer"
                >
                  He leído y acepto los{' '}
                  <button 
                    type="button"
                    className="text-primary underline hover:no-underline"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowTerms(true);
                    }}
                  >
                    Términos y Condiciones
                  </button>{' '}
                  y la{' '}
                  <button 
                    type="button"
                    className="text-primary underline hover:no-underline"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setShowPrivacy(true);
                    }}
                  >
                    Política de Privacidad
                  </button>
                </label>
                <p className="text-xs text-muted-foreground">
                  Debes tener al menos 14 años para usar Runna.io
                </p>
              </div>
            </div>

            <Button
              onClick={handleRegister}
              disabled={registerMutation.isPending || !acceptedTerms}
              className="w-full"
              data-testid="button-register"
            >
              <UserPlus className="h-5 w-5 mr-2" />
              {registerMutation.isPending ? 'Creando cuenta...' : 'Crear cuenta'}
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>

      {/* Sheet para Términos y Condiciones */}
      <Sheet open={showTerms} onOpenChange={setShowTerms}>
        <SheetContent side="bottom" className="h-[85vh] p-0">
          <SheetHeader className="px-4 py-3 border-b sticky top-0 bg-background z-10">
            <div className="flex items-center justify-between">
              <SheetTitle>Términos y Condiciones</SheetTitle>
              <Button variant="ghost" size="icon" onClick={() => setShowTerms(false)}>
                <X className="h-5 w-5" />
              </Button>
            </div>
          </SheetHeader>
          <ScrollArea className="h-[calc(85vh-60px)] px-4 py-4">
            <TermsContent />
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* Sheet para Política de Privacidad */}
      <Sheet open={showPrivacy} onOpenChange={setShowPrivacy}>
        <SheetContent side="bottom" className="h-[85vh] p-0">
          <SheetHeader className="px-4 py-3 border-b sticky top-0 bg-background z-10">
            <div className="flex items-center justify-between">
              <SheetTitle>Política de Privacidad</SheetTitle>
              <Button variant="ghost" size="icon" onClick={() => setShowPrivacy(false)}>
                <X className="h-5 w-5" />
              </Button>
            </div>
          </SheetHeader>
          <ScrollArea className="h-[calc(85vh-60px)] px-4 py-4">
            <PrivacyContent />
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </Dialog>
  );
}

// Contenido de Términos y Condiciones
function TermsContent() {
  return (
    <div className="space-y-6 text-sm pb-8">
      <p className="text-muted-foreground">
        <strong>Última actualización:</strong> 4 de febrero de 2026
      </p>

      <section>
        <h3 className="font-semibold mb-2">1. Aceptación de los Términos</h3>
        <p className="text-muted-foreground">
          Al crear una cuenta o utilizar Runna.io, aceptas estos Términos y Condiciones y nuestra Política de Privacidad. Si no estás de acuerdo, no utilices el servicio.
        </p>
      </section>

      <section>
        <h3 className="font-semibold mb-2">2. Descripción del Servicio</h3>
        <p className="text-muted-foreground mb-2">Runna.io permite:</p>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          <li>Registrar actividades deportivas</li>
          <li>Conquistar territorios virtuales basados en tus rutas GPS</li>
          <li>Competir con otros usuarios</li>
          <li>Sincronizar con Polar Flow y Strava</li>
        </ul>
      </section>

      <section>
        <h3 className="font-semibold mb-2">3. Edad Mínima</h3>
        <p className="text-muted-foreground">
          Debes tener al menos <strong>14 años</strong> para crear una cuenta. Si detectamos que eres menor, eliminaremos tu cuenta.
        </p>
      </section>

      <section>
        <h3 className="font-semibold mb-2">4. Uso Permitido</h3>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          <li>Registrar tus propias actividades deportivas</li>
          <li>Competir de forma deportiva y respetuosa</li>
          <li>Compartir logros con amigos</li>
        </ul>
      </section>

      <section>
        <h3 className="font-semibold mb-2">5. Prohibiciones</h3>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          <li>Crear cuentas falsas o múltiples</li>
          <li>Manipular datos GPS o hacer trampa</li>
          <li>Acosar a otros usuarios</li>
          <li>Intentar hackear el sistema</li>
        </ul>
      </section>

      <section>
        <h3 className="font-semibold mb-2">6. Propiedad Intelectual</h3>
        <p className="text-muted-foreground">
          El código, diseño, nombre y logo de Runna.io son propiedad de Javier Poves Ruiz.
        </p>
      </section>

      <section>
        <h3 className="font-semibold mb-2">7. Limitación de Responsabilidad</h3>
        <p className="text-muted-foreground">
          Runna.io se proporciona "tal cual". No garantizamos disponibilidad ininterrumpida ni somos responsables de decisiones tomadas basándose en los datos de la app.
        </p>
      </section>

      <section>
        <h3 className="font-semibold mb-2">8. Contacto</h3>
        <p className="text-muted-foreground">
          Email: runna.io.service@gmail.com
        </p>
      </section>
    </div>
  );
}

// Contenido de Política de Privacidad
function PrivacyContent() {
  return (
    <div className="space-y-6 text-sm pb-8">
      <p className="text-muted-foreground">
        <strong>Última actualización:</strong> 4 de febrero de 2026<br />
        <strong>Responsable:</strong> Javier Poves Ruiz
      </p>

      <section>
        <h3 className="font-semibold mb-2">1. ¿Qué Datos Recopilamos?</h3>
        <p className="text-muted-foreground mb-2"><strong>Datos que TÚ proporcionas:</strong></p>
        <ul className="list-disc list-inside text-muted-foreground space-y-1 mb-3">
          <li>Nombre completo y nombre de usuario</li>
          <li>Correo electrónico</li>
          <li>Contraseña (almacenada con hash SHA-256)</li>
        </ul>
        <p className="text-muted-foreground mb-2"><strong>Datos de actividad:</strong></p>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          <li>Rutas GPS de tus actividades</li>
          <li>Distancia, duración, ritmo</li>
          <li>Territorios conquistados</li>
        </ul>
      </section>

      <section>
        <h3 className="font-semibold mb-2">2. ¿Para Qué Usamos tus Datos?</h3>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          <li>Proporcionar el servicio de conquista de territorios</li>
          <li>Autenticarte y proteger tu cuenta</li>
          <li>Mostrarte estadísticas y rankings</li>
          <li>Enviarte notificaciones si las activas</li>
        </ul>
      </section>

      <section>
        <h3 className="font-semibold mb-2">3. Servicios de Terceros</h3>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          <li><strong>Polar Flow / Strava:</strong> Si conectas tu cuenta</li>
          <li><strong>Cloudflare:</strong> Hosting y seguridad</li>
          <li><strong>Turso:</strong> Base de datos</li>
          <li><strong>Mapbox:</strong> Mapas</li>
        </ul>
      </section>

      <section>
        <h3 className="font-semibold mb-2">4. Tus Derechos (RGPD)</h3>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          <li><strong>Acceso:</strong> Ver qué datos tenemos</li>
          <li><strong>Rectificación:</strong> Corregir datos incorrectos</li>
          <li><strong>Supresión:</strong> Eliminar tu cuenta y datos</li>
          <li><strong>Portabilidad:</strong> Exportar tus datos</li>
        </ul>
        <p className="text-muted-foreground mt-2">
          Contacto: runna.io.service@gmail.com
        </p>
      </section>

      <section>
        <h3 className="font-semibold mb-2">5. Seguridad</h3>
        <ul className="list-disc list-inside text-muted-foreground space-y-1">
          <li>HTTPS en todas las comunicaciones</li>
          <li>Contraseñas hasheadas con SHA-256 + salt</li>
          <li>Base de datos cifrada</li>
        </ul>
      </section>

      <section>
        <h3 className="font-semibold mb-2">6. Edad Mínima</h3>
        <p className="text-muted-foreground">
          Debes tener al menos <strong>14 años</strong> para usar Runna.io.
        </p>
      </section>
    </div>
  );
}

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { useMutation } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { LogIn, UserPlus, Sparkles, Eye, EyeOff } from 'lucide-react';
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
        description: 'La contraseña debe tener al menos 4 caracteres',
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
                  <a 
                    href="/terms" 
                    target="_blank" 
                    className="text-primary underline hover:no-underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Términos y Condiciones
                  </a>{' '}
                  y la{' '}
                  <a 
                    href="/privacy" 
                    target="_blank" 
                    className="text-primary underline hover:no-underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Política de Privacidad
                  </a>
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
    </Dialog>
  );
}

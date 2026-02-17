import { useState, useRef } from 'react';
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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { Save, User, Palette, Camera, Upload, RefreshCw } from 'lucide-react';
import type { UserWithStats } from '@shared/schema';
import { USER_COLORS } from '@/lib/colors';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserWithStats;
}

export function SettingsDialog({ open, onOpenChange, user }: SettingsDialogProps) {
  const [name, setName] = useState(user.name);
  const [selectedColor, setSelectedColor] = useState(user.color);
  const [avatar, setAvatar] = useState(user.avatar || '');
  const [previewUrl, setPreviewUrl] = useState(user.avatar || '');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const updateUserMutation = useMutation({
    mutationFn: async (data: { name: string; color: string; avatar: string }) => {
      return await apiRequest('PATCH', `/api/users/${user.id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/current-user'] });
      queryClient.invalidateQueries({ queryKey: ['/api/leaderboard'] });
      toast({
        title: '✅ Configuración guardada',
        description: 'Tus cambios se han guardado exitosamente',
        className: 'animate-bounce-in',
      });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo guardar la configuración',
        variant: 'destructive',
      });
    },
  });

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast({
        title: 'Error',
        description: 'Por favor selecciona una imagen válida',
        variant: 'destructive',
      });
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: 'Error',
        description: 'La imagen no puede superar los 5MB',
        variant: 'destructive',
      });
      return;
    }

    // Convert to base64
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      setAvatar(base64String);
      setPreviewUrl(base64String);
      toast({
        title: '✅ Imagen cargada',
        description: 'Haz clic en "Guardar cambios" para actualizar tu perfil',
      });
    };
    reader.readAsDataURL(file);
  };

  const handleSave = () => {
    if (!name.trim()) {
      toast({
        title: 'Error',
        description: 'El nombre no puede estar vacío',
        variant: 'destructive',
      });
      return;
    }

    updateUserMutation.mutate({ name, color: selectedColor, avatar });
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md animate-scale-in">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-2xl">
            <div className="relative">
              <User className="h-6 w-6 text-primary" />
              <div className="absolute inset-0 bg-primary/20 blur-md" />
            </div>
            Configuración
          </DialogTitle>
          <DialogDescription>
            Personaliza tu perfil y preferencias
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-6 py-4">
          {/* Avatar Selector */}
          <div className="space-y-3">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Camera className="h-4 w-4" />
              Foto de perfil
            </Label>
            <div className="flex items-center gap-4">
              <div className="relative group">
                <Avatar className="h-24 w-24 ring-2 ring-offset-2 transition-all duration-300 group-hover:scale-110"
                  style={{ '--tw-ring-color': selectedColor } as React.CSSProperties}
                >
                  <AvatarImage src={previewUrl || undefined} />
                  <AvatarFallback style={{ backgroundColor: selectedColor }}>
                    <span className="text-white text-2xl font-bold">
                      {getInitials(name)}
                    </span>
                  </AvatarFallback>
                </Avatar>
                <div 
                  className="absolute inset-0 rounded-full blur-lg opacity-0 group-hover:opacity-50 transition-opacity duration-300"
                  style={{ backgroundColor: selectedColor }}
                />
              </div>

              <div className="flex-1 space-y-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageSelect}
                  className="hidden"
                  data-testid="input-avatar"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="w-full hover:scale-105 active:scale-95 transition-all duration-300"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="button-upload-avatar"
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Subir foto
                </Button>
                {previewUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => {
                      setAvatar('');
                      setPreviewUrl('');
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                  >
                    Eliminar foto
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">
                  JPG, PNG o GIF (máx. 5MB)
                </p>
              </div>
            </div>
          </div>

          {/* Name Input */}
          <div className="space-y-2">
            <Label htmlFor="name" className="text-sm font-medium">
              Nombre
            </Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tu nombre"
              className="transition-all duration-300 focus:scale-[1.02]"
              data-testid="input-name"
            />
          </div>

          {/* Username (read-only) */}
          <div className="space-y-2">
            <Label htmlFor="username" className="text-sm font-medium">
              Nombre de usuario
            </Label>
            <Input
              id="username"
              value={user.username}
              disabled
              className="bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              El nombre de usuario no se puede cambiar
            </p>
          </div>

          {/* Color Picker */}
          <div className="space-y-3">
            <Label className="text-sm font-medium flex items-center gap-2">
              <Palette className="h-4 w-4" />
              Color de territorio
            </Label>
            <div className="grid grid-cols-5 gap-3">
              {USER_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setSelectedColor(color)}
                  className={`w-full aspect-square rounded-lg transition-all duration-300 hover:scale-110 active:scale-95 ${
                    selectedColor === color
                      ? 'ring-4 ring-primary ring-offset-2 scale-110'
                      : 'hover:ring-2 hover:ring-offset-2 hover:ring-primary/50'
                  }`}
                  style={{ backgroundColor: color }}
                  data-testid={`color-${color}`}
                >
                  {selectedColor === color && (
                    <div className="w-full h-full flex items-center justify-center">
                      <div className="w-3 h-3 bg-white rounded-full animate-scale-in" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Save Button */}
          <Button
            onClick={handleSave}
            disabled={updateUserMutation.isPending}
            className="w-full gradient-primary border-0 hover:scale-105 active:scale-95 transition-all duration-300"
            data-testid="button-save-settings"
          >
            <Save className="h-5 w-5 mr-2" />
            {updateUserMutation.isPending ? 'Guardando...' : 'Guardar cambios'}
          </Button>

          {/* Refresh App Button */}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              window.location.reload();
            }}
            className="w-full hover:scale-105 active:scale-95 transition-all duration-300"
            data-testid="button-refresh-app"
          >
            <RefreshCw className="h-5 w-5 mr-2" />
            Actualizar aplicacion
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

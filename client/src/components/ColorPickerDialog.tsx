import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Palette, Check, Lock, Save, Loader2 } from 'lucide-react';
import { USER_COLORS, USER_COLOR_NAMES } from '@/lib/colors';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';

interface ColorPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentColor: string;
  userId: string;
}

export function ColorPickerDialog({ open, onOpenChange, currentColor, userId }: ColorPickerDialogProps) {
  const [selectedColor, setSelectedColor] = useState(currentColor);
  const { toast } = useToast();

  // Fetch friends to get their colors
  const { data: friends = [] } = useQuery<any[]>({
    queryKey: ['/api/friends', userId],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/friends/${userId}`);
      if (!res.ok) return [];
      return await res.json();
    },
    enabled: !!userId && open,
  });

  // Get set of colors used by friends (normalized to uppercase)
  const friendColors = new Set(
    (friends as any[]).map((f: any) => f.color?.toUpperCase()).filter(Boolean)
  );

  useEffect(() => {
    if (open) {
      setSelectedColor(currentColor);
    }
  }, [open, currentColor]);

  const updateColorMutation = useMutation({
    mutationFn: async (color: string) => {
      return await apiRequest('PATCH', `/api/users/${userId}`, { color });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/current-user'] });
      queryClient.invalidateQueries({ queryKey: ['/api/user', userId] });
      queryClient.invalidateQueries({ queryKey: ['/api/leaderboard'] });
      queryClient.invalidateQueries({ queryKey: ['/api/territories'] });
      toast({
        title: '✅ Color actualizado',
        description: `Tu color de territorio ahora es ${USER_COLOR_NAMES[selectedColor] || 'Personalizado'}`,
        className: 'animate-bounce-in',
      });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo cambiar el color',
        variant: 'destructive',
      });
    },
  });

  const handleSave = () => {
    if (selectedColor === currentColor) {
      onOpenChange(false);
      return;
    }
    updateColorMutation.mutate(selectedColor);
  };

  const isColorTakenByFriend = (color: string) => {
    return friendColors.has(color.toUpperCase());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm animate-scale-in">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <div className="relative">
              <Palette className="h-5 w-5 text-primary" />
              <div className="absolute inset-0 bg-primary/20 blur-md" />
            </div>
            Color de territorio
          </DialogTitle>
          <DialogDescription>
            Elige tu color. Los colores de tus amigos no están disponibles.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-3">
          {/* Preview */}
          <div className="flex items-center justify-center gap-4">
            <div className="relative">
              <div
                className="w-16 h-16 rounded-2xl shadow-lg ring-2 ring-offset-2 ring-primary/50 transition-all duration-300"
                style={{ backgroundColor: selectedColor }}
              />
              <div
                className="absolute inset-0 rounded-2xl blur-lg opacity-40 transition-all duration-300"
                style={{ backgroundColor: selectedColor }}
              />
            </div>
            <div>
              <p className="text-lg font-bold">{USER_COLOR_NAMES[selectedColor] || 'Personalizado'}</p>
              <p className="text-xs text-muted-foreground">{selectedColor}</p>
            </div>
          </div>

          {/* Color grid */}
          <div className="grid grid-cols-4 gap-3">
            {USER_COLORS.map((color) => {
              const isTaken = isColorTakenByFriend(color);
              const isSelected = selectedColor.toUpperCase() === color.toUpperCase();
              const isCurrent = currentColor.toUpperCase() === color.toUpperCase();

              return (
                <button
                  key={color}
                  onClick={() => !isTaken && setSelectedColor(color)}
                  disabled={isTaken}
                  className={`relative w-full aspect-square rounded-xl transition-all duration-300 ${
                    isTaken
                      ? 'opacity-30 cursor-not-allowed grayscale'
                      : isSelected
                        ? 'ring-[3px] ring-primary ring-offset-2 scale-110 shadow-lg'
                        : 'hover:scale-105 hover:ring-2 hover:ring-offset-1 hover:ring-primary/40 active:scale-95'
                  }`}
                  style={{ backgroundColor: color }}
                  title={isTaken ? `Usado por un amigo` : (USER_COLOR_NAMES[color] || color)}
                >
                  {isSelected && !isTaken && (
                    <div className="absolute inset-0 flex items-center justify-center animate-in zoom-in-50 duration-200">
                      <Check className="h-5 w-5 text-white drop-shadow-md" />
                    </div>
                  )}
                  {isTaken && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Lock className="h-4 w-4 text-white/80 drop-shadow-md" />
                    </div>
                  )}
                  {isCurrent && !isSelected && !isTaken && (
                    <div className="absolute -top-1 -right-1 w-3 h-3 bg-primary rounded-full ring-2 ring-background" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 text-xs text-muted-foreground justify-center">
            <div className="flex items-center gap-1.5">
              <Lock className="h-3 w-3" />
              <span>Usado por amigo</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 bg-primary rounded-full" />
              <span>Tu color actual</span>
            </div>
          </div>

          {/* Save button */}
          <Button
            onClick={handleSave}
            disabled={updateColorMutation.isPending}
            className="w-full gradient-primary border-0 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200"
          >
            {updateColorMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            {updateColorMutation.isPending ? 'Guardando...' : selectedColor === currentColor ? 'Cerrar' : 'Guardar color'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

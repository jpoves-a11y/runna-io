import { useState, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Camera, Loader2, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient, API_BASE } from '@/lib/queryClient';

interface AvatarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentAvatar?: string | null;
  userName: string;
  userColor: string;
  userId: string;
}

export function AvatarDialog({ 
  open, 
  onOpenChange, 
  currentAvatar, 
  userName,
  userColor,
  userId 
}: AvatarDialogProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoadError, setPreviewLoadError] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('avatar', file);
      formData.append('userId', userId);

      let response: Response;
      try {
        const fullUrl = `${API_BASE}/api/user/avatar`;
        response = await fetch(fullUrl, {
          method: 'POST',
          body: formData,
          credentials: 'include',
        });
      } catch (netErr: any) {
        console.error('Network error uploading avatar', netErr);
        throw new Error(netErr?.message || 'Network error during avatar upload');
      }

      // Read body once to avoid "body is disturbed or locked" errors
      let bodyText: string = '';
      try {
        bodyText = await response.text();
      } catch (readErr: any) {
        console.error('Failed reading response body', readErr, { status: response.status, type: response.type });
        throw new Error(readErr?.message || `Failed reading response body: ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!response.ok) {
        const detail = `status=${response.status} content-type=${contentType} body=${bodyText}`;
        console.error('Upload failed', detail);
        // Try parse JSON message
        try {
          const parsed = JSON.parse(bodyText);
          const msg = parsed?.message || JSON.stringify(parsed);
          throw new Error(`${msg} (${detail})`);
        } catch {
          throw new Error(`${bodyText || 'Upload failed'} (${detail})`);
        }
      }

      try {
        return contentType.includes('application/json') ? JSON.parse(bodyText) : { success: true, avatar: bodyText } as any;
      } catch (e) {
        console.warn('Response not JSON for avatar upload:', bodyText);
        return { success: true, avatar: bodyText } as any;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/user', userId] });
      toast({
        title: '✅ Avatar actualizado',
        description: 'Tu foto de perfil ha sido actualizada',
      });
      setPreviewUrl(null);
      setSelectedFile(null);
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('DELETE', '/api/user/avatar', { userId });
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/user', userId] });
      toast({
        title: 'Avatar eliminado',
        description: 'Se ha eliminado tu foto de perfil',
      });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    // Prefer an image file and ignore mov/video parts of Live Photo
    const imageFile = files.find(f => f.type.startsWith('image/')) || files[0];
    if (!imageFile) return;

    // If it's a MOV or video, reject and ask user to pick the photo instead
    if (imageFile.type.startsWith('video/')) {
      toast({ title: 'Error', description: 'Selecciona la imagen, no el video', variant: 'destructive' });
      return;
    }

    // Validate file size (max 5MB)
    if (imageFile.size > 5 * 1024 * 1024) {
      toast({ title: 'Error', description: 'La imagen no puede superar los 5MB', variant: 'destructive' });
      return;
    }

    // If file is HEIC/HEIF (iOS Live Photo image), try converting to JPEG via canvas
    const isHeic = /\.(heic|heif)$/i.test(imageFile.name) || imageFile.type.includes('heic') || imageFile.type.includes('heif');

    const convertToJpeg = async (file: File) => {
      try {
        const bitmap = await (typeof createImageBitmap === 'function'
          ? createImageBitmap(file)
          : new Promise<ImageBitmap>((res, rej) => {
              const img = new Image();
              img.onload = () => {
                try {
                  const canvas = document.createElement('canvas');
                  canvas.width = img.naturalWidth;
                  canvas.height = img.naturalHeight;
                  const ctx = canvas.getContext('2d')!;
                  ctx.drawImage(img, 0, 0);
                  createImageBitmap(canvas).then(res).catch(rej);
                } catch (err) {
                  rej(err);
                }
              };
              img.onerror = rej;
              img.src = URL.createObjectURL(file);
            })
        );

        // Resize to reasonable max dimension to reduce size
        const maxDim = 1024;
        const width = bitmap.width;
        const height = bitmap.height;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d')!;

        // Draw centered crop if needed (preserve aspect, let CSS object-cover handle circle)
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

        const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
        if (!blob) throw new Error('No se pudo convertir la imagen');
        const jpegFile = new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
        return jpegFile;
      } catch (err) {
        console.warn('HEIC -> JPEG conversion failed', err);
        return file; // fallback to original
      }
    };

    (async () => {
      let processedFile: File = imageFile;
      if (isHeic) {
        processedFile = await convertToJpeg(imageFile);
      }

      setSelectedFile(processedFile);
      const previewUrlLocal = URL.createObjectURL(processedFile);
      setPreviewLoadError(false);
      setPreviewUrl(previewUrlLocal);
    })();
  };

  const handleUpload = () => {
    if (selectedFile) {
      // ensure we send a File (could be Blob wrapped as File)
      uploadMutation.mutate(selectedFile);
    }
  };

  const handleCancel = () => {
    setPreviewUrl(null);
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Revoke object URL when dialog closes or preview changes
  const cleanupPreview = () => {
    if (previewUrl) {
      try { URL.revokeObjectURL(previewUrl); } catch {};
    }
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Foto de perfil</DialogTitle>
          <DialogDescription>
            Cambia tu foto de perfil o elimínala
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-6 py-4">
          <div className="relative">
            <Avatar className="h-40 w-40 ring-4 ring-offset-4"
              style={{ '--tw-ring-color': userColor } as React.CSSProperties}
            >
              <AvatarImage 
                src={previewUrl || currentAvatar || undefined} 
                className="object-cover"
                onError={() => {
                  setPreviewLoadError(true);
                  // if preview URL failed, revoke it
                  if (previewUrl) {
                    try { URL.revokeObjectURL(previewUrl); } catch {};
                  }
                }}
              />
              <AvatarFallback style={{ backgroundColor: userColor }}>
                <span className="text-white text-5xl font-bold">
                  {getInitials(userName)}
                </span>
              </AvatarFallback>
            </Avatar>
          </div>

          {previewUrl && !previewLoadError ? (
            <div className="flex gap-2 w-full">
              <Button
                onClick={handleCancel}
                variant="outline"
                className="flex-1"
                disabled={uploadMutation.isPending}
              >
                <X className="h-4 w-4 mr-2" />
                Cancelar
              </Button>
              <Button
                onClick={handleUpload}
                className="flex-1 gradient-primary"
                disabled={uploadMutation.isPending}
              >
                {uploadMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Camera className="h-4 w-4 mr-2" />
                )}
                Guardar
              </Button>
            </div>
          ) : (
            <>
                <input
                ref={fileInputRef}
                type="file"
                  accept="image/*,.heic,.heif"
                onChange={handleFileChange}
                className="hidden"
              />
              
              <div className="flex flex-col gap-2 w-full">
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full gradient-primary"
                >
                  <Camera className="h-4 w-4 mr-2" />
                  Cambiar foto
                </Button>
                
                {currentAvatar && (
                  <Button
                    onClick={() => deleteMutation.mutate()}
                    variant="outline"
                    className="w-full"
                    disabled={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <X className="h-4 w-4 mr-2" />
                    )}
                    Eliminar foto
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

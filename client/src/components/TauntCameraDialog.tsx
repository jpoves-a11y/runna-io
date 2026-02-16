import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Camera, Send, RotateCcw, X, Swords } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';

interface TauntCameraDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  senderId: string;
  victims: string[]; // array of victim user IDs
  areaStolen: number; // m²
}

async function compressImage(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      const MAX = 640; // 640px max for mobile — keeps base64 under ~100KB
      let w = img.width;
      let h = img.height;
      if (w > h) { if (w > MAX) { h = (h * MAX) / w; w = MAX; } }
      else { if (h > MAX) { w = (w * MAX) / h; h = MAX; } }
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
      resolve(dataUrl);
    };
    img.onerror = reject;
    img.src = url;
  });
}

export function TauntCameraDialog({ open, onOpenChange, senderId, victims, areaStolen }: TauntCameraDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const { toast } = useToast();

  const startCamera = useCallback(async (facing: 'user' | 'environment' = facingMode) => {
    try {
      setCameraError(false);
      setCameraReady(false);

      // Stop any existing stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setCameraReady(true);
      }
    } catch (err) {
      console.error('Camera error:', err);
      setCameraError(true);
    }
  }, [facingMode]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setCameraReady(false);
  }, []);

  useEffect(() => {
    if (open && !photo) {
      startCamera();
    }
    return () => { if (!open) stopCamera(); };
  }, [open, photo, startCamera, stopCamera]);

  useEffect(() => {
    if (!open) {
      setPhoto(null);
      setCameraError(false);
      stopCamera();
    }
  }, [open, stopCamera]);

  const takePhoto = () => {
    if (!videoRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext('2d')!;

    // Mirror if front camera
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(videoRef.current, 0, 0);

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const compressed = await compressImage(blob);
      setPhoto(compressed);
      stopCamera();
    }, 'image/jpeg', 0.5); // Lower quality for initial capture on mobile
  };

  const retake = () => {
    setPhoto(null);
    startCamera();
  };

  const switchCamera = () => {
    const next = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(next);
    startCamera(next);
  };

  const sendPhoto = async () => {
    if (!photo || victims.length === 0) return;
    setIsSending(true);

    try {
      // Send to each victim
      for (const victimId of victims) {
        await apiRequest('POST', '/api/ephemeral-photos', {
          senderId,
          recipientId: victimId,
          photoData: photo,
          areaStolen,
        });
      }

      toast({
        title: '📸 ¡Foto enviada!',
        description: `Foto de conquista enviada a ${victims.length} rival${victims.length > 1 ? 'es' : ''}`,
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: 'Error',
        description: 'No se pudo enviar la foto',
        variant: 'destructive',
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[calc(100%-1rem)] max-w-sm mx-auto gap-0 overflow-hidden rounded-2xl border-0 shadow-2xl [&>button]:text-white [&>button]:hover:text-white/80 [&>button]:z-10"
        style={{ padding: 0 }}
      >
        {/* Header */}
        <div className="relative bg-gradient-to-br from-red-500 via-orange-500 to-amber-500 px-4 py-3 text-white">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_70%)]" />
          <DialogHeader className="space-y-0.5 relative">
            <DialogTitle className="flex items-center gap-2 text-base font-bold text-white">
              <div className="bg-white/20 backdrop-blur-sm rounded-lg p-1.5">
                <Swords className="h-4 w-4" />
              </div>
              Enviar foto de conquista
            </DialogTitle>
            <DialogDescription className="text-xs text-white/80">
              Tu rival verá la foto una sola vez
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="relative bg-black" style={{ minHeight: photo ? 'auto' : '350px' }}>
          {/* Camera view */}
          {!photo && (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-[350px] object-cover"
                style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : 'none' }}
              />

              {cameraError && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-white text-center p-4">
                  <div>
                    <Camera className="h-10 w-10 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No se pudo acceder a la cámara</p>
                    <p className="text-xs text-white/60 mt-1">Permite el acceso a la cámara en tu navegador</p>
                  </div>
                </div>
              )}

              {/* Camera controls */}
              {cameraReady && (
                <div className="absolute bottom-4 inset-x-0 flex items-center justify-center gap-6">
                  <button
                    onClick={switchCamera}
                    className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center text-white active:scale-90 transition-transform"
                  >
                    <RotateCcw className="h-5 w-5" />
                  </button>

                  <button
                    onClick={takePhoto}
                    className="w-16 h-16 rounded-full bg-white border-4 border-white/50 shadow-lg active:scale-90 transition-transform"
                  />

                  <div className="w-10 h-10" /> {/* spacer */}
                </div>
              )}
            </>
          )}

          {/* Photo preview */}
          {photo && (
            <img
              src={photo}
              alt="Preview"
              className="w-full h-[350px] object-cover"
            />
          )}
        </div>

        {/* Actions */}
        <div className="p-3 space-y-2" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
          {photo ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1 h-11 font-semibold"
                onClick={retake}
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Repetir
              </Button>
              <Button
                className="flex-1 h-11 font-semibold gradient-primary border-0 active:scale-[0.98] transition-transform"
                onClick={sendPhoto}
                disabled={isSending}
              >
                {isSending ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                Enviar
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              className="w-full h-10 text-sm text-muted-foreground"
              onClick={() => onOpenChange(false)}
            >
              Omitir
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

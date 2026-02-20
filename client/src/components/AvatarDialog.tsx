import { useState, useRef, useEffect } from 'react';
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
  // Crop UI state
  const cropImgRef = useRef<HTMLImageElement | null>(null);
  const [cropScale, setCropScale] = useState(1);
  const [baseFitScale, setBaseFitScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0, origX: 0, origY: 0 });
  const lastTouchDistRef = useRef<number | null>(null);
  const cropViewportPx = 300; // on-screen viewport size (square)

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('avatar', file);
      formData.append('userId', userId);

      const fullUrl = `${API_BASE}/api/user/avatar`;
      let attempts = 0;
      let lastError: any = null;
      while (attempts < 2) {
        attempts += 1;
        try {
          const response = await fetch(fullUrl, {
            method: 'POST',
            body: formData,
            credentials: 'include',
          });

          const bodyText = await response.text().catch(() => '');
          const contentType = response.headers.get('content-type') || '';
          if (!response.ok) {
            const detail = `status=${response.status} content-type=${contentType} body=${bodyText}`;
            // If service returned 503, retry once after short delay
            if (response.status === 503 && attempts < 2) {
              await new Promise(r => setTimeout(r, 500));
              continue;
            }
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
            return { success: true, avatar: bodyText } as any;
          }
        } catch (err: any) {
          lastError = err;
          // network error: retry once
          if (attempts < 2) await new Promise(r => setTimeout(r, 500));
        }
      }
      throw lastError || new Error('Upload failed');
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
      // reset crop UI state so user starts centered and at fit scale
      setTimeout(() => {
        setCropScale(1);
        setBaseFitScale(1);
        setPos({ x: 0, y: 0 });
      }, 0);
    })();
  };

  const handleUpload = () => {
    if (!selectedFile || !previewUrl) return;
    // Export cropped PNG 512x512 and send as File
    (async () => {
      try {
        const croppedFile = await exportCroppedFile();
        setSelectedFile(croppedFile);
        uploadMutation.mutate(croppedFile);
      } catch (err: any) {
        toast({ title: 'Error', description: err?.message || 'Fallo al recortar la imagen', variant: 'destructive' });
      }
    })();
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

  // When previewUrl changes, load image into crop image ref to compute fit scale
  useEffect(() => {
    if (!previewUrl) return;
    const img = new Image();
    img.onload = () => {
      // compute base fit so the image covers the viewport (cover)
      const fit = Math.max(cropViewportPx / img.naturalWidth, cropViewportPx / img.naturalHeight);
      setBaseFitScale(fit);
      setCropScale(1);
      // center image so it fills viewport
      const displayedW = img.naturalWidth * fit;
      const displayedH = img.naturalHeight * fit;
      setPos({ x: (cropViewportPx - displayedW) / 2, y: (cropViewportPx - displayedH) / 2 });
      cropImgRef.current = img;
    };
    img.onerror = () => {
      setPreviewLoadError(true);
    };
    img.src = previewUrl;
    return () => {
      // don't revoke previewUrl here; handled elsewhere
    };
  }, [previewUrl]);

  // Helper: distance between two touch points
  const touchDistance = (a: Touch, b: Touch) => {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.hypot(dx, dy);
  };

  // Handlers for pointer interactions on crop area
  const onPointerDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    draggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY, origX: pos.x, origY: pos.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setPos({ x: dragStartRef.current.origX + dx, y: dragStartRef.current.origY + dy });
  };
  const onPointerUp = (_e: React.PointerEvent) => {
    draggingRef.current = false;
  };

  // Touch handlers for pinch zoom and drag
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      draggingRef.current = true;
      dragStartRef.current = { x: t.clientX, y: t.clientY, origX: pos.x, origY: pos.y };
    } else if (e.touches.length === 2) {
      lastTouchDistRef.current = touchDistance(e.touches[0], e.touches[1]);
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && draggingRef.current) {
      const t = e.touches[0];
      const dx = t.clientX - dragStartRef.current.x;
      const dy = t.clientY - dragStartRef.current.y;
      setPos({ x: dragStartRef.current.origX + dx, y: dragStartRef.current.origY + dy });
    } else if (e.touches.length === 2) {
      const dist = touchDistance(e.touches[0], e.touches[1]);
      const last = lastTouchDistRef.current ?? dist;
      const delta = dist - last;
      if (Math.abs(delta) > 2) {
        const newScale = Math.max(0.5, Math.min(4, cropScale * (1 + delta / 200)));
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
        const s = baseFitScale * cropScale;
        const s2 = baseFitScale * newScale;
        setPos((p) => {
          const nx = p.x + (1 - s2 / s) * (midX - p.x);
          const ny = p.y + (1 - s2 / s) * (midY - p.y);
          return { x: nx, y: ny };
        });
        setCropScale(newScale);
      }
      lastTouchDistRef.current = dist;
    }
    e.preventDefault?.();
  };
  const onTouchEnd = (_e: React.TouchEvent) => {
    draggingRef.current = false;
    lastTouchDistRef.current = null;
  };

  // Export canvas based on current crop state -> PNG blob -> File
  const exportCroppedFile = async (): Promise<File> => {
    if (!cropImgRef.current) throw new Error('Imagen no cargada');
    const img = cropImgRef.current;
    const naturalW = img.naturalWidth;
    const naturalH = img.naturalHeight;
    const s = baseFitScale * cropScale;
    const displayedW = naturalW * s;
    const displayedH = naturalH * s;
    const srcX = Math.max(0, (-pos.x) / s);
    const srcY = Math.max(0, (-pos.y) / s);
    const srcW = Math.min(naturalW - srcX, cropViewportPx / s);
    const srcH = Math.min(naturalH - srcY, cropViewportPx / s);
    const outSize = 512;
    const canvas = document.createElement('canvas');
    canvas.width = outSize;
    canvas.height = outSize;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, outSize, outSize);
    ctx.beginPath();
    ctx.arc(outSize / 2, outSize / 2, outSize / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, outSize, outSize);
    const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('No se pudo generar la imagen');
    const file = new File([blob], 'avatar.png', { type: 'image/png' });
    return file;
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
              {previewUrl && !previewLoadError ? (
                // Nuevo cropper: canvas con máscara circular y controles táctiles
                <div
                  className="w-[300px] h-[300px] relative touch-none"
                  style={{ borderRadius: '50%', overflow: 'visible' }}
                >
                  <CropperCanvas
                    imageUrl={previewUrl}
                    pos={pos}
                    setPos={setPos}
                    cropScale={cropScale}
                    setCropScale={setCropScale}
                    baseFitScale={baseFitScale}
                    cropImgRef={cropImgRef}
                    cropViewportPx={cropViewportPx}
                  />
                </div>
              ) : (
                <AvatarImage 
                  src={currentAvatar || undefined} 
                  className="object-cover"
                />
              )}
              <AvatarFallback style={{ backgroundColor: userColor }}>
                <span className="text-white text-5xl font-bold">
                  {getInitials(userName)}
                </span>
              </AvatarFallback>
            </Avatar>
          </div>
// --- CropperCanvas: canvas con máscara circular, pinch/pan/zoom ---
import React, { useRef, useEffect } from 'react';

type CropperCanvasProps = {
  imageUrl: string;
  pos: { x: number; y: number };
  setPos: (p: { x: number; y: number }) => void;
  cropScale: number;
  setCropScale: (s: number) => void;
  baseFitScale: number;
  cropImgRef: React.MutableRefObject<HTMLImageElement | null>;
  cropViewportPx: number;
};

export function CropperCanvas({ imageUrl, pos, setPos, cropScale, setCropScale, baseFitScale, cropImgRef, cropViewportPx }: CropperCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0, origX: 0, origY: 0 });
  const lastTouchDist = useRef<number | null>(null);

  // Redibuja el canvas con la imagen y la máscara circular
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = cropImgRef.current;
    if (!img) return;
    // Limpia
    ctx.clearRect(0, 0, cropViewportPx, cropViewportPx);
    // Dibuja imagen
    const s = baseFitScale * cropScale;
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    ctx.save();
    ctx.drawImage(img, pos.x, pos.y, w, h);
    ctx.restore();
    // Máscara circular: oscurece fuera del círculo
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.beginPath();
    ctx.arc(cropViewportPx / 2, cropViewportPx / 2, cropViewportPx / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // Sombra exterior
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(cropViewportPx / 2, cropViewportPx / 2, cropViewportPx / 2, 0, Math.PI * 2);
    ctx.rect(0, 0, cropViewportPx, cropViewportPx);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();
    // Borde blanco
    ctx.save();
    ctx.beginPath();
    ctx.arc(cropViewportPx / 2, cropViewportPx / 2, cropViewportPx / 2 - 2, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'white';
    ctx.stroke();
    ctx.restore();
  }, [imageUrl, pos, cropScale, baseFitScale, cropImgRef.current]);

  // Carga la imagen si no está cargada
  useEffect(() => {
    if (cropImgRef.current) return;
    const img = new window.Image();
    img.onload = () => {
      cropImgRef.current = img;
    };
    img.src = imageUrl;
  }, [imageUrl, cropImgRef]);

  // Pointer/touch handlers para pan/zoom
  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, origX: pos.x, origY: pos.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPos({ x: dragStart.current.origX + dx, y: dragStart.current.origY + dy });
  };
  const onPointerUp = () => { dragging.current = false; };

  // Pinch zoom táctil
  const touchDistance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      dragging.current = true;
      dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, origX: pos.x, origY: pos.y };
    } else if (e.touches.length === 2) {
      lastTouchDist.current = touchDistance(e.touches[0], e.touches[1]);
    }
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 1 && dragging.current) {
      const dx = e.touches[0].clientX - dragStart.current.x;
      const dy = e.touches[0].clientY - dragStart.current.y;
      setPos({ x: dragStart.current.origX + dx, y: dragStart.current.origY + dy });
    } else if (e.touches.length === 2) {
      const dist = touchDistance(e.touches[0], e.touches[1]);
      const last = lastTouchDist.current ?? dist;
      const delta = dist - last;
      if (Math.abs(delta) > 2) {
        const newScale = Math.max(0.5, Math.min(4, cropScale * (1 + delta / 200)));
        setCropScale(newScale);
      }
      lastTouchDist.current = dist;
    }
    e.preventDefault?.();
  };
  const onTouchEnd = () => {
    dragging.current = false;
    lastTouchDist.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      width={cropViewportPx}
      height={cropViewportPx}
      style={{ width: cropViewportPx, height: cropViewportPx, borderRadius: '50%', touchAction: 'none', background: '#222' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    />
  );
}

          {previewUrl && !previewLoadError ? (
            <div className="flex flex-col gap-2 w-full">
              <div className="flex items-center gap-2">
                <label className="text-[12px] text-muted-foreground">Zoom</label>
                <input
                  type="range"
                  min={0.5}
                  max={4}
                  step={0.01}
                  value={cropScale}
                  onChange={(e) => {
                    const newScale = Number(e.target.value);
                    // keep center stable when zooming
                    const rect = (e.target as HTMLInputElement).closest('.sm:max-w-md')?.getBoundingClientRect();
                    setCropScale(newScale);
                  }}
                  className="flex-1"
                />
                <Button variant="outline" onClick={() => { setCropScale(1); setPos({ x: 0, y: 0 }); }} className="ml-2">Reset</Button>
              </div>
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

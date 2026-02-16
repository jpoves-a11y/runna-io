import { useState, useEffect, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { Swords, X } from 'lucide-react';
import { apiRequest, API_BASE } from '@/lib/queryClient';

interface PendingPhoto {
  id: string;
  senderId: string;
  senderName: string;
  senderUsername: string;
  senderAvatar: string | null;
  message: string | null;
  areaStolen: number | null;
  createdAt: string;
}

interface EphemeralPhotoViewerProps {
  userId: string;
}

export function EphemeralPhotoViewer({ userId }: EphemeralPhotoViewerProps) {
  const [pendingPhotos, setPendingPhotos] = useState<PendingPhoto[]>([]);
  const [currentPhoto, setCurrentPhoto] = useState<PendingPhoto | null>(null);
  const [photoData, setPhotoData] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hasCheckedOnLoad, setHasCheckedOnLoad] = useState(false);

  const openPhoto = useCallback(async (photo: PendingPhoto) => {
    setCurrentPhoto(photo);
    setIsOpen(true);
    setIsLoading(true);

    try {
      const res = await apiRequest('GET', `/api/ephemeral-photos/${photo.id}/view?userId=${userId}`);
      const data = await res.json();
      setPhotoData(data.photoData);
    } catch (err) {
      console.error('Error viewing photo:', err);
      setIsOpen(false);
      setCurrentPhoto(null);
      setPendingPhotos(prev => prev.filter(p => p.id !== photo.id));
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  // Check for pending photos on load and periodically
  useEffect(() => {
    if (!userId) return;

    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/ephemeral-photos/pending/${userId}`);
        if (res.ok) {
          const photos: PendingPhoto[] = await res.json();
          if (photos.length > 0) {
            setPendingPhotos(photos);
            // Auto-open with the first photo on initial load
            if (!hasCheckedOnLoad) {
              setHasCheckedOnLoad(true);
              openPhoto(photos[0]);
            }
          } else {
            setHasCheckedOnLoad(true);
          }
        }
      } catch (_) {
        setHasCheckedOnLoad(true);
      }
    };

    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, [userId, hasCheckedOnLoad, openPhoto]);

  // When new pending photos arrive via polling and we're not viewing one, auto-open
  useEffect(() => {
    if (pendingPhotos.length > 0 && !isOpen && !currentPhoto && hasCheckedOnLoad) {
      openPhoto(pendingPhotos[0]);
    }
  }, [pendingPhotos, isOpen, currentPhoto, hasCheckedOnLoad, openPhoto]);

  const closeViewer = useCallback(() => {
    const closedPhotoId = currentPhoto?.id;
    setIsOpen(false);
    setPhotoData(null);
    setCurrentPhoto(null);

    // Remove viewed photo from pending list
    setPendingPhotos(prev => {
      const remaining = prev.filter(p => p.id !== closedPhotoId);
      // If there are more photos, open the next one after a short delay
      if (remaining.length > 0) {
        setTimeout(() => {
          openPhoto(remaining[0]);
        }, 400);
      }
      return remaining;
    });
  }, [currentPhoto, openPhoto]);

  if (!isOpen) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) closeViewer(); }}>
      <DialogContent
        className="w-full h-full max-w-none max-h-none rounded-none border-0 bg-black p-0 [&>button]:hidden"
        style={{ margin: 0 }}
      >
        {isLoading && (
          <div className="flex-1 flex items-center justify-center h-full">
            <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {photoData && currentPhoto && (
          <div className="relative w-full h-full flex flex-col">
            {/* Header overlay */}
            <div
              className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/80 to-transparent p-4"
              style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1rem)' }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center overflow-hidden">
                    {currentPhoto.senderAvatar ? (
                      <img src={currentPhoto.senderAvatar} alt="" className="w-10 h-10 rounded-full object-cover" />
                    ) : (
                      <span className="text-white text-base font-bold">
                        {currentPhoto.senderName[0]?.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div>
                    <p className="text-white text-sm font-semibold">{currentPhoto.senderName}</p>
                    <p className="text-white/60 text-xs">@{currentPhoto.senderUsername}</p>
                  </div>
                </div>
                <button
                  onClick={closeViewer}
                  className="w-9 h-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center active:scale-90 transition-transform"
                >
                  <X className="h-5 w-5 text-white" />
                </button>
              </div>
            </div>

            {/* Photo */}
            <img
              src={photoData}
              alt="Foto de conquista"
              className="w-full h-full object-contain"
            />

            {/* Bottom overlay with conquest stats */}
            <div
              className="absolute bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-black/80 via-black/50 to-transparent p-5"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 1.5rem)' }}
            >
              {/* Conquest stats card */}
              <div className="bg-white/10 backdrop-blur-md rounded-2xl p-4 border border-white/10">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center">
                    <Swords className="h-5 w-5 text-red-400" />
                  </div>
                  <div>
                    <p className="text-white text-sm font-bold">¡Te han robado territorio!</p>
                    <p className="text-white/60 text-xs">{currentPhoto.senderName} te ha conquistado</p>
                  </div>
                </div>
                
                {currentPhoto.areaStolen && currentPhoto.areaStolen > 0 && (
                  <div className="flex items-center justify-center mt-2 py-2.5 bg-red-500/20 rounded-xl">
                    <span className="text-red-300 text-2xl font-bold">
                      -{(currentPhoto.areaStolen / 1000000).toFixed(2)} km²
                    </span>
                  </div>
                )}

                {currentPhoto.message && (
                  <p className="text-white/70 text-sm text-center mt-2 italic">
                    "{currentPhoto.message}"
                  </p>
                )}
              </div>

              <p className="text-white/40 text-xs text-center mt-3">
                Toca la ✕ para cerrar · La foto se eliminará
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

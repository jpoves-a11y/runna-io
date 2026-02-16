import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Activity, Calendar, ChevronRight, ChevronLeft, MapPin, Swords, Shield, Users, UserPlus, Loader2, X } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import UserActivitiesDialog from './UserActivitiesDialog';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Props {
  userId?: string | null;
  currentUserId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function UserInfoDialog({ userId, currentUserId, open, onOpenChange }: Props) {
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const [addingFriend, setAddingFriend] = useState(false);
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null);
  const [showFullAvatar, setShowFullAvatar] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Determine which user to display (either the original or the selected friend)
  const displayUserId = selectedFriendId || userId;

  const { data, refetch } = useQuery({
    queryKey: ['user-stats', displayUserId, currentUserId],
    queryFn: async () => {
      if (!displayUserId) throw new Error('No userId');
      const params = currentUserId ? `?viewerId=${currentUserId}` : '';
      const res = await apiRequest('GET', `/api/users/${displayUserId}/stats${params}`);
      if (!res.ok) throw new Error('Failed to fetch stats');
      return await res.json();
    },
    enabled: !!displayUserId && open,
    staleTime: 1000 * 60,
  });

  const { data: friends = [], isLoading: friendsLoading } = useQuery({
    queryKey: ['user-friends', displayUserId],
    queryFn: async () => {
      if (!displayUserId) throw new Error('No userId');
      const res = await apiRequest('GET', `/api/friends/${displayUserId}`);
      if (!res.ok) throw new Error('Failed to fetch friends');
      return await res.json();
    },
    enabled: !!displayUserId && open,
    staleTime: 1000 * 60,
  });

  // Check if already friends (only show add button if not selected friend and not already friends)
  const isAlreadyFriend = (friends as any[]).some((friend) => friend.id === currentUserId);

  const handleAddFriend = async () => {
    if (!currentUserId || !displayUserId) return;
    
    setAddingFriend(true);
    try {
      const res = await apiRequest('POST', '/api/friends', {
        userId: currentUserId,
        friendId: displayUserId,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to send friend request');
      }
      alert('Solicitud de amistad enviada');
      // Invalidate friends list cache to refresh
      queryClient.invalidateQueries({ queryKey: ['user-friends', displayUserId] });
    } catch (error: any) {
      alert(error.message || 'Error sending friend request');
      console.error('Error adding friend:', error);
    } finally {
      setAddingFriend(false);
    }
  };

  // Reset full avatar when switching users
  useEffect(() => {
    setShowFullAvatar(false);
  }, [displayUserId]);

  // Block ALL events from reaching Radix when full avatar overlay is shown
  useEffect(() => {
    if (!showFullAvatar) return;
    const blocker = (e: Event) => {
      // Only block if our overlay is in the DOM
      const overlay = overlayRef.current;
      if (!overlay) return;
      // Block the event so Radix never sees it
      e.stopImmediatePropagation();
    };
    // Add at capture phase to fire before Radix's listeners
    document.addEventListener('pointerdown', blocker, true);
    document.addEventListener('mousedown', blocker, true);
    document.addEventListener('touchstart', blocker, true);
    return () => {
      document.removeEventListener('pointerdown', blocker, true);
      document.removeEventListener('mousedown', blocker, true);
      document.removeEventListener('touchstart', blocker, true);
    };
  }, [showFullAvatar]);

  useEffect(() => {
    if (open && userId) {
      refetch();
    }
  }, [open, userId, refetch]);

  const stats: any = data || {};
  const totalAreaKm2 = ((stats.totalArea || 0) / 1000000).toFixed(2);
  const stolenFromViewerKm2 = ((stats.stolenFromViewer || 0) / 1000000).toFixed(2);
  const stolenByViewerKm2 = ((stats.stolenByViewer || 0) / 1000000).toFixed(2);
  const totalStolenKm2 = ((stats.totalStolen || 0) / 1000000).toFixed(2);
  const totalLostKm2 = ((stats.totalLost || 0) / 1000000).toFixed(2);

  return (
    <>
    <Dialog open={open} onOpenChange={(v) => {
      if (!v) {
        // If full avatar is showing, just close it instead of closing the whole dialog
        if (showFullAvatar) {
          setShowFullAvatar(false);
          return;
        }
        setSelectedFriendId(null);
      }
      onOpenChange(v);
    }}>
      <DialogContent
        className="w-[calc(100%-1.5rem)] max-w-sm gap-0 rounded-2xl border-0 shadow-2xl p-0 flex flex-col overflow-hidden top-[--dialog-top] translate-y-0 [&>button.absolute]:text-white [&>button.absolute]:hover:bg-white/15 [&>button.absolute]:hover:text-white"
        onInteractOutside={(e) => {
          if (showFullAvatar) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (showFullAvatar) e.preventDefault();
        }}
        style={{
          '--dialog-top': 'calc(env(safe-area-inset-top, 0px) + 1rem)',
          padding: 0,
          maxHeight: 'calc(100vh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 2rem)',
        } as React.CSSProperties}
      >
        <div className="relative bg-gradient-to-br from-emerald-500 via-green-500 to-teal-600 px-4 py-5 text-white flex-shrink-0">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.15),transparent_70%)]" />
          <DialogHeader className="space-y-1 relative">
            <div className="flex items-center gap-2">
              {selectedFriendId && (
                <button
                  onClick={() => setSelectedFriendId(null)}
                  className="flex-shrink-0 hover:bg-white/15 transition-colors rounded-full p-1.5"
                  title="Volver"
                >
                  <ChevronLeft className="h-5 w-5 text-white" />
                </button>
              )}
              <div className="flex-1">
                <DialogTitle className="text-lg font-bold text-white">Perfil del usuario</DialogTitle>
              </div>
            </div>
            <DialogDescription className="text-sm text-white/85">
              Datos publicos y actividad reciente
            </DialogDescription>
          </DialogHeader>
          <div className="relative mt-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <button
                className="p-1.5 rounded-full bg-white/20 backdrop-blur-sm cursor-pointer active:scale-95 transition-transform"
                onClick={() => stats.user?.avatar && setShowFullAvatar(true)}
              >
                <Avatar key={displayUserId} className="h-14 w-14 ring-2 ring-white/40">
                  <AvatarImage src={stats.user?.avatar || undefined} alt={stats.user?.name} />
                  <AvatarFallback style={{ backgroundColor: stats.user?.color || '#333' }}>
                    {stats.user?.name ? stats.user.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase() : '?'}
                  </AvatarFallback>
                </Avatar>
              </button>
              <div className="min-w-0">
                <div className="font-semibold text-base truncate">{stats.user?.name || 'Usuario'}</div>
                <div className="text-sm text-white/85 truncate">@{stats.user?.username || 'unknown'}</div>
              </div>
            </div>
            {currentUserId && currentUserId !== displayUserId && !isAlreadyFriend && (
              <button
                onClick={handleAddFriend}
                disabled={addingFriend}
                className="flex-shrink-0 hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed rounded-full p-2 transition-colors"
                title="Añadir amigo"
              >
                {addingFriend ? (
                  <Loader2 className="h-5 w-5 text-white animate-spin" />
                ) : (
                  <UserPlus className="h-5 w-5 text-white" />
                )}
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto" style={{ WebkitOverflowScrolling: 'touch' }}>
          <div className="space-y-3 p-4" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <MapPin className="h-4 w-4 text-primary" />
                Area total
              </div>
              <div className="text-2xl font-bold mt-1">{totalAreaKm2}</div>
              <div className="text-xs text-muted-foreground">km²</div>
            </div>
            <div
              className="rounded-xl border border-border/60 bg-muted/30 p-3 cursor-pointer transition-all hover:shadow-md hover:border-primary/30 hover:bg-muted/50 active:scale-[0.98] group"
              onClick={() => setActivitiesOpen(true)}
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Activity className="h-4 w-4 text-primary" />
                Actividades
                <ChevronRight className="h-3.5 w-3.5 ml-auto text-muted-foreground/50 group-hover:text-primary transition-colors" />
              </div>
              <div className="text-2xl font-bold mt-1">{stats.activitiesCount ?? 0}</div>
              <div className="text-xs text-muted-foreground">registradas</div>
            </div>
          </div>

          <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Calendar className="h-4 w-4 text-primary" />
              Ultima actividad
            </div>
            <div className="text-sm font-medium mt-1">
              {stats.lastActivity
                ? new Date(stats.lastActivity).toLocaleString('es-ES', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : 'Sin actividad'}
            </div>
          </div>

          {/* Conquest / Stolen area section */}
          {currentUserId && currentUserId !== userId && (
            <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2">
              <div className="text-xs font-medium text-muted-foreground mb-1">Conquistas entre vosotros</div>
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center h-7 w-7 rounded-full bg-red-100 dark:bg-red-900/30">
                  <Swords className="h-3.5 w-3.5 text-red-500" />
                </div>
                <div className="flex-1">
                  <span className="text-sm">Te ha robado</span>
                </div>
                <span className="text-sm font-bold">{stolenFromViewerKm2} km²</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center justify-center h-7 w-7 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
                  <Shield className="h-3.5 w-3.5 text-emerald-500" />
                </div>
                <div className="flex-1">
                  <span className="text-sm">Le has robado</span>
                </div>
                <span className="text-sm font-bold">{stolenByViewerKm2} km²</span>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground mb-1">Conquistas globales</div>
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center h-7 w-7 rounded-full bg-red-100 dark:bg-red-900/30">
                <Swords className="h-3.5 w-3.5 text-red-500" />
              </div>
              <div className="flex-1">
                <span className="text-sm">Ha robado en total</span>
              </div>
              <span className="text-sm font-bold">{totalStolenKm2} km²</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center justify-center h-7 w-7 rounded-full bg-amber-100 dark:bg-amber-900/30">
                <Shield className="h-3.5 w-3.5 text-amber-500" />
              </div>
              <div className="flex-1">
                <span className="text-sm">Le han robado en total</span>
              </div>
              <span className="text-sm font-bold">{totalLostKm2} km²</span>
            </div>
          </div>

          {/* Friends section */}
          <div className="rounded-xl border border-border/60 bg-muted/30 p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-2">
              <Users className="h-4 w-4 text-primary" />
              <span>Amigos ({friends.length})</span>
            </div>
            {friendsLoading ? (
              <div className="flex items-center justify-center py-3">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
              </div>
            ) : friends.length === 0 ? (
              <div className="text-center py-3 text-muted-foreground">
                <p className="text-xs">Sin amigos aún</p>
              </div>
            ) : (
              <ScrollArea className="h-max max-h-[256px]">
                <div className="space-y-1.5 pr-4">
                  {(friends as any[]).map((friend) => (
                    <div
                      key={friend.id}
                      onClick={() => setSelectedFriendId(friend.id)}
                      className="flex items-center gap-2 rounded-lg p-1.5 bg-background/50 hover:bg-background/80 transition-colors cursor-pointer group active:scale-95"
                    >
                      <Avatar className="h-6 w-6">
                        <AvatarImage src={friend.avatar || undefined} alt={friend.name} />
                        <AvatarFallback style={{ backgroundColor: friend.color || '#888888', fontSize: '0.55rem' }}>
                          {friend.name ? friend.name.split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase() : '?'}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate">{friend.name}</div>
                        <div className="text-xs text-muted-foreground truncate">@{friend.username}</div>
                      </div>
                      {friend.totalArea !== undefined && (
                        <div className="text-xs font-semibold text-primary flex-shrink-0">
                          {((friend.totalArea || 0) / 1000000).toFixed(1)} km²
                        </div>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors flex-shrink-0" />
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </div>
        </div>
      </DialogContent>
    </Dialog>

    <UserActivitiesDialog
      userId={displayUserId}
      userName={stats.user?.name || 'Usuario'}
      open={activitiesOpen}
      onOpenChange={setActivitiesOpen}
    />

    {/* Full-size avatar overlay — portaled to body to appear above Radix dialog */}
    {showFullAvatar && stats.user?.avatar && createPortal(
      <div
        ref={overlayRef}
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm"
        onClick={() => setShowFullAvatar(false)}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setShowFullAvatar(false); }}
          className="absolute top-4 right-4 z-[10000] bg-white/20 hover:bg-white/30 backdrop-blur-sm rounded-full p-2 transition-colors"
          style={{ marginTop: 'env(safe-area-inset-top, 0px)' }}
        >
          <X className="h-6 w-6 text-white" />
        </button>
        <img
          src={stats.user.avatar}
          alt={stats.user.name || 'Avatar'}
          className="max-w-[85vw] max-h-[85vh] rounded-2xl shadow-2xl object-contain animate-in zoom-in-90 duration-200"
          onClick={(e) => e.stopPropagation()}
        />
      </div>,
      document.body
    )}
    </>
  );
}

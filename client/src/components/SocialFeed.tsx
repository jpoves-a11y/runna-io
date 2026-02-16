import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useInfiniteQuery } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useSession } from '@/hooks/use-session';
import { useToast } from '@/hooks/use-toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  MapPin, Users, Swords, Trophy, MessageCircle, Send, ChevronDown, ChevronUp, Trash2, Reply, Loader2
} from 'lucide-react';
import type { FeedEventWithDetails, FeedCommentWithUser } from '@shared/schema';

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(2)} km`;
  return `${Math.round(meters)} m`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function preciseTimeAgo(dateStr: string): string {
  try {
    const now = Date.now();
    // Append Z to force UTC parsing — SQLite CURRENT_TIMESTAMP stores UTC without timezone indicator
    const normalized = dateStr.includes('Z') || dateStr.includes('+') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
    const then = new Date(normalized).getTime();
    const diffMs = now - then;
    if (diffMs < 0) return 'ahora';
    const mins = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);
    if (mins < 1) return 'ahora';
    if (mins === 1) return 'hace 1 minuto';
    if (mins < 60) return `hace ${mins} minutos`;
    if (hours === 1) return 'hace 1 hora';
    if (hours < 24) return `hace ${hours} horas`;
    if (days === 1) return 'hace 1 día';
    if (days < 30) return `hace ${days} días`;
    if (months === 1) return 'hace 1 mes';
    if (months < 12) return `hace ${months} meses`;
    if (years === 1) return 'hace 1 año';
    return `hace ${years} años`;
  } catch {
    return '';
  }
}

function formatArea(sqMeters: number): string {
  const km2 = sqMeters / 1000000;
  if (km2 >= 0.01) return `${km2.toFixed(2)} km²`;
  return `${Math.round(sqMeters)} m²`;
}

function UserAvatar({ user, size = 'sm' }: { user: { name: string; color: string; avatar?: string | null }; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm';
  if (user.avatar) {
    return <img src={user.avatar} alt={user.name} className={`${dim} rounded-full object-cover border-2`} style={{ borderColor: user.color }} />;
  }
  return (
    <div className={`${dim} rounded-full flex items-center justify-center text-white font-bold border-2`} style={{ backgroundColor: user.color, borderColor: user.color }}>
      {user.name.charAt(0).toUpperCase()}
    </div>
  );
}

function EventCard({ event, currentUserId }: { event: FeedEventWithDetails; currentUserId: string }) {
  const [showComments, setShowComments] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionCursorPos, setMentionCursorPos] = useState(0);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch friends for @mention suggestions
  const { data: friends } = useQuery<Array<{ id: string; name: string; username: string; color: string; avatar?: string | null }>>({
    queryKey: ['/api/friends', currentUserId],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/friends/${currentUserId}`);
      return res.json();
    },
    staleTime: 60000,
  });

  const { data: comments, isLoading: loadingComments } = useQuery<FeedCommentWithUser[]>({
    queryKey: ['/api/feed/events', event.id, 'comments'],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/feed/events/${event.id}/comments`);
      return res.json();
    },
    enabled: showComments,
  });

  const addCommentMutation = useMutation({
    mutationFn: async () => {
      await apiRequest('POST', `/api/feed/events/${event.id}/comments`, {
        userId: currentUserId,
        content: commentText.trim(),
        parentId: replyTo?.id || null,
      });
    },
    onSuccess: () => {
      setCommentText('');
      setReplyTo(null);
      queryClient.invalidateQueries({ queryKey: ['/api/feed/events', event.id, 'comments'] });
      // Update comment count in feed
      queryClient.invalidateQueries({ queryKey: ['/api/feed'] });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const deleteCommentMutation = useMutation({
    mutationFn: async (commentId: string) => {
      await apiRequest('DELETE', `/api/feed/comments/${commentId}`, { userId: currentUserId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/feed/events', event.id, 'comments'] });
      queryClient.invalidateQueries({ queryKey: ['/api/feed'] });
    },
  });

  const handleReply = (commentId: string, userName: string) => {
    setReplyTo({ id: commentId, name: userName });
    setShowComments(true);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const insertMention = (friendName: string) => {
    const text = commentText;
    const beforeCursor = text.substring(0, mentionCursorPos);
    const atIndex = beforeCursor.lastIndexOf('@');
    if (atIndex === -1) return;
    const before = text.substring(0, atIndex);
    const after = text.substring(mentionCursorPos);
    const newText = `${before}@${friendName} ${after}`;
    setCommentText(newText);
    setShowMentions(false);
    setMentionFilter('');
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const handleCommentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || value.length;
    setCommentText(value);
    setMentionCursorPos(cursorPos);
    const beforeCursor = value.substring(0, cursorPos);
    const atMatch = beforeCursor.match(/@([\w\u00C0-\u024F]*)$/);
    if (atMatch) {
      setMentionFilter(atMatch[1].toLowerCase());
      setShowMentions(true);
    } else {
      setShowMentions(false);
      setMentionFilter('');
    }
  };

  const renderMentionedText = (text: string) => {
    return text.split(/(@[\w\u00C0-\u024F]+(?:\s[\w\u00C0-\u024F]+)?)/).map((part, i) =>
      part.startsWith('@') ? <span key={i} className="text-blue-400 font-semibold">{part}</span> : part
    );
  };

  const renderEventContent = () => {
    const isOwn = event.userId === currentUserId;
    const userName = isOwn ? 'Tú' : event.user.name;

    switch (event.eventType) {
      case 'activity':
        return (
          <div className="flex items-start gap-3">
            <UserAvatar user={event.user} size="md" />
            <div className="flex-1 min-w-0">
              <p className="text-sm">
                <span className="font-semibold" style={{ color: event.user.color }}>{userName}</span>
                {' '}corrió{event.activityDate ? ` ${preciseTimeAgo(event.activityDate)}` : ''}
                {event.routeName ? (
                  <> y completó <span className="font-medium">"{event.routeName}"</span></>
                ) : (
                  ' y completó una actividad'
                )}
              </p>
              <div className="flex flex-wrap gap-2 mt-1.5">
                {event.distance && (
                  <Badge variant="secondary" className="text-xs">
                    <MapPin className="w-3 h-3 mr-1" />{formatDistance(event.distance)}
                  </Badge>
                )}
                {event.duration && (
                  <Badge variant="secondary" className="text-xs">
                    🕐 {formatDuration(event.duration)}
                  </Badge>
                )}
                {event.newArea && event.newArea > 0 && (
                  <Badge variant="secondary" className="text-xs bg-green-500/20 text-green-400">
                    +{formatArea(event.newArea)}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        );

      case 'territory_stolen':
        return (
          <div className="flex items-start gap-3">
            <UserAvatar user={event.user} size="md" />
            <div className="flex-1 min-w-0">
              <p className="text-sm">
                <span className="font-semibold" style={{ color: event.user.color }}>{userName}</span>
                {' '}ha robado territorio a{' '}
                <span className="font-semibold" style={{ color: event.victim?.color }}>
                  {event.victim?.id === currentUserId ? 'ti' : event.victim?.name || 'alguien'}
                </span>
                {event.routeName && (
                  <span className="text-muted-foreground"> en "{event.routeName}"</span>
                )}
              </p>
              {event.areaStolen && (
                <Badge variant="destructive" className="text-xs mt-1.5">
                  <Swords className="w-3 h-3 mr-1" />
                  {formatArea(event.areaStolen)} robados
                </Badge>
              )}
            </div>
          </div>
        );

      case 'ran_together': {
        let ranWith: Array<{ id: string; name: string }> = [];
        try {
          ranWith = event.ranTogetherWith ? JSON.parse(event.ranTogetherWith) : [];
        } catch { /* ignore */ }
        return (
          <div className="flex items-start gap-3">
            <UserAvatar user={event.user} size="md" />
            <div className="flex-1 min-w-0">
              <p className="text-sm">
                <span className="font-semibold" style={{ color: event.user.color }}>{userName}</span>
                {' '}ha corrido junto a{' '}
                {ranWith.map((u, i) => (
                  <span key={u.id}>
                    {i > 0 && (i === ranWith.length - 1 ? ' y ' : ', ')}
                    <span className="font-semibold">{u.id === currentUserId ? 'ti' : u.name}</span>
                  </span>
                ))}
              </p>
              {event.distance && (
                <Badge variant="secondary" className="text-xs mt-1.5">
                  <Users className="w-3 h-3 mr-1" />{formatDistance(event.distance)}
                </Badge>
              )}
            </div>
          </div>
        );
      }

      case 'personal_record':
        return (
          <div className="flex items-start gap-3">
            <UserAvatar user={event.user} size="md" />
            <div className="flex-1 min-w-0">
              <p className="text-sm">
                <span className="font-semibold" style={{ color: event.user.color }}>{userName}</span>
                {' '}ha batido un récord personal
              </p>
              <Badge className="text-xs mt-1.5 bg-yellow-500/20 text-yellow-400">
                <Trophy className="w-3 h-3 mr-1" />
                {event.recordType === 'longest_run' ? 'Carrera más larga' :
                  event.recordType === 'fastest_pace' ? 'Ritmo más rápido' :
                    event.recordType === 'biggest_conquest' ? 'Mayor conquista' : 'Récord'}
              </Badge>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const timeAgo = preciseTimeAgo(event.createdAt);

  return (
    <Card className="p-3 bg-card/50 border-border/50">
      {renderEventContent()}

      <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/30">
        <span className="text-xs text-muted-foreground">{timeAgo}</span>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground h-7 px-2"
          onClick={() => setShowComments(!showComments)}
        >
          <MessageCircle className="w-3.5 h-3.5 mr-1" />
          {event.commentCount > 0 ? `${event.commentCount}` : 'Comentar'}
          {showComments ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />}
        </Button>
      </div>

      {showComments && (
        <div className="mt-2 space-y-2">
          {loadingComments ? (
            <div className="flex justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            comments && comments.length > 0 && (
              <div className="space-y-2">
                {comments.map((comment) => (
                  <div key={comment.id} className="space-y-1.5">
                    {/* Top-level comment */}
                    <div className="flex items-start gap-2 bg-background/50 rounded-lg p-2">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                        style={{ backgroundColor: '#666' }}>
                        {comment.user.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1">
                          <span className="text-xs font-semibold">{comment.user.name}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {preciseTimeAgo(comment.createdAt)}
                          </span>
                        </div>
                        <p className="text-xs text-foreground/80 break-words">{renderMentionedText(comment.content)}</p>
                        <div className="flex gap-2 mt-0.5">
                          <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => handleReply(comment.id, comment.user.name)}>
                            <Reply className="w-3 h-3 inline mr-0.5" />Responder
                          </button>
                          {comment.userId === currentUserId && (
                            <button className="text-[10px] text-muted-foreground hover:text-red-400" onClick={() => deleteCommentMutation.mutate(comment.id)}>
                              <Trash2 className="w-3 h-3 inline mr-0.5" />Borrar
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Replies */}
                    {comment.replies && comment.replies.length > 0 && (
                      <div className="ml-6 space-y-1.5">
                        {comment.replies.map((reply) => (
                          <div key={reply.id} className="flex items-start gap-2 bg-background/30 rounded-lg p-2">
                            <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0"
                              style={{ backgroundColor: '#555' }}>
                              {reply.user.name.charAt(0).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1">
                                <span className="text-[11px] font-semibold">{reply.user.name}</span>
                                <span className="text-[10px] text-muted-foreground">
                                  {preciseTimeAgo(reply.createdAt)}
                                </span>
                              </div>
                              <p className="text-xs text-foreground/80 break-words">{renderMentionedText(reply.content)}</p>
                              {reply.userId === currentUserId && (
                                <button className="text-[10px] text-muted-foreground hover:text-red-400 mt-0.5" onClick={() => deleteCommentMutation.mutate(reply.id)}>
                                  <Trash2 className="w-3 h-3 inline mr-0.5" />Borrar
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          )}

          {/* Comment input */}
          <div className="flex items-center gap-2">
            <div className="flex-1">
              {replyTo && (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
                  <Reply className="w-3 h-3" />
                  Respondiendo a {replyTo.name}
                  <button onClick={() => setReplyTo(null)} className="ml-1 hover:text-foreground">✕</button>
                </div>
              )}
              <div className="relative">
                <Input
                  ref={inputRef}
                  placeholder={replyTo ? 'Escribe tu respuesta...' : 'Escribe un comentario... (usa @ para mencionar)'}
                  value={commentText}
                  onChange={handleCommentChange}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && commentText.trim() && !showMentions) {
                      addCommentMutation.mutate();
                    }
                    if (e.key === 'Escape' && showMentions) {
                      setShowMentions(false);
                    }
                  }}
                  className="h-8 text-xs"
                  maxLength={500}
                />
                {showMentions && friends && friends.length > 0 && (() => {
                  const filtered = friends.filter(f => f.name.toLowerCase().includes(mentionFilter) || f.username.toLowerCase().includes(mentionFilter)).slice(0, 5);
                  return filtered.length > 0 ? (
                    <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-lg max-h-32 overflow-y-auto z-50">
                      {filtered.map(f => (
                        <button
                          key={f.id}
                          className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-accent/50 text-left text-xs"
                          onMouseDown={(e) => { e.preventDefault(); insertMention(f.name); }}
                        >
                          <div className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0"
                            style={{ backgroundColor: f.color }}>
                            {f.avatar ? <img src={f.avatar} alt="" className="w-5 h-5 rounded-full object-cover" /> : f.name.charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium">{f.name}</span>
                          <span className="text-muted-foreground">@{f.username}</span>
                        </button>
                      ))}
                    </div>
                  ) : null;
                })()}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              disabled={!commentText.trim() || addCommentMutation.isPending}
              onClick={() => addCommentMutation.mutate()}
            >
              {addCommentMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function SocialFeed() {
  const { user: currentUser } = useSession();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const LIMIT = 30;

  const { data: events, isLoading, isError, refetch } = useQuery<FeedEventWithDetails[]>({
    queryKey: ['/api/feed', currentUser?.id, page],
    queryFn: async () => {
      if (!currentUser) return [];
      const res = await apiRequest('GET', `/api/feed/${currentUser.id}?limit=${LIMIT}&offset=${page * LIMIT}`);
      return res.json();
    },
    enabled: !!currentUser,
  });

  if (!currentUser) return null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p className="text-sm">Error al cargar el feed</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Users className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-sm font-medium">No hay actividad reciente</p>
        <p className="text-xs mt-1">Cuando tú o tus amigos corráis, aparecerá aquí</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="space-y-3 pb-4">
      {events.map((event) => (
        <EventCard key={event.id} event={event} currentUserId={currentUser.id} />
      ))}

      {events.length >= LIMIT && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={() => setPage(p => p + 1)}>
            Cargar más
          </Button>
        </div>
      )}
    </div>
  );
}

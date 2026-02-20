import { useState, useRef, useEffect, useMemo, useCallback, memo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useSession } from '@/hooks/use-session';
import { useToast } from '@/hooks/use-toast';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import UserInfoDialog from '@/components/UserInfoDialog';
import {
  MapPin, Users, Swords, Trophy, MessageCircle, Send, Trash2, Reply, Loader2,
  ThumbsUp, ThumbsDown, CornerDownRight
} from 'lucide-react';
import type { FeedEventWithDetails, FeedCommentWithUser } from '@shared/schema';

// Merged event: activity event + any territory_stolen events from the same route
interface MergedFeedEvent extends FeedEventWithDetails {
  victims?: Array<{ id: string; name: string; color: string; avatar?: string | null; areaStolen: number }>;
}

/** Group activity + territory_stolen events by routeId+userId into single merged events */
function mergeEvents(events: FeedEventWithDetails[]): MergedFeedEvent[] {
  const result: MergedFeedEvent[] = [];
  // Map routeId+userId -> index in result where the activity event is
  const activityIndex = new Map<string, number>();
  // Track territory_stolen events that got merged (to skip them)
  const merged = new Set<string>();

  // First pass: identify activity events and collect territory_stolen events
  for (const event of events) {
    if (event.eventType === 'activity' && event.routeId) {
      const key = `${event.routeId}:${event.userId}`;
      const idx = result.length;
      activityIndex.set(key, idx);
      result.push({ ...event, victims: [] });
    }
  }

  // Second pass: merge territory_stolen into their activity event
  for (const event of events) {
    if (event.eventType === 'territory_stolen' && event.routeId) {
      const key = `${event.routeId}:${event.userId}`;
      const idx = activityIndex.get(key);
      if (idx !== undefined && result[idx]) {
        const victim = event.victim;
        if (victim) {
          result[idx].victims!.push({
            id: victim.id,
            name: victim.name,
            color: victim.color,
            avatar: victim.avatar,
            areaStolen: event.areaStolen || 0,
          });
        }
        // Also add the comment count from territory_stolen to the activity
        result[idx].commentCount += event.commentCount;
        merged.add(event.id);
      }
    }
  }

  // Third pass: add non-merged events (territory_stolen without matching activity, ran_together, personal_record, etc.)
  for (const event of events) {
    if (event.eventType === 'activity') continue; // already added
    if (merged.has(event.id)) continue; // was merged into activity
    result.push({ ...event });
  }

  // Sort by createdAt descending (since we broke order during grouping)
  result.sort((a, b) => {
    const da = new Date(a.createdAt).getTime();
    const db = new Date(b.createdAt).getTime();
    return db - da;
  });

  return result;
}

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
    if (mins === 1) return 'hace 1 min';
    if (mins < 60) return `hace ${mins} min`;
    if (hours === 1) return 'hace 1h';
    if (hours < 24) return `hace ${hours}h`;
    if (days === 1) return 'ayer';
    if (days < 30) return `hace ${days}d`;
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

// ─── Memoized Atomic Components ──────────────────────────────────────────────

const UserAvatar = memo(function UserAvatar({ user, size = 'sm', onClick }: { user: { name: string; color: string; avatar?: string | null }; size?: 'sm' | 'md' | 'xs'; onClick?: () => void }) {
  const dims = { xs: 'w-6 h-6 text-[9px]', sm: 'w-8 h-8 text-[11px]', md: 'w-10 h-10 text-sm' };
  const ringSize = { xs: 1.5, sm: 2, md: 2.5 };
  const dim = dims[size];
  const ring = ringSize[size];
  const Wrapper = onClick ? 'button' : 'div';
  if (user.avatar) {
    return (
      <Wrapper onClick={onClick} className={`${dim} rounded-full overflow-hidden flex-shrink-0`} style={{ boxShadow: `0 0 0 ${ring}px ${user.color}` }}>
        <img src={user.avatar} alt={user.name} className="w-full h-full rounded-full object-cover" loading="lazy" decoding="async" />
      </Wrapper>
    );
  }
  return (
    <Wrapper onClick={onClick} className={`${dim} rounded-full flex items-center justify-center text-white font-bold flex-shrink-0`} style={{ backgroundColor: user.color }}>
      {user.name.charAt(0).toUpperCase()}
    </Wrapper>
  );
});

const ReactionButton = memo(function ReactionButton({ type, count, active, onClick, size = 'sm' }: {
  type: 'like' | 'dislike'; count: number; active: boolean; onClick: () => void; size?: 'md' | 'sm' | 'xs';
}) {
  const Icon = type === 'like' ? ThumbsUp : ThumbsDown;
  const activeColor = type === 'like' ? 'text-blue-500' : 'text-red-500';
  const activeBg = type === 'like' ? 'bg-blue-500/10' : 'bg-red-500/10';
  const sizeMap = {
    xs: { icon: 'w-3 h-3', text: 'text-[10px]', btn: 'h-6 px-1.5 gap-0.5' },
    sm: { icon: 'w-3.5 h-3.5', text: 'text-[11px]', btn: 'h-7 px-2 gap-1' },
    md: { icon: 'w-4 h-4', text: 'text-xs', btn: 'h-8 px-2 gap-1' },
  };
  const s = sizeMap[size];

  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center justify-center ${s.btn} rounded-full transition-all duration-100
        active:scale-90
        ${active ? `${activeColor} ${activeBg} font-semibold` : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'}`}
    >
      <Icon className={`${s.icon} ${active ? 'fill-current' : ''}`} />
      {count > 0 && <span className={s.text}>{count}</span>}
    </button>
  );
});

// ─── Comment Row (compact, with inline actions) ─────────────────────────────

const CommentRow = memo(function CommentRow({
  comment, isReply, currentUserId, onReply, onDelete, onUserClick, onReaction, renderMentionedText,
}: {
  comment: FeedCommentWithUser;
  isReply?: boolean;
  currentUserId: string;
  onReply: (commentId: string, userName: string) => void;
  onDelete: (commentId: string) => void;
  onUserClick: (userId: string) => void;
  onReaction: (targetId: string, reactionType: 'like' | 'dislike') => void;
  renderMentionedText: (text: string) => React.ReactNode;
}) {
  const user = comment.user as any;

  return (
    <div className={`flex gap-2 py-1.5 ${isReply ? 'ml-8' : ''}`}>
      <UserAvatar
        user={{ name: user.name, color: user.color || '#888', avatar: user.avatar }}
        size="xs"
        onClick={() => onUserClick(user.id)}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <button
            className="text-[12px] font-semibold hover:underline leading-none"
            style={{ color: user.color || undefined }}
            onClick={() => onUserClick(user.id)}
          >
            {user.name}
          </button>
          <span className="text-[10px] text-muted-foreground leading-none">{preciseTimeAgo(comment.createdAt)}</span>
        </div>
        <p className="text-[12px] text-gray-800 dark:text-foreground/85 break-words leading-tight mt-0.5">{renderMentionedText(comment.content)}</p>
        <div className="flex items-center gap-0 mt-0.5">
          <ReactionButton type="like" count={comment.likeCount} active={comment.userReaction === 'like'} onClick={() => onReaction(comment.id, 'like')} size="xs" />
          <ReactionButton type="dislike" count={comment.dislikeCount} active={comment.userReaction === 'dislike'} onClick={() => onReaction(comment.id, 'dislike')} size="xs" />
          {!isReply && (
            <button className="text-[10px] text-muted-foreground hover:text-foreground ml-1 flex items-center gap-0.5 px-1.5 py-0.5 rounded-full hover:bg-muted/40 transition-colors active:scale-90" onClick={() => onReply(comment.id, user.name)}>
              <Reply className="w-3 h-3" />Responder
            </button>
          )}
          {comment.userId === currentUserId && (
            <button className="text-muted-foreground hover:text-red-400 ml-auto flex items-center justify-center w-5 h-5 rounded-full hover:bg-red-500/10 transition-colors active:scale-75" onClick={() => onDelete(comment.id)}>
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

// ─── Event Card ──────────────────────────────────────────────────────────────

const EventCard = memo(function EventCard({ event, currentUserId, onUserClick }: { event: MergedFeedEvent; currentUserId: string; onUserClick: (userId: string) => void }) {
  const [showAllComments, setShowAllComments] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionCursorPos, setMentionCursorPos] = useState(0);
  // Local optimistic state for post reactions
  const [localLikeCount, setLocalLikeCount] = useState(event.likeCount);
  const [localDislikeCount, setLocalDislikeCount] = useState(event.dislikeCount);
  const [localUserReaction, setLocalUserReaction] = useState(event.userReaction);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync local state when event prop updates
  useEffect(() => {
    setLocalLikeCount(event.likeCount);
    setLocalDislikeCount(event.dislikeCount);
    setLocalUserReaction(event.userReaction);
  }, [event.likeCount, event.dislikeCount, event.userReaction]);

  // Fetch friends for @mention suggestions — long cache
  const { data: friends } = useQuery<Array<{ id: string; name: string; username: string; color: string; avatar?: string | null }>>({
    queryKey: ['/api/friends', currentUserId],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/friends/${currentUserId}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });

  // Preview comments (always loaded) — cached longer for performance
  const { data: previewComments } = useQuery<FeedCommentWithUser[]>({
    queryKey: ['/api/feed/events', event.id, 'preview-comments', currentUserId],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/feed/events/${event.id}/preview-comments?userId=${currentUserId}&limit=2`);
      return res.json();
    },
    enabled: event.commentCount > 0,
    staleTime: 60000,
    gcTime: 5 * 60 * 1000,
  });

  // All comments (loaded on demand)
  const { data: allComments, isLoading: loadingAllComments } = useQuery<FeedCommentWithUser[]>({
    queryKey: ['/api/feed/events', event.id, 'comments', currentUserId],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/feed/events/${event.id}/comments?userId=${currentUserId}`);
      return res.json();
    },
    enabled: showAllComments,
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
      queryClient.invalidateQueries({ queryKey: ['/api/feed/events', event.id, 'preview-comments'] });
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
      queryClient.invalidateQueries({ queryKey: ['/api/feed/events', event.id, 'preview-comments'] });
      queryClient.invalidateQueries({ queryKey: ['/api/feed'] });
    },
  });

  const reactionMutation = useMutation({
    mutationFn: async ({ targetType, targetId, reactionType }: { targetType: 'event' | 'comment'; targetId: string; reactionType: 'like' | 'dislike' }) => {
      const res = await apiRequest('POST', '/api/feed/reactions', { userId: currentUserId, targetType, targetId, reactionType });
      return res.json();
    },
    onSuccess: (data, variables) => {
      if (variables.targetType === 'event') {
        setLocalLikeCount(data.likeCount);
        setLocalDislikeCount(data.dislikeCount);
        setLocalUserReaction(data.userReaction);
        queryClient.invalidateQueries({ queryKey: ['/api/feed'] });
      } else {
        queryClient.invalidateQueries({ queryKey: ['/api/feed/events', event.id, 'comments'] });
        queryClient.invalidateQueries({ queryKey: ['/api/feed/events', event.id, 'preview-comments'] });
      }
    },
  });

  const handlePostReaction = (reactionType: 'like' | 'dislike') => {
    // Optimistic update
    if (localUserReaction === reactionType) {
      // Toggle off
      setLocalUserReaction(null);
      if (reactionType === 'like') setLocalLikeCount(c => Math.max(0, c - 1));
      else setLocalDislikeCount(c => Math.max(0, c - 1));
    } else {
      // Switch or new
      if (localUserReaction === 'like') setLocalLikeCount(c => Math.max(0, c - 1));
      if (localUserReaction === 'dislike') setLocalDislikeCount(c => Math.max(0, c - 1));
      setLocalUserReaction(reactionType);
      if (reactionType === 'like') setLocalLikeCount(c => c + 1);
      else setLocalDislikeCount(c => c + 1);
    }
    reactionMutation.mutate({ targetType: 'event', targetId: event.id, reactionType });
  };

  const handleCommentReaction = (targetId: string, reactionType: 'like' | 'dislike') => {
    reactionMutation.mutate({ targetType: 'comment', targetId, reactionType });
  };

  const handleReply = (commentId: string, userName: string) => {
    setReplyTo({ id: commentId, name: userName });
    if (!showAllComments) setShowAllComments(true);
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

  const renderMentionedText = useCallback((text: string) => {
    return text.split(/(@[\w\u00C0-\u024F]+(?:\s[\w\u00C0-\u024F]+)?)/).map((part, i) => {
      if (part.startsWith('@')) {
        const mentionName = part.slice(1).toLowerCase();
        const matchedFriend = friends?.find(f =>
          f.name.toLowerCase() === mentionName || f.username.toLowerCase() === mentionName
        );
        return (
          <span
            key={i}
            className="text-blue-400 font-semibold cursor-pointer hover:underline"
            onClick={() => matchedFriend && onUserClick(matchedFriend.id)}
          >
            {part}
          </span>
        );
      }
      return part;
    });
  }, [friends, onUserClick]);

  const renderEventContent = () => {
    const isOwn = event.userId === currentUserId;
    const userName = isOwn ? 'Tú' : event.user.name;
    const victims = (event as MergedFeedEvent).victims || [];

    switch (event.eventType) {
      case 'activity':
        return (
          <>
            {/* Post header */}
            <div className="flex items-start gap-2.5">
              <UserAvatar user={event.user} size="md" onClick={() => onUserClick(event.userId)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <button className="text-[13px] font-bold hover:underline" style={{ color: event.user.color }} onClick={() => onUserClick(event.userId)}>{userName}</button>
                  <span className="text-[10px] text-muted-foreground">· {preciseTimeAgo(event.activityDate || event.createdAt)}</span>
                </div>
                <p className="text-[12px] text-gray-800 dark:text-foreground/75 mt-0.5 leading-snug">
                  {event.routeName ? (
                    <>Completó <span className="font-medium text-gray-900 dark:text-foreground/90">"{event.routeName}"</span></>
                  ) : (
                    'Completó una actividad'
                  )}
                  {victims.length > 0 && (
                    <>
                      {' '}y robó territorio a{' '}
                      {victims.map((v, i) => (
                        <span key={v.id}>
                          {i > 0 && (i === victims.length - 1 ? ' y ' : ', ')}
                          <span
                            className="font-semibold cursor-pointer hover:underline"
                            style={{ color: v.color }}
                            onClick={() => onUserClick(v.id)}
                          >
                            {v.id === currentUserId ? 'ti' : v.name}
                          </span>
                        </span>
                      ))}
                    </>
                  )}
                </p>
              </div>
            </div>

            {/* Stats badges — compact */}
            <div className="flex flex-wrap gap-1 mt-2 ml-[50px]">
              {event.distance && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/8 dark:bg-primary/15 text-[11px] font-medium text-primary">
                  <MapPin className="w-3 h-3" />{formatDistance(event.distance)}
                </span>
              )}
              {event.duration && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted/80 dark:bg-muted/60 text-[11px] font-medium">
                  🕐 {formatDuration(event.duration)}
                </span>
              )}
              {event.newArea && event.newArea > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                  +{formatArea(event.newArea)}
                </span>
              )}
              {victims.map((v) => (
                <span key={v.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/10 text-[11px] font-semibold text-red-600 dark:text-red-400">
                  <Swords className="w-3 h-3" />
                  {formatArea(v.areaStolen)} de {v.id === currentUserId ? 'ti' : v.name}
                </span>
              ))}
            </div>
          </>
        );

      case 'territory_stolen':
        return (
          <div className="flex items-start gap-2.5">
            <UserAvatar user={event.user} size="md" onClick={() => onUserClick(event.userId)} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <button className="text-[13px] font-bold hover:underline" style={{ color: event.user.color }} onClick={() => onUserClick(event.userId)}>{userName}</button>
                <span className="text-[10px] text-muted-foreground">· {preciseTimeAgo(event.createdAt)}</span>
              </div>
              <p className="text-[12px] text-gray-800 dark:text-foreground/75 mt-0.5 leading-snug">
                Ha robado territorio a{' '}
                <span className="font-semibold cursor-pointer hover:underline" style={{ color: event.victim?.color }} onClick={() => event.victim && onUserClick(event.victim.id)}>
                  {event.victim?.id === currentUserId ? 'ti' : event.victim?.name || 'alguien'}
                </span>
                {event.routeName && <span className="text-muted-foreground"> en "{event.routeName}"</span>}
              </p>
              {event.areaStolen && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 mt-1.5 rounded-full bg-red-500/10 text-[11px] font-semibold text-red-600 dark:text-red-400">
                  <Swords className="w-3 h-3" />{formatArea(event.areaStolen)} robados
                </span>
              )}
            </div>
          </div>
        );

      case 'ran_together': {
        let ranWith: Array<{ id: string; name: string }> = [];
        try { ranWith = event.ranTogetherWith ? JSON.parse(event.ranTogetherWith) : []; } catch { }
        return (
          <div className="flex items-start gap-2.5">
            <UserAvatar user={event.user} size="md" onClick={() => onUserClick(event.userId)} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <button className="text-[13px] font-bold hover:underline" style={{ color: event.user.color }} onClick={() => onUserClick(event.userId)}>{userName}</button>
                <span className="text-[10px] text-muted-foreground">· {preciseTimeAgo(event.createdAt)}</span>
              </div>
              <p className="text-[12px] text-gray-800 dark:text-foreground/75 mt-0.5 leading-snug">
                Ha corrido junto a{' '}
                {ranWith.map((u, i) => (
                  <span key={u.id}>
                    {i > 0 && (i === ranWith.length - 1 ? ' y ' : ', ')}
                    <span className="font-semibold cursor-pointer hover:underline" onClick={() => onUserClick(u.id)}>
                      {u.id === currentUserId ? 'ti' : u.name}
                    </span>
                  </span>
                ))}
              </p>
              {event.distance && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 mt-1.5 rounded-full bg-muted/80 dark:bg-muted/60 text-[11px] font-medium">
                  <Users className="w-3 h-3 text-primary" />{formatDistance(event.distance)}
                </span>
              )}
            </div>
          </div>
        );
      }

      case 'personal_record':
        return (
          <div className="flex items-start gap-2.5">
            <UserAvatar user={event.user} size="md" onClick={() => onUserClick(event.userId)} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <button className="text-[13px] font-bold hover:underline" style={{ color: event.user.color }} onClick={() => onUserClick(event.userId)}>{userName}</button>
                <span className="text-[10px] text-muted-foreground">· {preciseTimeAgo(event.createdAt)}</span>
              </div>
              <p className="text-[12px] text-gray-800 dark:text-foreground/75 mt-0.5 leading-snug">Ha batido un récord personal</p>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 mt-1.5 rounded-full bg-amber-500/10 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                <Trophy className="w-3 h-3" />
                {event.recordType === 'longest_run' ? 'Carrera más larga' :
                  event.recordType === 'fastest_pace' ? 'Ritmo más rápido' :
                    event.recordType === 'biggest_conquest' ? 'Mayor conquista' : 'Récord'}
              </span>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  // Comments to display
  const displayedComments = showAllComments ? allComments : previewComments;
  const hasMoreComments = event.commentCount > 2 && !showAllComments;

  return (
    <Card className="overflow-hidden
      border border-emerald-200/60 dark:border-emerald-500/20
      bg-gradient-to-br from-emerald-50/40 to-white dark:from-emerald-950/30 dark:to-card
      shadow-sm hover:shadow-md transition-shadow duration-200">

      {/* Post content */}
      <div className="p-3 pb-2">
        {renderEventContent()}
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-1 px-3 py-1 border-t border-emerald-100/80 dark:border-border/40">
        <ReactionButton type="like" count={localLikeCount} active={localUserReaction === 'like'} onClick={() => handlePostReaction('like')} size="sm" />
        <ReactionButton type="dislike" count={localDislikeCount} active={localUserReaction === 'dislike'} onClick={() => handlePostReaction('dislike')} size="sm" />
        <button
          onClick={() => {
            setShowAllComments(true);
            setTimeout(() => inputRef.current?.focus(), 80);
          }}
          className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-all active:scale-90 ml-auto"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          {event.commentCount > 0 ? event.commentCount : 'Comentar'}
        </button>
      </div>

      {/* Comments section */}
      <div className="border-t border-emerald-100/80 dark:border-border/40 bg-gray-50/80 dark:bg-black/40">
          {/* Preview or full comments */}
          {displayedComments && displayedComments.length > 0 && (
            <div className="px-3 pt-1">
              {displayedComments.map((comment, idx) => (
                <div key={comment.id}>
                  {/* Elegant vertical separator between top-level comments */}
                  {idx > 0 && (
                    <div className="flex items-center ml-3 my-0.5">
                      <div className="w-px h-3 bg-gradient-to-b from-transparent via-border/60 dark:via-emerald-500/25 to-transparent rounded-full" />
                    </div>
                  )}
                  <CommentRow
                    comment={comment}
                    currentUserId={currentUserId}
                    onReply={handleReply}
                    onDelete={(id) => deleteCommentMutation.mutate(id)}
                    onUserClick={onUserClick}
                    onReaction={handleCommentReaction}
                    renderMentionedText={renderMentionedText}
                  />
                  {/* Replies with thread indicator */}
                  {comment.replies && comment.replies.length > 0 && (
                    <div className="ml-4 border-l-2 border-primary/12 dark:border-emerald-500/20 pl-1">
                      {comment.replies.map((reply) => (
                        <CommentRow
                          key={reply.id}
                          comment={reply}
                          isReply
                          currentUserId={currentUserId}
                          onReply={handleReply}
                          onDelete={(id) => deleteCommentMutation.mutate(id)}
                          onUserClick={onUserClick}
                          onReaction={handleCommentReaction}
                          renderMentionedText={renderMentionedText}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Loading state for all comments */}
          {showAllComments && loadingAllComments && (
            <div className="flex justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* "Ver más" button */}
          {hasMoreComments && (
            <button
              onClick={() => setShowAllComments(true)}
              className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground py-1.5 transition-colors"
            >
              Ver los {event.commentCount} comentarios
            </button>
          )}

          {/* Comment input — compact */}
          <div className="px-3 py-2 border-t border-emerald-100/60 dark:border-border/30">
            {replyTo && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
                <CornerDownRight className="w-2.5 h-2.5" />
                Respondiendo a <span className="font-medium">{replyTo.name}</span>
                <button onClick={() => setReplyTo(null)} className="ml-1 hover:text-foreground text-xs">✕</button>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <div className="flex-1 relative">
                <Input
                  ref={inputRef}
                  placeholder={replyTo ? 'Respuesta...' : 'Comentar... (@ para mencionar)'}
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
                  className="h-7 text-[12px] bg-background/60 dark:bg-background/40 border-border/30 rounded-full px-3"
                  maxLength={500}
                />
                {showMentions && friends && friends.length > 0 && (() => {
                  const filtered = friends.filter(f => f.name.toLowerCase().includes(mentionFilter) || f.username.toLowerCase().includes(mentionFilter)).slice(0, 5);
                  return filtered.length > 0 ? (
                    <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-border rounded-lg shadow-lg max-h-32 overflow-y-auto z-50">
                      {filtered.map(f => (
                        <button
                          key={f.id}
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-accent/50 text-left text-[11px] transition-colors"
                          onMouseDown={(e) => { e.preventDefault(); insertMention(f.name); }}
                        >
                          <UserAvatar user={{ name: f.name, color: f.color, avatar: f.avatar }} size="xs" />
                          <span className="font-medium">{f.name}</span>
                          <span className="text-muted-foreground">@{f.username}</span>
                        </button>
                      ))}
                    </div>
                  ) : null;
                })()}
              </div>
              <Button
                size="sm"
                className="h-7 w-7 p-0 rounded-full"
                variant="ghost"
                disabled={!commentText.trim() || addCommentMutation.isPending}
                onClick={() => addCommentMutation.mutate()}
              >
                {addCommentMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
              </Button>
            </div>
          </div>
        </div>
    </Card>
  );
});

// ─── Social Feed (main export) ───────────────────────────────────────────────

export function SocialFeed() {
  const { user: currentUser } = useSession();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const LIMIT = 30;

  const handleUserClick = useCallback((userId: string) => {
    setSelectedUserId(userId);
    setIsDialogOpen(true);
  }, []);

  const { data: events, isLoading, isError, refetch } = useQuery<FeedEventWithDetails[]>({
    queryKey: ['/api/feed', currentUser?.id, page],
    queryFn: async () => {
      if (!currentUser) return [];
      const res = await apiRequest('GET', `/api/feed/${currentUser.id}?limit=${LIMIT}&offset=${page * LIMIT}`);
      return res.json();
    },
    enabled: !!currentUser,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const mergedEvents = useMemo(() => {
    if (!events) return [];
    return mergeEvents(events);
  }, [events]);

  const handleDialogChange = useCallback((open: boolean) => {
    if (!open) setSelectedUserId(null);
    setIsDialogOpen(open);
  }, []);

  if (!currentUser) return null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
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
    <div ref={scrollRef} className="space-y-2.5 pb-4">
      {mergedEvents.map((event) => (
        <EventCard key={event.id} event={event} currentUserId={currentUser.id} onUserClick={handleUserClick} />
      ))}

      {events.length >= LIMIT && (
        <div className="flex justify-center pt-1">
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => setPage(p => p + 1)}>
            Cargar más
          </Button>
        </div>
      )}

      <UserInfoDialog
        userId={selectedUserId}
        currentUserId={currentUser?.id}
        open={isDialogOpen}
        onOpenChange={handleDialogChange}
      />
    </div>
  );
}

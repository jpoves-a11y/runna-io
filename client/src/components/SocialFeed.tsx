import { useState, useRef, useEffect, useMemo, useCallback, memo } from 'react';
import { useQuery, useMutation, useInfiniteQuery } from '@tanstack/react-query';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useSession } from '@/hooks/use-session';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import UserInfoDialog from '@/components/UserInfoDialog';
import { FeedRouteAnimation } from '@/components/FeedRouteAnimation';
import {
  MapPin, Users, Swords, Trophy, MessageCircle, Send, Trash2, Loader2,
  Heart, ThumbsDown, CornerDownRight, Clock, Flame
} from 'lucide-react';
import type { FeedEventWithDetails, FeedCommentWithUser } from '@shared/schema';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ActivityMetadata {
  victims?: Array<{ userId: string; userName: string; userColor: string; stolenArea: number }>;
  ranTogetherWith?: Array<{ id: string; name: string }>;
  records?: Array<{ type: string; value: number }>;
  treasures?: Array<{ treasureId?: string; treasureName: string; powerType: string; rarity: string }>;
  fortressesDestroyed?: number;
  fortificationLayers?: number;
  fortificationArea?: number;
}

interface MergedFeedEvent extends FeedEventWithDetails {
  victims?: Array<{ id: string; name: string; color: string; avatar?: string | null; areaStolen: number }>;
  parsedMeta?: ActivityMetadata;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Parse metadata from activity events — new unified format */
function enrichEvents(events: FeedEventWithDetails[]): MergedFeedEvent[] {
  return events.map(event => {
    const enriched: MergedFeedEvent = { ...event };
    if (event.eventType === 'activity' && event.metadata) {
      try {
        const meta: ActivityMetadata = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata;
        enriched.parsedMeta = meta;
        // Build victims array for backward-compatible rendering
        if (meta.victims && meta.victims.length > 0) {
          enriched.victims = meta.victims.map(v => ({
            id: v.userId,
            name: v.userName,
            color: v.userColor,
            avatar: null,
            areaStolen: v.stolenArea,
          }));
        }
      } catch (_) {}
    }
    return enriched;
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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

function formatPace(distMeters: number, durSeconds: number): string | null {
  if (!distMeters || distMeters < 100) return null;
  const minPerKm = (durSeconds / 60) / (distMeters / 1000);
  if (minPerKm > 20 || minPerKm < 2) return null;
  const mins = Math.floor(minPerKm);
  const secs = Math.round((minPerKm - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, '0')} /km`;
}

function preciseTimeAgo(dateStr: string): string {
  try {
    const now = Date.now();
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
  if (km2 >= 0.05) return `${km2.toFixed(2)} km²`;
  return `${Math.round(sqMeters)} m²`;
}

// ─── UserAvatar ──────────────────────────────────────────────────────────────

const UserAvatar = memo(function UserAvatar({
  user,
  size = 'sm',
  onClick,
}: {
  user: { name: string; color: string; avatar?: string | null };
  size?: 'xs' | 'sm' | 'md';
  onClick?: () => void;
}) {
  const dims = { xs: 'w-6 h-6 text-[9px]', sm: 'w-8 h-8 text-[11px]', md: 'w-10 h-10 text-sm' };
  const ringPx = { xs: 1.5, sm: 2, md: 2.5 };
  const Wrapper = onClick ? 'button' : 'div';

  if (user.avatar) {
    return (
      <Wrapper onClick={onClick} className={`${dims[size]} rounded-full overflow-hidden flex-shrink-0 transition-transform active:scale-95`} style={{ boxShadow: `0 0 0 ${ringPx[size]}px ${user.color}` }}>
        <img src={user.avatar} alt={user.name} className="w-full h-full rounded-full object-cover" loading="lazy" decoding="async" />
      </Wrapper>
    );
  }
  return (
    <Wrapper onClick={onClick} className={`${dims[size]} rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 transition-transform active:scale-95`} style={{ backgroundColor: user.color }}>
      {user.name.charAt(0).toUpperCase()}
    </Wrapper>
  );
});

// ─── Like Button (Heart) ─────────────────────────────────────────────────────

const LikeButton = memo(function LikeButton({
  count, active, onClick,
}: { count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 py-1 transition-all duration-150 active:scale-90
        ${active ? 'text-red-500' : 'text-muted-foreground hover:text-red-400'}`}
    >
      <Heart className={`w-[22px] h-[22px] transition-transform duration-200 ${active ? 'fill-current scale-110' : 'scale-100'}`} />
      {count > 0 && <span className="text-[12px] font-medium tabular-nums">{count}</span>}
    </button>
  );
});

// ─── Dislike Button ──────────────────────────────────────────────────────────

const DislikeButton = memo(function DislikeButton({
  count, active, onClick,
}: { count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 py-1 transition-all duration-150 active:scale-90
        ${active ? 'text-orange-500' : 'text-muted-foreground hover:text-orange-400'}`}
    >
      <ThumbsDown className={`w-[22px] h-[22px] transition-transform duration-200 ${active ? 'fill-current scale-110' : 'scale-100'}`} />
      {count > 0 && <span className="text-[12px] font-medium tabular-nums">{count}</span>}
    </button>
  );
});

// ─── Emblem Showcase (premium glass shelf with glow + rays + sparkles) ──────

const EmblemShowcase = memo(function EmblemShowcase({
  src, alt, size = 'lg', accentColor = '#f59e0b', onClick,
}: { src: string; alt: string; size?: 'md' | 'lg'; accentColor?: string; onClick?: () => void }) {
  const dim = size === 'lg' ? 'w-24 h-24' : 'w-20 h-20';
  const shelfW = size === 'lg' ? 'w-32' : 'w-28';
  const rays = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  return (
    <button onClick={onClick} className="relative focus:outline-none group flex flex-col items-center pt-4 pb-1">
      {/* Outer glow pulse */}
      <div
        className="absolute top-2 left-1/2 -translate-x-1/2 w-28 h-28 rounded-full blur-3xl opacity-20 group-hover:opacity-50 transition-all duration-700 animate-pulse"
        style={{ background: `radial-gradient(circle, ${accentColor} 0%, transparent 70%)` }}
      />
      {/* Rays emanating from center */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 w-28 h-28 opacity-[0.08] group-hover:opacity-[0.25] transition-opacity duration-500 pointer-events-none">
        {rays.map(deg => (
          <div
            key={deg}
            className="absolute top-1/2 left-1/2 w-[1px] origin-bottom"
            style={{
              height: '55%',
              transform: `translate(-50%, -100%) rotate(${deg}deg)`,
              background: `linear-gradient(to top, ${accentColor}, transparent 80%)`,
            }}
          />
        ))}
      </div>
      {/* Inner ring glow */}
      <div
        className="absolute top-2 left-1/2 -translate-x-1/2 w-[90px] h-[90px] rounded-full opacity-0 group-hover:opacity-30 transition-opacity duration-500"
        style={{ boxShadow: `0 0 20px 4px ${accentColor}60, inset 0 0 15px 2px ${accentColor}30` }}
      />
      {/* Emblem image */}
      <img
        src={src}
        alt={alt}
        className={`${dim} object-contain relative z-10 transition-all duration-300 group-hover:scale-110 group-hover:drop-shadow-[0_0_20px_${accentColor}80] group-active:scale-95`}
        style={{ filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.4))' }}
      />
      {/* Glass shelf / pedestal */}
      <div className={`relative ${shelfW} mt-1`}>
        {/* Shelf surface */}
        <div
          className="h-[6px] rounded-full opacity-60 group-hover:opacity-90 transition-opacity duration-300"
          style={{
            background: `linear-gradient(180deg, ${accentColor}40 0%, ${accentColor}15 50%, transparent 100%)`,
            boxShadow: `0 2px 8px ${accentColor}30`,
          }}
        />
        {/* Reflection line */}
        <div
          className="absolute top-[2px] left-[10%] right-[10%] h-[1px] rounded-full opacity-40"
          style={{ background: `linear-gradient(90deg, transparent, ${accentColor}90, transparent)` }}
        />
        {/* Shelf glow underneath */}
        <div
          className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-[80%] h-[4px] rounded-full blur-sm opacity-30 group-hover:opacity-60 transition-opacity"
          style={{ background: accentColor }}
        />
      </div>
      {/* Floating sparkles */}
      <div className="absolute top-0 left-0 right-0 bottom-0 pointer-events-none overflow-hidden">
        <div
          className="absolute w-1 h-1 rounded-full opacity-0 group-hover:opacity-80 transition-opacity duration-500"
          style={{ background: accentColor, top: '15%', left: '20%', boxShadow: `0 0 4px ${accentColor}` }}
        />
        <div
          className="absolute w-0.5 h-0.5 rounded-full opacity-0 group-hover:opacity-60 transition-opacity duration-700"
          style={{ background: accentColor, top: '25%', right: '25%', boxShadow: `0 0 3px ${accentColor}` }}
        />
        <div
          className="absolute w-1 h-1 rounded-full opacity-0 group-hover:opacity-70 transition-opacity duration-600"
          style={{ background: accentColor, bottom: '35%', left: '15%', boxShadow: `0 0 4px ${accentColor}` }}
        />
      </div>
    </button>
  );
});

// ─── Emblems Section Title ──────────────────────────────────────────────────

const EmblemsSection = memo(function EmblemsSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 pt-3 border-t border-white/[0.04]">
      <div className="flex items-center justify-center gap-3 mb-2">
        <div className="h-[1px] flex-1 max-w-[40px] bg-gradient-to-r from-transparent to-amber-500/30" />
        <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-amber-500/70">✦ Emblemas ✦</span>
        <div className="h-[1px] flex-1 max-w-[40px] bg-gradient-to-l from-transparent to-amber-500/30" />
      </div>
      <div className="flex flex-wrap gap-4 justify-center items-start">
        {children}
      </div>
    </div>
  );
});

// ─── Mini Reaction (for comments) ────────────────────────────────────────────

const MiniReaction = memo(function MiniReaction({
  type, count, active, onClick,
}: { type: 'like' | 'dislike'; count: number; active: boolean; onClick: () => void }) {
  const Icon = type === 'like' ? Heart : ThumbsDown;
  const activeColor = type === 'like' ? 'text-red-500' : 'text-orange-500';
  const hoverColor = type === 'like' ? 'hover:text-red-400' : 'hover:text-orange-400';

  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded transition-all duration-100 active:scale-90
        ${active ? `${activeColor} font-semibold` : `text-muted-foreground ${hoverColor}`}`}
    >
      <Icon className={`w-3 h-3 ${active ? 'fill-current' : ''}`} />
      {count > 0 && <span className="text-[10px]">{count}</span>}
    </button>
  );
});

// ─── Comment Row ─────────────────────────────────────────────────────────────

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
    <div className={`flex items-start gap-2 ${isReply ? 'ml-6 mt-1' : 'mt-2 first:mt-0'}`}>
      <UserAvatar
        user={{ name: user.name, color: user.color || '#888', avatar: user.avatar }}
        size="xs"
        onClick={() => onUserClick(user.id)}
      />
      <div className="flex-1 min-w-0">
        {/* Inline: name + content on same line */}
        <p className="text-[12px] text-foreground/80 break-words leading-snug">
          <button
            className="font-bold hover:underline mr-1"
            style={{ color: user.color || undefined }}
            onClick={() => onUserClick(user.id)}
          >
            {user.name}
          </button>
          {renderMentionedText(comment.content)}
          <span className="text-[9px] text-muted-foreground/50 ml-1.5">{preciseTimeAgo(comment.createdAt)}</span>
        </p>
        {/* Meta row */}
        <div className="flex items-center gap-2 mt-0.5">
          <MiniReaction type="like" count={comment.likeCount} active={comment.userReaction === 'like'} onClick={() => onReaction(comment.id, 'like')} />
          <MiniReaction type="dislike" count={comment.dislikeCount} active={comment.userReaction === 'dislike'} onClick={() => onReaction(comment.id, 'dislike')} />
          {!isReply && (
            <button className="text-[9px] text-muted-foreground/60 hover:text-foreground font-semibold transition-colors" onClick={() => onReply(comment.id, user.name)}>
              Responder
            </button>
          )}
          {comment.userId === currentUserId && (
            <button className="text-muted-foreground/40 hover:text-red-400 ml-auto transition-colors active:scale-75" onClick={() => onDelete(comment.id)}>
              <Trash2 className="w-2.5 h-2.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

// ─── Event Card ──────────────────────────────────────────────────────────────

const EventCard = memo(function EventCard({
  event, currentUserId, onUserClick,
}: {
  event: MergedFeedEvent;
  currentUserId: string;
  onUserClick: (userId: string) => void;
}) {
  const [showComments, setShowComments] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; name: string } | null>(null);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionCursorPos, setMentionCursorPos] = useState(0);
  const [expandedEmblems, setExpandedEmblems] = useState<Set<string>>(new Set());
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Truly instant optimistic reaction state ──
  const [localLikeCount, setLocalLikeCount] = useState(event.likeCount);
  const [localDislikeCount, setLocalDislikeCount] = useState(event.dislikeCount);
  const [localUserReaction, setLocalUserReaction] = useState(event.userReaction);

  // Optimistic comment reactions
  const [commentReactionCache, setCommentReactionCache] = useState<Map<string, { likeCount: number; dislikeCount: number; userReaction: 'like' | 'dislike' | null }>>(new Map());

  // Only re-sync from server when event ID changes (not on every background refetch)
  const lastEventIdRef = useRef(event.id);
  useEffect(() => {
    if (event.id !== lastEventIdRef.current) {
      lastEventIdRef.current = event.id;
      setLocalLikeCount(event.likeCount);
      setLocalDislikeCount(event.dislikeCount);
      setLocalUserReaction(event.userReaction);
    }
  }, [event.id, event.likeCount, event.dislikeCount, event.userReaction]);

  // ── Data queries ──
  const { data: friends } = useQuery<Array<{ id: string; name: string; username: string; color: string; avatar?: string | null }>>({
    queryKey: ['/api/friends', currentUserId],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/friends/${currentUserId}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  });

  // Preview comments — always load if there are comments (shown collapsed)
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

  // Full comments on demand
  const { data: allComments, isLoading: loadingComments } = useQuery<FeedCommentWithUser[]>({
    queryKey: ['/api/feed/events', event.id, 'comments', currentUserId],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/feed/events/${event.id}/comments?userId=${currentUserId}`);
      return res.json();
    },
    enabled: showComments,
  });

  // ── Mutations ──
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
    },
  });

  const reactionMutation = useMutation({
    mutationFn: async ({ targetType, targetId, reactionType }: { targetType: 'event' | 'comment'; targetId: string; reactionType: 'like' | 'dislike' }) => {
      const res = await apiRequest('POST', '/api/feed/reactions', { userId: currentUserId, targetType, targetId, reactionType });
      return res.json();
    },
    // No onSuccess invalidation — trust optimistic state; rollback on error
    onError: (_err, variables) => {
      if (variables.targetType === 'event') {
        setLocalLikeCount(event.likeCount);
        setLocalDislikeCount(event.dislikeCount);
        setLocalUserReaction(event.userReaction);
      }
    },
  });

  // ── Handlers ──
  const handlePostReaction = useCallback((reactionType: 'like' | 'dislike') => {
    setLocalUserReaction(prev => {
      if (prev === reactionType) {
        if (reactionType === 'like') setLocalLikeCount(c => Math.max(0, c - 1));
        else setLocalDislikeCount(c => Math.max(0, c - 1));
        return null;
      } else {
        if (prev === 'like') setLocalLikeCount(c => Math.max(0, c - 1));
        if (prev === 'dislike') setLocalDislikeCount(c => Math.max(0, c - 1));
        if (reactionType === 'like') setLocalLikeCount(c => c + 1);
        else setLocalDislikeCount(c => c + 1);
        return reactionType;
      }
    });
    reactionMutation.mutate({ targetType: 'event', targetId: event.id, reactionType });
  }, [event.id, reactionMutation]);

  const handleCommentReaction = useCallback((targetId: string, reactionType: 'like' | 'dislike') => {
    setCommentReactionCache(prev => {
      const next = new Map(prev);
      const current = next.get(targetId);
      if (current) {
        const updated = { ...current };
        if (updated.userReaction === reactionType) {
          updated.userReaction = null;
          if (reactionType === 'like') updated.likeCount = Math.max(0, updated.likeCount - 1);
          else updated.dislikeCount = Math.max(0, updated.dislikeCount - 1);
        } else {
          if (updated.userReaction === 'like') updated.likeCount = Math.max(0, updated.likeCount - 1);
          if (updated.userReaction === 'dislike') updated.dislikeCount = Math.max(0, updated.dislikeCount - 1);
          updated.userReaction = reactionType;
          if (reactionType === 'like') updated.likeCount++;
          else updated.dislikeCount++;
        }
        next.set(targetId, updated);
      } else {
        next.set(targetId, {
          likeCount: reactionType === 'like' ? 1 : 0,
          dislikeCount: reactionType === 'dislike' ? 1 : 0,
          userReaction: reactionType,
        });
      }
      return next;
    });
    reactionMutation.mutate({ targetType: 'comment', targetId, reactionType });
  }, [reactionMutation]);

  const applyCommentCache = useCallback((comment: FeedCommentWithUser): FeedCommentWithUser => {
    const cached = commentReactionCache.get(comment.id);
    if (cached) return { ...comment, likeCount: cached.likeCount, dislikeCount: cached.dislikeCount, userReaction: cached.userReaction };
    return comment;
  }, [commentReactionCache]);

  // Init cache when comments load
  useEffect(() => {
    const comments = showComments ? allComments : previewComments;
    if (!comments) return;
    setCommentReactionCache(prev => {
      const next = new Map(prev);
      const init = (c: FeedCommentWithUser) => {
        if (!next.has(c.id)) next.set(c.id, { likeCount: c.likeCount, dislikeCount: c.dislikeCount, userReaction: c.userReaction });
        c.replies?.forEach(init);
      };
      comments.forEach(init);
      return next;
    });
  }, [allComments, previewComments, showComments]);

  const handleReply = useCallback((commentId: string, userName: string) => {
    setReplyTo({ id: commentId, name: userName });
    if (!showComments) setShowComments(true);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [showComments]);

  const insertMention = useCallback((friendName: string) => {
    const beforeCursor = commentText.substring(0, mentionCursorPos);
    const atIndex = beforeCursor.lastIndexOf('@');
    if (atIndex === -1) return;
    setCommentText(`${commentText.substring(0, atIndex)}@${friendName} ${commentText.substring(mentionCursorPos)}`);
    setShowMentions(false);
    setMentionFilter('');
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [commentText, mentionCursorPos]);

  const toggleEmblem = useCallback((key: string) => {
    setExpandedEmblems(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const handleCommentChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart || value.length;
    setCommentText(value);
    setMentionCursorPos(cursorPos);
    const atMatch = value.substring(0, cursorPos).match(/@([\w\u00C0-\u024F]*)$/);
    if (atMatch) { setMentionFilter(atMatch[1].toLowerCase()); setShowMentions(true); }
    else { setShowMentions(false); setMentionFilter(''); }
  }, []);

  const renderMentionedText = useCallback((text: string) => {
    return text.split(/(@[\w\u00C0-\u024F]+(?:\s[\w\u00C0-\u024F]+)?)/).map((part, i) => {
      if (part.startsWith('@')) {
        const mentionName = part.slice(1).toLowerCase();
        const matched = friends?.find(f => f.name.toLowerCase() === mentionName || f.username.toLowerCase() === mentionName);
        return <span key={i} className="text-blue-500 font-semibold cursor-pointer hover:underline" onClick={() => matched && onUserClick(matched.id)}>{part}</span>;
      }
      return part;
    });
  }, [friends, onUserClick]);

  // ── Derived values ──
  const isSystemEvent = event.eventType === 'treasure_spawned';
  const isOwn = !isSystemEvent && event.userId === currentUserId;
  // Show nickname if the user has one (from the enriched data)
  const userDisplayName = (() => {
    if (isSystemEvent) return '🏴‍☠️ Runna';
    if (isOwn) return 'Tú';
    const u = event.user as any;
    if (u.nickname) return `🎭 ${u.nickname}`;
    return event.user.name;
  })();
  const userName = userDisplayName;
  const userRealName = (event.user as any).nickname ? event.user.name : null;
  const victims = (event as MergedFeedEvent).victims || [];
  const routeCoords = (event as any).routeCoordinates as [number, number][] | null | undefined;
  const pace = event.distance && event.duration ? formatPace(event.distance, event.duration) : null;
  const displayedComments = showComments ? allComments : previewComments;

  // Event type icon + bg — conquest badge when activity has stolen territory or metadata
  const hasBadges = victims.length > 0 || !!(event as MergedFeedEvent).parsedMeta?.victims?.length || !!(event as MergedFeedEvent).parsedMeta?.records?.length || !!(event as MergedFeedEvent).parsedMeta?.treasures?.length || !!(event as MergedFeedEvent).parsedMeta?.fortressesDestroyed || !!(event as MergedFeedEvent).parsedMeta?.fortificationLayers;
  const eventTypeBadge = useMemo(() => {
    if (event.eventType === 'activity' && (victims.length > 0 || !!(event as MergedFeedEvent).parsedMeta?.victims?.length)) {
      return { icon: <img src="/emblemas/Emblema_robo.png" alt="" className="w-5 h-5 object-contain" />, bg: 'bg-red-500/10' };
    }
    const map: Record<string, { icon: React.ReactNode; bg: string }> = {
      activity: { icon: <Flame className="w-3.5 h-3.5" />, bg: 'bg-primary/10 text-primary' },
      territory_stolen: { icon: <img src="/emblemas/Emblema_robo.png" alt="" className="w-5 h-5 object-contain" />, bg: 'bg-red-500/10' },
      ran_together: { icon: <img src="/emblemas/Emblema_amigos.png" alt="" className="w-5 h-5 object-contain" />, bg: 'bg-blue-500/10' },
      personal_record: { icon: <img src="/emblemas/Emblema_ritmo.png" alt="" className="w-5 h-5 object-contain" />, bg: 'bg-amber-500/10' },
      treasure_found: { icon: <img src="/cofre_epic.png" alt="" className="w-5 h-5 object-contain" />, bg: 'bg-purple-500/10' },
      treasure_spawned: { icon: <img src="/cofre_rare.png" alt="" className="w-5 h-5 object-contain" />, bg: 'bg-emerald-500/10' },
      nickname_changed: { icon: <span className="text-base">🎭</span>, bg: 'bg-pink-500/10' },
    };
    return map[event.eventType] || { icon: null, bg: 'bg-muted text-muted-foreground' };
  }, [event.eventType, victims.length]);

  // ── Render content by type ──
  const renderContent = () => {
    const meta = (event as MergedFeedEvent).parsedMeta;
    switch (event.eventType) {
      case 'activity':
        return (
          <>
            {/* Route animation hero with stats overlay */}
            {routeCoords && routeCoords.length >= 2 ? (
              <div className="mt-1.5 rounded-xl overflow-hidden ring-1 ring-white/[0.06]">
                <FeedRouteAnimation coordinates={routeCoords} userColor={event.user.color || '#16a34a'} height={150}>
                  {/* Stats overlay on bottom of map */}
                  {(event.distance || event.duration || pace) && (
                    <div className="absolute bottom-0 left-0 right-0 z-[400] bg-black/50 backdrop-blur-md border-t border-white/[0.06]">
                      <div className="flex items-center justify-around py-1.5 px-2">
                        {event.distance ? (
                          <div className="text-center">
                            <p className="text-[13px] font-bold text-primary leading-none">{formatDistance(event.distance)}</p>
                            <p className="text-[7px] text-white/50 uppercase tracking-widest mt-0.5">Dist</p>
                          </div>
                        ) : null}
                        {event.duration ? (
                          <div className="text-center">
                            <p className="text-[13px] font-bold text-white/90 leading-none">{formatDuration(event.duration)}</p>
                            <p className="text-[7px] text-white/50 uppercase tracking-widest mt-0.5">Duración</p>
                          </div>
                        ) : null}
                        {pace ? (
                          <div className="text-center">
                            <p className="text-[13px] font-bold text-orange-400 leading-none">{pace}</p>
                            <p className="text-[7px] text-white/50 uppercase tracking-widest mt-0.5">Ritmo</p>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )}
                </FeedRouteAnimation>
              </div>
            ) : (event.distance || event.duration || pace) ? (
              /* Stats without map — compact inline */
              <div className="flex items-center gap-3 mt-1.5 py-1.5 px-3 rounded-lg bg-white/[0.03] border border-white/[0.04]">
                {event.distance ? (
                  <div className="text-center flex-1">
                    <p className="text-[13px] font-bold text-primary leading-none">{formatDistance(event.distance)}</p>
                    <p className="text-[7px] text-muted-foreground uppercase tracking-widest mt-0.5">Dist</p>
                  </div>
                ) : null}
                {event.duration ? (
                  <div className="text-center flex-1">
                    <p className="text-[13px] font-bold text-foreground/85 leading-none">{formatDuration(event.duration)}</p>
                    <p className="text-[7px] text-muted-foreground uppercase tracking-widest mt-0.5">Duración</p>
                  </div>
                ) : null}
                {pace ? (
                  <div className="text-center flex-1">
                    <p className="text-[13px] font-bold text-orange-400 leading-none">{pace}</p>
                    <p className="text-[7px] text-muted-foreground uppercase tracking-widest mt-0.5">Ritmo</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* New area conquered */}
            {Number(event.newArea) > 0 && (
              <div className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/10 text-[11px] font-semibold text-emerald-500">
                <MapPin className="w-3 h-3" />
                +{formatArea(event.newArea!)}
              </div>
            )}

            {/* Emblems Gallery */}
            {(victims.length > 0 || (meta?.ranTogetherWith && meta.ranTogetherWith.length > 0) || (meta?.records && meta.records.length > 0) || (meta?.treasures && meta.treasures.length > 0)) && (
              <EmblemsSection>
                {/* Victims emblem */}
                {victims.length > 0 && (
                  <div className="flex flex-col items-center">
                    <EmblemShowcase src="/emblemas/Emblema_robo.png" alt="Territorio robado" size="md" accentColor="#ef4444" onClick={() => toggleEmblem('victims')} />
                    {expandedEmblems.has('victims') && (
                      <div className="mt-2 w-full max-w-[200px] rounded-lg border border-red-500/10 bg-red-500/[0.03] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
                        <div className="px-2.5 pt-2 pb-1">
                          <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider">Territorio robado</span>
                        </div>
                        <div className="px-2.5 pb-2 space-y-0.5">
                          {victims.map(v => (
                            <div key={v.id} className="flex items-center gap-1.5 py-0.5">
                              <UserAvatar user={{ name: v.name, color: v.color, avatar: v.avatar }} size="xs" onClick={() => onUserClick(v.id)} />
                              <button className="text-[11px] font-semibold hover:underline flex-1 text-left truncate" style={{ color: v.color }} onClick={() => onUserClick(v.id)}>
                                {v.id === currentUserId ? 'Ti' : v.name}
                              </button>
                              <span className="text-[10px] font-bold text-red-500/80 tabular-nums">{formatArea(v.areaStolen)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Ran together emblem */}
                {meta?.ranTogetherWith && meta.ranTogetherWith.length > 0 && (
                  <div className="flex flex-col items-center">
                    <EmblemShowcase src="/emblemas/Emblema_amigos.png" alt="Corrieron juntos" size="md" accentColor="#3b82f6" onClick={() => toggleEmblem('ranTogether')} />
                    {expandedEmblems.has('ranTogether') && (
                      <div className="mt-2 w-full max-w-[200px] rounded-lg border border-blue-500/10 bg-blue-500/[0.03] p-2.5 animate-in fade-in slide-in-from-top-2 duration-200">
                        <span className="text-[10px] font-bold text-blue-500 uppercase tracking-wider">Corrieron juntos</span>
                        <p className="text-[12px] text-foreground/75 leading-snug mt-1">
                          {meta.ranTogetherWith.map((u, i) => (
                            <span key={u.id}>
                              {i > 0 && (i === meta.ranTogetherWith!.length - 1 ? ' y ' : ', ')}
                              <button className="font-semibold hover:underline" onClick={() => onUserClick(u.id)}>
                                {u.id === currentUserId ? 'Ti' : u.name}
                              </button>
                            </span>
                          ))}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Personal records emblems */}
                {meta?.records && meta.records.length > 0 && meta.records.map((rec, i) => {
                  const emblemMap: Record<string, string> = {
                    longest_run: '/emblemas/Emblema_distancia.png',
                    fastest_pace: '/emblemas/Emblema_ritmo.png',
                    biggest_conquest: '/emblemas/Emblema_robo.png',
                  };
                  const label = rec.type === 'longest_run' ? 'Carrera más larga' :
                    rec.type === 'fastest_pace' ? 'Ritmo más rápido' :
                    rec.type === 'biggest_conquest' ? 'Mayor conquista' : 'Récord';
                  let detail = '';
                  if (rec.type === 'longest_run') detail = formatDistance(rec.value);
                  else if (rec.type === 'fastest_pace') {
                    const mins = Math.floor(rec.value);
                    const secs = Math.round((rec.value - mins) * 60);
                    detail = `${mins}:${secs.toString().padStart(2, '0')} /km`;
                  } else if (rec.type === 'biggest_conquest') {
                    detail = formatArea(rec.value);
                  }
                  const key = `record-${i}`;
                  return (
                    <div key={`rec-${i}`} className="flex flex-col items-center">
                      <EmblemShowcase src={emblemMap[rec.type] || '/emblemas/Emblema_distancia.png'} alt={label} size="md" accentColor="#f59e0b" onClick={() => toggleEmblem(key)} />
                      {expandedEmblems.has(key) && (
                        <div className="mt-1.5 text-center animate-in fade-in slide-in-from-top-2 duration-200">
                          <span className="text-[10px] font-bold text-amber-500 uppercase tracking-wider">{label}</span>
                          {detail && <p className="text-[13px] font-bold text-amber-400">{detail}</p>}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Treasures emblems */}
                {meta?.treasures && meta.treasures.length > 0 && meta.treasures.map((t, i) => {
                  const rarityColors: Record<string, string> = {
                    common: 'text-gray-400',
                    rare: 'text-blue-400',
                    epic: 'text-purple-400',
                    legendary: 'text-amber-400',
                  };
                  const key = `treasure-${i}`;
                  return (
                    <div key={`tre-${i}`} className="flex flex-col items-center">
                      <EmblemShowcase src="/emblemas/Emblema_tesoro.png" alt="Tesoro" size="md" accentColor="#a855f7" onClick={() => toggleEmblem(key)} />
                      {expandedEmblems.has(key) && (
                        <div className="mt-1.5 text-center animate-in fade-in slide-in-from-top-2 duration-200">
                          <p className="text-[11px] font-semibold text-foreground/80">{t.treasureName || 'Tesoro'}</p>
                          <span className={`text-[10px] font-bold uppercase tracking-wider ${rarityColors[t.rarity] || rarityColors.common}`}>
                            {t.rarity}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </EmblemsSection>
            )}

            {/* Fortresses destroyed badge */}
            {meta?.fortressesDestroyed && meta.fortressesDestroyed > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold border text-orange-400 bg-orange-500/10 border-orange-500/10">
                  <span>🏰</span>
                  <span>Rompió {meta.fortressesDestroyed} fortaleza{meta.fortressesDestroyed > 1 ? 's' : ''}</span>
                </div>
              </div>
            )}

            {/* Fortification reinforced badge */}
            {meta?.fortificationLayers && meta.fortificationLayers > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold border text-sky-400 bg-sky-500/10 border-sky-500/10">
                  <span>🧱</span>
                  <span>Reforzó {meta.fortificationArea && meta.fortificationArea >= 1000000 ? `${(meta.fortificationArea / 1000000).toFixed(2)} km²` : meta.fortificationArea ? `${Math.round(meta.fortificationArea)} m²` : ''} de territorio (+{meta.fortificationLayers} {meta.fortificationLayers > 1 ? 'capas' : 'capa'})</span>
                </div>
              </div>
            )}
          </>
        );

      case 'territory_stolen':
        return (
          <>
            <div className="mt-2 flex flex-col items-center">
              <EmblemShowcase src="/emblemas/Emblema_robo.png" alt="Robo de territorio" size="lg" accentColor="#ef4444" onClick={() => toggleEmblem('ev-stolen')} />
              {expandedEmblems.has('ev-stolen') && (
                <div className="mt-2 w-full rounded-lg border border-red-500/10 bg-red-500/[0.03] p-2.5 animate-in fade-in slide-in-from-top-2 duration-200">
                  <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider">Robo</span>
                  <p className="text-[12px] text-foreground/75 leading-snug mt-0.5">
                    Ha robado territorio a{' '}
                    <button className="font-semibold hover:underline" style={{ color: event.victim?.color }} onClick={() => event.victim && onUserClick(event.victim.id)}>
                      {event.victim?.id === currentUserId ? 'ti' : event.victim?.name || 'alguien'}
                    </button>
                  </p>
                  {event.areaStolen && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 mt-1.5 rounded-full bg-red-500/10 text-[10px] font-semibold text-red-400">
                      <Swords className="w-3 h-3" />{formatArea(event.areaStolen)}
                    </span>
                  )}
                </div>
              )}
            </div>
            {routeCoords && routeCoords.length >= 2 && (
              <div className="mt-2 rounded-xl overflow-hidden ring-1 ring-white/[0.06]">
                <FeedRouteAnimation coordinates={routeCoords} userColor={event.user.color || '#dc2626'} height={130} />
              </div>
            )}
          </>
        );

      case 'ran_together': {
        let ranWith: Array<{ id: string; name: string }> = [];
        try { ranWith = event.ranTogetherWith ? JSON.parse(event.ranTogetherWith) : []; } catch { }
        return (
          <>
            <div className="mt-2 flex flex-col items-center">
              <EmblemShowcase src="/emblemas/Emblema_amigos.png" alt="Corrieron juntos" size="lg" accentColor="#3b82f6" onClick={() => toggleEmblem('ev-ran')} />
              {expandedEmblems.has('ev-ran') && (
                <div className="mt-2 w-full rounded-lg border border-blue-500/10 bg-blue-500/[0.03] p-2.5 animate-in fade-in slide-in-from-top-2 duration-200">
                  <span className="text-[10px] font-bold text-blue-500 uppercase tracking-wider">Corrieron juntos</span>
                  <p className="text-[12px] text-foreground/75 leading-snug mt-0.5">
                    {ranWith.map((u, i) => (
                      <span key={u.id}>
                        {i > 0 && (i === ranWith.length - 1 ? ' y ' : ', ')}
                        <button className="font-semibold hover:underline" onClick={() => onUserClick(u.id)}>
                          {u.id === currentUserId ? 'Ti' : u.name}
                        </button>
                      </span>
                    ))}
                  </p>
                  {event.distance && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 mt-1.5 rounded-full bg-blue-500/10 text-[10px] font-semibold text-blue-400">
                      <MapPin className="w-3 h-3" />{formatDistance(event.distance)}
                    </span>
                  )}
                </div>
              )}
            </div>
            {routeCoords && routeCoords.length >= 2 && (
              <div className="mt-2 rounded-xl overflow-hidden ring-1 ring-white/[0.06]">
                <FeedRouteAnimation coordinates={routeCoords} userColor={event.user.color || '#3b82f6'} height={130} />
              </div>
            )}
          </>
        );
      }

      case 'personal_record': {
        const emblemMap: Record<string, string> = {
          longest_run: '/emblemas/Emblema_distancia.png',
          fastest_pace: '/emblemas/Emblema_ritmo.png',
          biggest_conquest: '/emblemas/Emblema_robo.png',
        };
        const recordLabel = event.recordType === 'longest_run' ? 'Carrera más larga' :
          event.recordType === 'fastest_pace' ? 'Ritmo más rápido' :
            event.recordType === 'biggest_conquest' ? 'Mayor conquista' : 'Récord';
        let recordDetail = '';
        if (event.recordValue) {
          if (event.recordType === 'longest_run') {
            recordDetail = formatDistance(event.recordValue);
          } else if (event.recordType === 'fastest_pace') {
            const mins = Math.floor(event.recordValue);
            const secs = Math.round((event.recordValue - mins) * 60);
            recordDetail = `${mins}:${secs.toString().padStart(2, '0')} min/km`;
          } else if (event.recordType === 'biggest_conquest') {
            recordDetail = formatArea(event.recordValue);
          }
        }
        return (
          <>
            <div className="mt-2 flex flex-col items-center">
              <EmblemShowcase src={emblemMap[event.recordType || ''] || '/emblemas/Emblema_distancia.png'} alt="Récord" size="lg" accentColor="#f59e0b" onClick={() => toggleEmblem('ev-record')} />
              {expandedEmblems.has('ev-record') && (
                <div className="mt-2 text-center animate-in fade-in slide-in-from-top-2 duration-200">
                  <p className="text-[13px] font-bold text-foreground/90">¡Récord personal!</p>
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 mt-1 rounded-full bg-amber-500/10 text-[10px] font-semibold text-amber-400">
                    {recordLabel}
                  </span>
                  {recordDetail && (
                    <p className="text-[14px] font-bold text-amber-400 mt-1">{recordDetail}</p>
                  )}
                </div>
              )}
            </div>
            {routeCoords && routeCoords.length >= 2 && (
              <div className="mt-2 rounded-xl overflow-hidden ring-1 ring-white/[0.06]">
                <FeedRouteAnimation coordinates={routeCoords} userColor={event.user.color || '#f59e0b'} height={130} />
              </div>
            )}
          </>
        );
      }

      case 'treasure_found': {
        let treasureInfo: any = {};
        try {
          if (event.metadata) {
            treasureInfo = JSON.parse(event.metadata as string);
          } else if (event.recordType) {
            treasureInfo = { rarity: event.recordType };
          }
        } catch {}
        const rarityColors: Record<string, string> = {
          common: 'text-gray-400 bg-gray-500/10',
          rare: 'text-blue-400 bg-blue-500/10',
          epic: 'text-purple-400 bg-purple-500/10',
          legendary: 'text-amber-400 bg-amber-500/10',
        };
        const rarityClass = rarityColors[treasureInfo.rarity] || rarityColors.common;
        const chestImage = `/cofre_${treasureInfo.rarity || 'common'}.png`;
        return (
          <div className="mt-2 flex flex-col items-center">
            <img src={chestImage} alt="Cofre" className="w-20 h-20 object-contain drop-shadow-lg" />
            <div className="mt-2 text-center">
              <p className="text-[13px] font-bold text-foreground/90">¡Tesoro encontrado!</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{treasureInfo.emoji || '📦'} {treasureInfo.treasureName || 'Tesoro misterioso'}</p>
              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 mt-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${rarityClass}`}>
                {treasureInfo.rarity || 'common'}
              </span>
              {treasureInfo.zone && (
                <p className="text-[10px] text-muted-foreground/70 mt-1">📍 {treasureInfo.zone}</p>
              )}
            </div>
          </div>
        );
      }

      case 'treasure_spawned': {
        let treasureInfo: any = {};
        try {
          if (event.metadata) {
            treasureInfo = JSON.parse(event.metadata as string);
          }
        } catch {}
        const spawnRarityColors: Record<string, string> = {
          common: 'text-gray-400 bg-gray-500/10 border-gray-500/20',
          rare: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
          epic: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
          legendary: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
        };
        const spawnRarityClass = spawnRarityColors[treasureInfo.rarity] || spawnRarityColors.common;
        const spawnChestImage = `/cofre_${treasureInfo.rarity || 'common'}.png`;
        return (
          <div className="mt-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <div className="flex items-center gap-3">
              <img src={spawnChestImage} alt="Cofre" className="w-16 h-16 object-contain drop-shadow-lg animate-bounce" style={{ animationDuration: '2s' }} />
              <div className="flex-1">
                <p className="text-[14px] font-bold text-emerald-400">¡Nuevo tesoro en el mapa!</p>
                <p className="text-[12px] text-muted-foreground mt-0.5">{treasureInfo.emoji || '📦'} {treasureInfo.treasureName || 'Tesoro misterioso'}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${spawnRarityClass}`}>
                    {treasureInfo.rarity || 'common'}
                  </span>
                  {treasureInfo.zone && (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground/80">
                      📍 {treasureInfo.zone}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      }

      case 'nickname_changed': {
        let nicknameInfo: any = {};
        try {
          if (event.metadata) {
            nicknameInfo = JSON.parse(event.metadata as string);
          }
        } catch {}
        const victimName = nicknameInfo.targetName || (event.victim?.name) || 'un jugador';
        const newNickname = nicknameInfo.nickname || '???';
        return (
          <div className="mt-2 flex flex-col items-center">
            <div className="text-5xl mb-2">🎭</div>
            <div className="text-center">
              <p className="text-[13px] font-bold text-pink-400">¡Nuevo apodo!</p>
              <p className="text-[12px] text-foreground/80 mt-1">
                {isOwn ? 'Has puesto' : <span style={{ color: event.user.color }}>{event.user.name}</span>}{' '}
                {isOwn ? '' : 'ha puesto '}el apodo{' '}
                <span className="font-bold text-pink-400">"{newNickname}"</span>{' '}
                a <span className="font-semibold">{victimName}</span>
              </p>
              <p className="text-[10px] text-muted-foreground/60 mt-1">Durará 48 horas</p>
            </div>
          </div>
        );
      }

      default:
        return null;
    }
  };

  // ── Main card render ──
  return (
    <article className="border-b border-white/[0.04]">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-3.5 pt-2.5 pb-1.5">
        <UserAvatar user={event.user} size="md" onClick={() => onUserClick(event.userId)} />
        <div className="flex-1 min-w-0">
          <button className="text-[13px] font-bold hover:underline truncate block text-left leading-tight" style={{ color: (event.user as any).nickname ? '#ec4899' : event.user.color }} onClick={() => onUserClick(event.userId)}>
            {userName}
          </button>
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60 leading-tight">
            {userRealName && <span className="text-pink-400/50">(antes: {userRealName})</span>}
            {userRealName && <span className="opacity-40">·</span>}
            <span>{preciseTimeAgo(event.activityDate || event.createdAt)}</span>
            {event.routeName && (
              <><span className="opacity-40">·</span><span className="truncate">{event.routeName}</span></>
            )}
          </div>
        </div>
        <div className={`flex items-center justify-center w-7 h-7 rounded-lg ${eventTypeBadge.bg}`}>
          {eventTypeBadge.icon}
        </div>
      </div>

      {/* Body */}
      <div className="px-3.5 pb-2">
        {renderContent()}
      </div>

      {/* Action bar */}
      <div className="flex items-center px-3.5 py-1.5">
        <div className="flex items-center gap-5">
          <LikeButton count={localLikeCount} active={localUserReaction === 'like'} onClick={() => handlePostReaction('like')} />
          <DislikeButton count={localDislikeCount} active={localUserReaction === 'dislike'} onClick={() => handlePostReaction('dislike')} />
        </div>
        <button
          onClick={() => { const next = !showComments; setShowComments(next); if (next) setTimeout(() => inputRef.current?.focus(), 100); }}
          className="inline-flex items-center gap-1 py-1 text-muted-foreground hover:text-foreground transition-colors ml-auto"
        >
          <MessageCircle className="w-[22px] h-[22px]" />
          {event.commentCount > 0 && <span className="text-[12px] font-medium tabular-nums">{event.commentCount}</span>}
        </button>
      </div>

      {/* Comment previews (collapsed) */}
      {!showComments && previewComments && previewComments.length > 0 && (
        <div className="px-3.5 pb-2 space-y-0.5">
          {event.commentCount > 2 && (
            <button onClick={() => setShowComments(true)} className="text-[11px] text-muted-foreground/60 hover:text-foreground font-medium transition-colors">
              Ver los {event.commentCount} comentarios
            </button>
          )}
          {previewComments.slice(0, 2).map(c => (
            <div key={c.id} className="text-[12px] leading-snug">
              <button className="font-bold hover:underline mr-1" style={{ color: (c.user as any).color }} onClick={() => onUserClick(c.userId)}>
                {(c.user as any).name}
              </button>
              <span className="text-foreground/70">{c.content}</span>
            </div>
          ))}
        </div>
      )}

      {/* Expanded comments */}
      {showComments && (
        <div>
          {displayedComments && displayedComments.length > 0 && (
            <div className="px-3.5 pt-1.5 pb-0.5">
              {displayedComments.map(comment => {
                const cached = applyCommentCache(comment);
                return (
                  <div key={comment.id}>
                    <CommentRow
                      comment={cached}
                      currentUserId={currentUserId}
                      onReply={handleReply}
                      onDelete={(id) => deleteCommentMutation.mutate(id)}
                      onUserClick={onUserClick}
                      onReaction={handleCommentReaction}
                      renderMentionedText={renderMentionedText}
                    />
                    {comment.replies && comment.replies.length > 0 && (
                      <div className="ml-6 mt-0.5 pl-2 border-l border-white/[0.06]">
                        {comment.replies.map(reply => {
                          const cachedReply = applyCommentCache(reply);
                          return (
                            <CommentRow
                              key={reply.id}
                              comment={cachedReply}
                              isReply
                              currentUserId={currentUserId}
                              onReply={handleReply}
                              onDelete={(id) => deleteCommentMutation.mutate(id)}
                              onUserClick={onUserClick}
                              onReaction={handleCommentReaction}
                              renderMentionedText={renderMentionedText}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {loadingComments && (
            <div className="flex justify-center py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
            </div>
          )}

          {/* Comment input */}
          <div className="px-3.5 py-2">
            {replyTo && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1.5">
                <CornerDownRight className="w-2.5 h-2.5 flex-shrink-0" />
                <span>Respondiendo a <span className="font-semibold">{replyTo.name}</span></span>
                <button onClick={() => setReplyTo(null)} className="ml-1 hover:text-foreground text-[12px] leading-none">✕</button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <Input
                  ref={inputRef}
                  placeholder={replyTo ? 'Respuesta...' : 'Comentar...'}
                  value={commentText}
                  onChange={handleCommentChange}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && commentText.trim() && !showMentions) addCommentMutation.mutate();
                    if (e.key === 'Escape' && showMentions) setShowMentions(false);
                  }}
                  className="h-8 text-[12px] bg-white/[0.03] border-white/[0.06] rounded-full px-3.5 placeholder:text-muted-foreground/40"
                  maxLength={500}
                />
                {showMentions && friends && friends.length > 0 && (() => {
                  const filtered = friends.filter(f => f.name.toLowerCase().includes(mentionFilter) || f.username.toLowerCase().includes(mentionFilter)).slice(0, 5);
                  return filtered.length > 0 ? (
                    <div className="absolute bottom-full left-0 right-0 mb-1 bg-card border border-white/[0.08] rounded-lg shadow-xl max-h-36 overflow-y-auto z-50">
                      {filtered.map(f => (
                        <button key={f.id} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 text-left text-[12px] transition-colors"
                          onMouseDown={(e) => { e.preventDefault(); insertMention(f.name); }}>
                          <UserAvatar user={{ name: f.name, color: f.color, avatar: f.avatar }} size="xs" />
                          <span className="font-semibold">{f.name}</span>
                          <span className="text-muted-foreground/50 text-[10px]">@{f.username}</span>
                        </button>
                      ))}
                    </div>
                  ) : null;
                })()}
              </div>
              <Button size="sm" className="h-8 w-8 p-0 rounded-full bg-primary/10 hover:bg-primary/20" variant="ghost"
                disabled={!commentText.trim() || addCommentMutation.isPending}
                onClick={() => addCommentMutation.mutate()}>
                {addCommentMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5 text-primary" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </article>
  );
});

// ─── Social Feed (main export) ───────────────────────────────────────────────

const FEED_LIMIT = 10;

export function SocialFeed() {
  const { user: currentUser } = useSession();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleUserClick = useCallback((userId: string) => {
    setSelectedUserId(userId);
    setIsDialogOpen(true);
  }, []);

  const handleDialogChange = useCallback((open: boolean) => {
    if (!open) setSelectedUserId(null);
    setIsDialogOpen(open);
  }, []);

  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<FeedEventWithDetails[]>({
    queryKey: ['/api/feed', currentUser?.id],
    queryFn: async ({ pageParam = 0 }) => {
      if (!currentUser) return [];
      const res = await apiRequest('GET', `/api/feed/${currentUser.id}?limit=${FEED_LIMIT}&offset=${pageParam as number}`);
      return res.json();
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage || lastPage.length < FEED_LIMIT) return undefined;
      return allPages.reduce((sum, p) => sum + p.length, 0);
    },
    enabled: !!currentUser,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  const mergedEvents = useMemo(() => {
    if (!data?.pages) return [];
    return enrichEvents(data.pages.flat());
  }, [data]);

  if (!currentUser) return null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <p className="text-sm">Error al cargar el feed</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }

  if (mergedEvents.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Users className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p className="text-sm font-medium">No hay actividad reciente</p>
        <p className="text-xs mt-1 opacity-70">Cuando tú o tus amigos corráis, aparecerá aquí</p>
      </div>
    );
  }

  return (
    <div className="pb-4">
      {mergedEvents.map(event => (
        <EventCard key={event.id} event={event} currentUserId={currentUser.id} onUserClick={handleUserClick} />
      ))}

      {hasNextPage && (
        <div className="flex justify-center pt-2 pb-2">
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground"
            onClick={() => fetchNextPage()} disabled={isFetchingNextPage}>
            {isFetchingNextPage
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />Cargando...</>
              : 'Ver más'}
          </Button>
        </div>
      )}

      <UserInfoDialog userId={selectedUserId} currentUserId={currentUser?.id} open={isDialogOpen} onOpenChange={handleDialogChange} />
    </div>
  );
}

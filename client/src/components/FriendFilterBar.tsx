import { useState } from 'react';
import { Eye, EyeOff, ChevronDown, ChevronUp, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UserWithStats } from '@shared/schema';

interface FriendFilterBarProps {
  currentUser: UserWithStats;
  friends: UserWithStats[];
  visibleUserIds: Set<string>;
  onToggleUser: (userId: string) => void;
  onShowAll: () => void;
  onHideAll: () => void;
}

export function FriendFilterBar({
  currentUser,
  friends,
  visibleUserIds,
  onToggleUser,
  onShowAll,
  onHideAll,
}: FriendFilterBarProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const allUsers = [currentUser, ...friends];
  const allVisible = allUsers.every(u => visibleUserIds.has(u.id));
  const noneVisible = allUsers.every(u => !visibleUserIds.has(u.id));
  const visibleCount = allUsers.filter(u => visibleUserIds.has(u.id)).length;

  return (
    <div
      className="absolute left-3 right-3 z-[1000]"
      style={{ top: 'calc(5.5rem + env(safe-area-inset-top, 0px))' }}
    >
      {/* Collapsed: compact bar */}
      <div className={cn(
        "bg-card/95 backdrop-blur-xl rounded-xl border border-border shadow-lg transition-all duration-200",
        isExpanded ? "rounded-b-none border-b-0" : ""
      )}>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs"
        >
          <div className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-muted-foreground">
              {visibleCount}/{allUsers.length} visibles
            </span>
            {/* Mini avatars preview when collapsed */}
            {!isExpanded && (
              <div className="flex -space-x-1.5 ml-1">
                {allUsers.slice(0, 6).map(user => (
                  <div
                    key={user.id}
                    className={cn(
                      "w-5 h-5 rounded-full border-2 border-card flex items-center justify-center text-[7px] font-bold text-white transition-opacity",
                      visibleUserIds.has(user.id) ? "opacity-100" : "opacity-30"
                    )}
                    style={{ backgroundColor: user.color }}
                  >
                    {user.name?.[0]?.toUpperCase() || '?'}
                  </div>
                ))}
                {allUsers.length > 6 && (
                  <div className="w-5 h-5 rounded-full border-2 border-card bg-muted flex items-center justify-center text-[7px] font-medium text-muted-foreground">
                    +{allUsers.length - 6}
                  </div>
                )}
              </div>
            )}
          </div>
          {isExpanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </button>
      </div>

      {/* Expanded: full filter list */}
      {isExpanded && (
        <div className="bg-card/95 backdrop-blur-xl rounded-b-xl border border-border border-t-0 shadow-lg px-3 pb-3 animate-in slide-in-from-top-1 duration-150">
          {/* Quick actions */}
          <div className="flex gap-2 mb-2">
            <button
              onClick={onShowAll}
              disabled={allVisible}
              className={cn(
                "flex-1 text-[10px] font-medium py-1 px-2 rounded-md transition-colors",
                allVisible
                  ? "bg-primary/10 text-primary cursor-default"
                  : "bg-muted hover:bg-muted/80 text-muted-foreground"
              )}
            >
              Mostrar todos
            </button>
            <button
              onClick={onHideAll}
              disabled={noneVisible}
              className={cn(
                "flex-1 text-[10px] font-medium py-1 px-2 rounded-md transition-colors",
                noneVisible
                  ? "bg-destructive/10 text-destructive cursor-default"
                  : "bg-muted hover:bg-muted/80 text-muted-foreground"
              )}
            >
              Ocultar todos
            </button>
          </div>

          {/* User chips */}
          <div className="flex flex-wrap gap-1.5">
            {allUsers.map(user => {
              const isVisible = visibleUserIds.has(user.id);
              const isCurrentUser = user.id === currentUser.id;

              return (
                <button
                  key={user.id}
                  onClick={() => onToggleUser(user.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium transition-all duration-150 border",
                    isVisible
                      ? "border-transparent shadow-sm"
                      : "border-border bg-muted/50 opacity-50"
                  )}
                  style={isVisible ? {
                    backgroundColor: `${user.color}20`,
                    color: user.color,
                    borderColor: `${user.color}40`,
                  } : undefined}
                >
                  <div
                    className={cn(
                      "w-4 h-4 rounded-full flex items-center justify-center text-[7px] font-bold text-white flex-shrink-0",
                      !isVisible && "grayscale"
                    )}
                    style={{ backgroundColor: user.color }}
                  >
                    {user.name?.[0]?.toUpperCase() || '?'}
                  </div>
                  <span className="max-w-[60px] truncate">
                    {isCurrentUser ? 'Tú' : user.name?.split(' ')[0] || user.username}
                  </span>
                  {isVisible ? (
                    <Eye className="h-3 w-3 flex-shrink-0 opacity-60" />
                  ) : (
                    <EyeOff className="h-3 w-3 flex-shrink-0 opacity-40" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

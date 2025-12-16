import { UserPlus, Users, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { UserWithStats } from '@shared/schema';

interface FriendsListProps {
  friends: UserWithStats[];
  onAddFriend: () => void;
  onViewTerritory: (userId: string) => void;
}

export function FriendsList({ friends, onAddFriend, onViewTerritory }: FriendsListProps) {
  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Header */}
      <div className="p-6 border-b border-border bg-gradient-to-br from-primary/5 to-transparent animate-slide-down">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <div className="relative">
              <Users className="h-8 w-8 text-primary" />
              <div className="absolute inset-0 bg-primary/20 blur-xl animate-pulse" />
            </div>
            Amigos
          </h1>
          <Button 
            onClick={onAddFriend} 
            data-testid="button-add-friend"
            className="gradient-primary border-0 hover:scale-105 active:scale-95 transition-all duration-300 group"
          >
            <UserPlus className="h-5 w-5 mr-2 group-hover:rotate-12 transition-transform duration-300" />
            Añadir
          </Button>
        </div>
        <p className="text-muted-foreground flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          Compite con tus amigos por conquistar territorio
        </p>
      </div>

      {/* Friends Grid */}
      <ScrollArea className="flex-1">
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {friends.length === 0 ? (
            <div className="col-span-full text-center py-12 animate-scale-in">
              <div className="relative inline-block mb-4">
                <Users className="h-20 w-20 mx-auto text-muted-foreground" />
                <div className="absolute inset-0 bg-muted-foreground/10 blur-2xl" />
              </div>
              <h3 className="text-lg font-semibold mb-2">No tienes amigos aún</h3>
              <p className="text-muted-foreground mb-6">
                Añade amigos para competir por territorio
              </p>
              <Button 
                onClick={onAddFriend}
                className="gradient-primary border-0 hover:scale-105 transition-all duration-300"
              >
                <UserPlus className="h-5 w-5 mr-2" />
                Añadir primer amigo
              </Button>
            </div>
          ) : (
            friends.map((friend, index) => (
              <Card
                key={friend.id}
                className="p-4 hover-elevate active-elevate-2 transition-all duration-300 hover:scale-[1.02] hover:shadow-xl animate-slide-up border-card-border group"
                style={{
                  animationDelay: `${index * 50}ms`,
                }}
                data-testid={`friend-card-${friend.id}`}
              >
                <div className="flex items-center gap-4 mb-4">
                  <div className="relative">
                    <Avatar className="h-14 w-14 ring-2 ring-offset-2 transition-all duration-300 group-hover:scale-110"
                      style={{ ringColor: friend.color }}
                    >
                      <AvatarImage src={friend.avatar || undefined} />
                      <AvatarFallback style={{ backgroundColor: friend.color }}>
                        <span className="text-white font-semibold text-lg">
                          {getInitials(friend.name)}
                        </span>
                      </AvatarFallback>
                    </Avatar>
                    <div 
                      className="absolute inset-0 rounded-full blur-md opacity-0 group-hover:opacity-50 transition-opacity duration-300"
                      style={{ backgroundColor: friend.color }}
                    />
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-lg truncate">{friend.name}</p>
                    <p className="text-sm text-muted-foreground truncate">
                      @{friend.username}
                    </p>
                  </div>

                  {friend.rank && (
                    <Badge variant="secondary" className="animate-pulse">
                      #{friend.rank}
                    </Badge>
                  )}
                </div>

                <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Territorio</p>
                    <p className="text-xl font-bold">
                      {(friend.totalArea / 1000000).toLocaleString('es-ES', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })} km²
                    </p>
                  </div>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onViewTerritory(friend.id)}
                    data-testid={`button-view-territory-${friend.id}`}
                    className="hover:scale-105 active:scale-95 transition-all duration-300"
                  >
                    Ver mapa
                  </Button>
                </div>
              </Card>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

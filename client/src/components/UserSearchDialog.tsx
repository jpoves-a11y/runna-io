import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card } from '@/components/ui/card';
import { Search, UserPlus, Loader2 } from 'lucide-react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import type { UserWithStats } from '@shared/schema';

interface UserSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentUserId: string;
}

export function UserSearchDialog({ open, onOpenChange, currentUserId }: UserSearchDialogProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const { toast } = useToast();

  const { data: searchResults = [], isLoading: isSearching, refetch } = useQuery<UserWithStats[]>({
    queryKey: ['/api/users/search', searchQuery, currentUserId],
    queryFn: async () => {
      if (!searchQuery.trim()) return [];
      const url = `/api/users/search?query=${encodeURIComponent(searchQuery)}&userId=${currentUserId}`;
      const result = await apiRequest('GET', url);
      return await result.json();
    },
    enabled: false,
  });

  const addFriendMutation = useMutation({
    mutationFn: async (friendId: string) => {
      const response = await apiRequest('POST', '/api/friends', {
        userId: currentUserId,
        friendId,
      });
      if (!response.ok) {
        const err = await response.json();
        if (err.error === 'SAME_COLOR') {
          throw new Error('No puedes añadir a un amigo con el mismo color de territorio. Cambia tu color en Perfil > Tu color de territorio.');
        }
        throw new Error(err.error || err.message || 'Error al enviar solicitud');
      }
      return await response.json();
    },
    onSuccess: (data, friendId) => {
      queryClient.invalidateQueries({ queryKey: ['/api/friends', currentUserId] });
      queryClient.invalidateQueries({ queryKey: ['/api/friends/requests/sent', currentUserId] });
      
      // Find the user to get their name
      const addedUser = searchResults?.find(u => u.id === friendId);
      toast({
        title: '✅ Solicitud enviada',
        description: `Solicitud enviada a ${addedUser?.name || 'usuario'}`,
        className: 'animate-bounce-in',
      });
      setSearchQuery('');
      setHasSearched(false);
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo enviar la solicitud',
        variant: 'destructive',
      });
    },
  });

  const handleSearch = () => {
    if (searchQuery.trim()) {
      setHasSearched(true);
      refetch();
    }
  };

  const handleAddFriend = (friendId: string) => {
    addFriendMutation.mutate(friendId);
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-5 w-5 text-primary" />
            Buscar usuarios
          </DialogTitle>
          <DialogDescription>
            Busca por nombre o nombre de usuario para añadir amigos
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="flex gap-2">
            <Input
              placeholder="Buscar usuario..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyPress={handleKeyPress}
              data-testid="input-search-friend"
              className="flex-1"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-form-type="other"
              data-lpignore="true"
              name="friend-search-input"
            />
            <Button
              onClick={handleSearch}
              disabled={!searchQuery.trim() || isSearching}
              data-testid="button-search"
              className="gradient-primary"
            >
              {isSearching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
            </Button>
          </div>

          {hasSearched && (
            <ScrollArea className="h-[300px] rounded-md border">
              <div className="p-2 space-y-2">
                {isSearching ? (
                  <div className="flex justify-center items-center py-12">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  </div>
                ) : searchResults.length === 0 ? (
                  <div className="text-center py-12">
                    <Search className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                    <p className="text-sm text-muted-foreground">
                      No se encontraron usuarios
                    </p>
                  </div>
                ) : (
                  searchResults.map((user) => (
                    <Card
                      key={user.id}
                      className="p-3 hover:shadow-md transition-all duration-200"
                      data-testid={`search-result-${user.id}`}
                    >
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10">
                          <AvatarImage src={user.avatar || undefined} />
                          <AvatarFallback style={{ backgroundColor: user.color }}>
                            <span className="text-white text-sm font-semibold">
                              {getInitials(user.name)}
                            </span>
                          </AvatarFallback>
                        </Avatar>

                        <div className="flex-1 min-w-0">
                          <p className="font-semibold truncate text-sm">{user.name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            @{user.username}
                          </p>
                        </div>

                        <Button
                          size="sm"
                          onClick={() => handleAddFriend(user.id)}
                          disabled={addFriendMutation.isPending}
                          data-testid={`button-add-${user.id}`}
                          className="gradient-primary"
                        >
                          {addFriendMutation.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <UserPlus className="h-4 w-4 mr-1" />
                              Enviar solicitud
                            </>
                          )}
                        </Button>
                      </div>
                    </Card>
                  ))
                )}
              </div>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

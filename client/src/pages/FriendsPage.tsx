import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { FriendsList } from '@/components/FriendsList';
import { PendingRequests } from '@/components/PendingRequests';
import SentRequests from '@/components/SentRequests';
import { LoadingState } from '@/components/LoadingState';
import { LoginDialog } from '@/components/LoginDialog';
import { UserSearchDialog } from '@/components/UserSearchDialog';
import { InviteFriendDialog } from '@/components/InviteFriendDialog';
import { Button } from '@/components/ui/button';
import { User } from 'lucide-react';
import { useSession } from '@/hooks/use-session';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import type { UserWithStats } from '@shared/schema';
import UserInfoDialog from '@/components/UserInfoDialog';

export default function FriendsPage() {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isInviteDialogOpen, setIsInviteDialogOpen] = useState(false);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const { user: currentUser, isLoading: userLoading, login } = useSession();
  const { toast } = useToast();

  const { data: friends = [], isLoading } = useQuery<UserWithStats[]>({
    queryKey: ['/api/friends', currentUser?.id],
    enabled: !!currentUser?.id,
  });

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const removeFriendMutation = useMutation({
    mutationFn: async (friendId: string) => {
      if (!currentUser) throw new Error('No user logged in');
      return await apiRequest('DELETE', `/api/friends/${friendId}`, {
        userId: currentUser.id,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/friends', currentUser?.id] });
      toast({
        title: '✅ Amigo eliminado',
        description: 'Se ha eliminado de tu lista de amigos',
      });
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo eliminar el amigo',
        variant: 'destructive',
      });
    },
  });

  const handleAddFriend = () => {
    setIsAddDialogOpen(true);
  };

  const handleInviteFriend = () => {
    setIsInviteDialogOpen(true);
  };

  const handleRemoveFriend = (friendId: string) => {
    removeFriendMutation.mutate(friendId);
  };

  if (userLoading) {
    return <LoadingState message="Cargando..." />;
  }

  if (!currentUser) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6">
        <div className="text-center space-y-4">
          <User className="h-20 w-20 mx-auto text-muted-foreground" />
          <h2 className="text-2xl font-bold">Inicia sesion</h2>
          <p className="text-muted-foreground">
            Inicia sesion para ver tus amigos
          </p>
          <Button onClick={() => setIsLoginOpen(true)} data-testid="button-login-friends">
            Iniciar sesion
          </Button>
        </div>
        <LoginDialog open={isLoginOpen} onOpenChange={setIsLoginOpen} onLogin={login} />
      </div>
    );
  }

  if (isLoading) {
    return <LoadingState message="Cargando amigos..." />;
  }

  return (
    <>
      <div className="flex flex-col h-full overflow-hidden">
        <div 
          className="flex-1 overflow-y-auto"
          style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        >
          {currentUser && (
            <div className="p-3 md:p-4 space-y-3 bg-muted/30">
              <PendingRequests userId={currentUser.id} />
              <SentRequests userId={currentUser.id} />
            </div>
          )}
          <FriendsList
            friends={friends}
            onAddFriend={handleAddFriend}
            onInviteFriend={handleInviteFriend}
            onRemoveFriend={handleRemoveFriend}
            onUserClick={(id) => { setSelectedUserId(id); setIsDialogOpen(true); }}
          />
        </div>
      </div>

      {currentUser && (
        <>
          <UserSearchDialog
            open={isAddDialogOpen}
            onOpenChange={setIsAddDialogOpen}
            currentUserId={currentUser.id}
          />
          <InviteFriendDialog
            open={isInviteDialogOpen}
            onOpenChange={setIsInviteDialogOpen}
            userId={currentUser.id}
          />

          <UserInfoDialog userId={selectedUserId} currentUserId={currentUser?.id} open={isDialogOpen} onOpenChange={(open) => { if (!open) setSelectedUserId(null); setIsDialogOpen(open); }} />
        </>
      )}
    </>
  );
}

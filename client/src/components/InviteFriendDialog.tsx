import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Share2, Copy, Check, Link as LinkIcon, MessageCircle, Send } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';

interface InviteFriendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
}

interface InviteResponse {
  token: string;
  url: string;
}

export function InviteFriendDialog({ open, onOpenChange, userId }: InviteFriendDialogProps) {
  const [inviteUrl, setInviteUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const generateInviteMutation = useMutation({
    mutationFn: async () => {
      const result = await apiRequest('POST', '/api/friends/invite', { userId });
      return result as unknown as InviteResponse;
    },
    onSuccess: (data) => {
      setInviteUrl(data.url);
    },
    onError: (error: Error) => {
      toast({
        title: 'Error',
        description: error.message || 'No se pudo generar el link de invitación',
        variant: 'destructive',
      });
    },
  });

  const handleGenerateLink = () => {
    generateInviteMutation.mutate();
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      toast({
        title: '✅ Link copiado',
        description: 'El link de invitación se ha copiado al portapapeles',
        className: 'animate-bounce-in',
      });
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'No se pudo copiar el link',
        variant: 'destructive',
      });
    }
  };

  const handleShareWhatsApp = () => {
    const text = encodeURIComponent(`¡Únete a mí en Runna! Compite conmigo conquistando territorio: ${inviteUrl}`);
    window.open(`https://wa.me/?text=${text}`, '_blank');
  };

  const handleShareTelegram = () => {
    const text = encodeURIComponent(`¡Únete a mí en Runna! Compite conmigo conquistando territorio`);
    window.open(`https://t.me/share/url?url=${encodeURIComponent(inviteUrl)}&text=${text}`, '_blank');
  };

  const handleShareGeneric = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Invitación a Runna',
          text: '¡Únete a mí en Runna! Compite conmigo conquistando territorio',
          url: inviteUrl,
        });
      } catch (error) {
        // Usuario canceló el share
      }
    } else {
      handleCopyLink();
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setInviteUrl('');
      setCopied(false);
    }
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Share2 className="h-5 w-5 text-primary" />
            Invitar amigos
          </DialogTitle>
          <DialogDescription>
            Genera un link de invitación para que tus amigos se unan a Runna
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!inviteUrl ? (
            <div className="text-center space-y-4">
              <div className="relative inline-block">
                <LinkIcon className="h-16 w-16 mx-auto text-primary opacity-80" />
                <div className="absolute inset-0 bg-primary/20 blur-2xl" />
              </div>
              <p className="text-sm text-muted-foreground">
                Genera un link único que expira en 7 días
              </p>
              <Button
                onClick={handleGenerateLink}
                disabled={generateInviteMutation.isPending}
                className="w-full gradient-primary"
                data-testid="button-generate-invite"
              >
                {generateInviteMutation.isPending ? 'Generando...' : 'Generar link de invitación'}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <Card className="p-4 bg-muted/50 border-dashed">
                <div className="flex gap-2">
                  <Input
                    value={inviteUrl}
                    readOnly
                    className="flex-1 bg-background"
                    data-testid="input-invite-url"
                  />
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={handleCopyLink}
                    data-testid="button-copy-link"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </Card>

              <div className="space-y-2">
                <p className="text-sm font-medium text-center">Compartir por:</p>
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    variant="outline"
                    onClick={handleShareWhatsApp}
                    className="flex-col h-auto py-3 hover:bg-green-500/10 hover:border-green-500"
                    data-testid="button-share-whatsapp"
                  >
                    <MessageCircle className="h-5 w-5 mb-1 text-green-500" />
                    <span className="text-xs">WhatsApp</span>
                  </Button>
                  
                  <Button
                    variant="outline"
                    onClick={handleShareTelegram}
                    className="flex-col h-auto py-3 hover:bg-blue-500/10 hover:border-blue-500"
                    data-testid="button-share-telegram"
                  >
                    <Send className="h-5 w-5 mb-1 text-blue-500" />
                    <span className="text-xs">Telegram</span>
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleShareGeneric}
                    className="flex-col h-auto py-3 hover:bg-primary/10 hover:border-primary"
                    data-testid="button-share-more"
                  >
                    <Share2 className="h-5 w-5 mb-1 text-primary" />
                    <span className="text-xs">Más</span>
                  </Button>
                </div>
              </div>

              <div className="text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleGenerateLink}
                  className="text-xs text-muted-foreground"
                >
                  Generar nuevo link
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { API_BASE, apiRequest } from '@/lib/queryClient';

export interface CompetitionState {
  status: 'no_competition' | 'upcoming' | 'active' | 'finished';
  competition: {
    id: string;
    name: string;
    slug: string;
    startsAt: string;
    endsAt: string;
    status: string;
    config: any;
  } | null;
  timeUntilStart?: number;
  dayOfCompetition?: number;
  totalDays?: number;
  treasurePowers?: Record<string, any>;
}

export interface Treasure {
  id: string;
  name: string;
  powerType: string;
  rarity: string;
  lat: number;
  lng: number;
  active: boolean;
  expiresAt: string;
  power: {
    name: string;
    rarity: string;
    description: string;
    color: string;
    emoji: string;
  } | null;
}

export interface UserPower {
  id: string;
  userId: string;
  powerType: string;
  status: 'available' | 'active' | 'used' | 'expired';
  activatedAt: string | null;
  expiresAt: string | null;
  definition: {
    name: string;
    rarity: string;
    description: string;
    color: string;
    emoji: string;
  } | null;
}

export interface LeaderboardEntry {
  userId: string;
  totalArea: number;
  totalDistance: number;
  activitiesCount: number;
  treasuresCollected: number;
  areaStolen: number;
  user: {
    id: string;
    username: string;
    name: string;
    color: string;
    avatar: string | null;
    nickname?: string | null;
    nicknameExpiresAt?: string | null;
  };
}

export function useCompetition() {
  const { data, isLoading, error } = useQuery<CompetitionState>({
    queryKey: ['/api/competition/active'],
    staleTime: 60 * 1000, // 1 minute
    refetchInterval: 60 * 1000, // Re-check every minute
  });

  return {
    competition: data?.competition ?? null,
    status: data?.status ?? 'no_competition',
    timeUntilStart: data?.timeUntilStart,
    dayOfCompetition: data?.dayOfCompetition,
    totalDays: data?.totalDays,
    treasurePowers: data?.treasurePowers,
    isLoading,
    isActive: data?.status === 'active',
    isUpcoming: data?.status === 'upcoming',
    isFinished: data?.status === 'finished',
    error,
  };
}

export function useTreasures() {
  const { isActive } = useCompetition();
  
  return useQuery<{ treasures: Treasure[] }>({
    queryKey: ['/api/treasures/active'],
    enabled: isActive,
    staleTime: 30 * 1000, // 30 seconds
    refetchInterval: 60 * 1000, // Refresh every minute
  });
}

export function useUserPowers(userId: string | undefined) {
  const { isActive, competition } = useCompetition();
  
  return useQuery<{ powers: UserPower[] }>({
    queryKey: ['/api/users', userId, 'powers'],
    enabled: isActive && !!userId,
    staleTime: 30 * 1000,
  });
}

export function useLeaderboard() {
  const { isActive, isFinished } = useCompetition();
  
  return useQuery<{ leaderboard: LeaderboardEntry[] }>({
    queryKey: ['/api/competition/leaderboard'],
    enabled: isActive || isFinished,
    staleTime: 60 * 1000,
  });
}

export function useActivatePower() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ powerId, targetUserId, nickname }: { powerId: string; targetUserId?: string; nickname?: string }) => {
      const res = await apiRequest('POST', `/api/powers/${powerId}/activate`, {
        targetUserId,
        nickname,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
      queryClient.invalidateQueries({ queryKey: ['/api/competition'] });
    },
  });
}

export function useCollectTreasure() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ treasureId, userId, lat, lng }: { treasureId: string; userId: string; lat: number; lng: number }) => {
      const res = await apiRequest('POST', `/api/treasures/collect`, {
        treasureId,
        userId,
        lat,
        lng,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/treasures/active'] });
      queryClient.invalidateQueries({ queryKey: ['/api/users'] });
    },
  });
}

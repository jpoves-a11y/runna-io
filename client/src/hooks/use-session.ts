import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserWithStats } from '@shared/schema';
import { API_BASE, authFetch } from '@/lib/queryClient';
import { getStoredSession, getAuthToken, saveSession, clearSession, onSessionChange } from '@/lib/authSession';

export function useSession() {
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return getStoredSession()?.userId ?? null;
    }
    return null;
  });

  // Keep every component using this hook in sync (login, logout, expired token)
  useEffect(() => {
    return onSessionChange(() => setUserId(getStoredSession()?.userId ?? null));
  }, []);

  const { data: user, isLoading, error } = useQuery<UserWithStats | null>({
    queryKey: ['/api/current-user', userId],
    enabled: !!userId,
    retry: false,
    staleTime: 1000 * 60 * 5,
  });

  useEffect(() => {
    if (error) {
      clearSession();
    }
  }, [error]);

  const login = useCallback((newUserId: string, token: string | null) => {
    saveSession(newUserId, token);
    setUserId(newUserId);
    queryClient.invalidateQueries({ queryKey: ['/api/current-user'] });
  }, [queryClient]);

  const logout = useCallback(() => {
    const token = getAuthToken();
    if (token) {
      // Revoke the token on the server; the local session is cleared either way
      authFetch(`${API_BASE}/api/auth/logout`, { method: 'POST' }, token).catch(() => {});
    }
    clearSession();
    setUserId(null);
    queryClient.clear();
  }, [queryClient]);

  return {
    user: userId ? user : null,
    userId,
    isLoading: !!userId && isLoading,
    isLoggedIn: !!userId && !!user,
    login,
    logout,
  };
}

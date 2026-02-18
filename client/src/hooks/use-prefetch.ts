import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { queryClient } from '@/lib/queryClient';
import { useSession } from './use-session';

/**
 * Strategic prefetching hook - prefetches data for likely next navigations
 * Reduces perceived loading time by loading data before user navigates
 */
export function usePrefetch() {
  const [location] = useLocation();
  const { user } = useSession();

  useEffect(() => {
    if (!user?.id) return;

    // Prefetch rankings when on map page for 3+ seconds
    if (location === '/' || location.startsWith('/?')) {
      const timer = setTimeout(() => {
        queryClient.prefetchQuery({
          queryKey: ['/api/leaderboard/friends', user.id],
        });
      }, 3000);
      return () => clearTimeout(timer);
    }

    // Prefetch friends list when on rankings page
    if (location === '/rankings') {
      const timer = setTimeout(() => {
        queryClient.prefetchQuery({
          queryKey: ['/api/friends', user.id],
        });
      }, 2000);
      return () => clearTimeout(timer);
    }

    // Prefetch user activities when on friends page
    if (location === '/friends') {
      const timer = setTimeout(() => {
        queryClient.prefetchQuery({
          queryKey: ['/api/activities', user.id],
        });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [location, user?.id]);
}

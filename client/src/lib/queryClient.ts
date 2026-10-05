import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { getAuthToken, clearSession } from "./authSession";

// URL de la API - usar variable de entorno VITE_API_BASE_URL para Cloudflare Pages
// En desarrollo local (Replit), usar '' para llamadas relativas al mismo servidor
export const API_BASE = import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.PROD ? 'https://runna-io-api.runna-io-api.workers.dev' : '');

/** Error from the API; `message` is the server's error text when it sent one. */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let message = text;
    try {
      const body = JSON.parse(text);
      message = body?.error || body?.message || text;
    } catch {
      // not JSON: keep the raw text
    }
    throw new ApiError(message, res.status);
  }
}

/**
 * fetch() that sends the session token (or `token`, when given) as a Bearer token.
 * If the stored session's token is rejected (401), the session is cleared so the app asks to log in.
 */
export async function authFetch(url: string, init: RequestInit = {}, token?: string): Promise<Response> {
  // Never send the token to anything other than our API
  const isApiUrl = url.startsWith('/') || (!!API_BASE && url.startsWith(API_BASE));
  const authToken = isApiUrl ? (token ?? getAuthToken()) : null;
  const headers = new Headers(init.headers);
  if (authToken) headers.set("Authorization", `Bearer ${authToken}`);

  const res = await fetch(url, { credentials: "omit", ...init, headers });
  if (res.status === 401 && authToken && authToken === getAuthToken()) {
    clearSession();
  }
  return res;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  token?: string,
): Promise<Response> {
  const fullUrl = url.startsWith('/') ? `${API_BASE}${url}` : url;
  const res = await authFetch(fullUrl, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  }, token);

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey.join("/") as string;
    const fullUrl = url.startsWith('/') ? `${API_BASE}${url}` : url;
    const res = await authFetch(fullUrl);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true, // Refetch when user returns to tab
      staleTime: 3 * 60 * 1000, // 3 minutes default - data fresh for 3min, then bg refetch
      retry: false,
      gcTime: 10 * 60 * 1000, // Keep unused data in cache for 10 minutes (formerly cacheTime)
    },
    mutations: {
      retry: false,
    },
  },
});

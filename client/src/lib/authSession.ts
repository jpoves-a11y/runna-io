// Login session stored on this device: the user ID plus the API token
// sent as "Authorization: Bearer <token>" on every API request.

const USER_ID_KEY = 'runna_user_id';
const TOKEN_KEY = 'runna_auth_token';
const SESSION_CHANGED_EVENT = 'runna:session-changed';

export interface StoredSession {
  userId: string;
  token: string;
}

export function getStoredSession(): StoredSession | null {
  try {
    const userId = localStorage.getItem(USER_ID_KEY);
    const token = localStorage.getItem(TOKEN_KEY);
    if (userId && token) return { userId, token };
    // Sessions saved before the API required a token only have the user ID: log in again
    if (userId) localStorage.removeItem(USER_ID_KEY);
    return null;
  } catch {
    return null;
  }
}

export function getAuthToken(): string | null {
  return getStoredSession()?.token ?? null;
}

export function saveSession(userId: string, token: string): void {
  try {
    localStorage.setItem(USER_ID_KEY, userId);
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}

export function clearSession(): void {
  try {
    localStorage.removeItem(USER_ID_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}

/** Calls `listener` whenever this tab logs in or out (including an expired token). */
export function onSessionChange(listener: () => void): () => void {
  window.addEventListener(SESSION_CHANGED_EVENT, listener);
  return () => window.removeEventListener(SESSION_CHANGED_EVENT, listener);
}

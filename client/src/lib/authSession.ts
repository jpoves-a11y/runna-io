// Login session stored on this device: the user ID plus the API token
// sent as "Authorization: Bearer <token>" on every API request.
//
// Sessions saved before the API issued tokens only have the user ID. They are kept
// until the API rejects them (401), which logs the user out so they log in again;
// that way the web keeps working whether or not the new Worker is deployed yet.

const USER_ID_KEY = 'runna_user_id';
const TOKEN_KEY = 'runna_auth_token';
const SESSION_CHANGED_EVENT = 'runna:session-changed';

export interface StoredSession {
  userId: string;
  /** null for a session from before the API issued tokens */
  token: string | null;
}

export function getStoredSession(): StoredSession | null {
  try {
    const userId = localStorage.getItem(USER_ID_KEY);
    if (!userId) return null;
    return { userId, token: localStorage.getItem(TOKEN_KEY) };
  } catch {
    return null;
  }
}

export function getAuthToken(): string | null {
  return getStoredSession()?.token ?? null;
}

export function saveSession(userId: string, token: string | null): void {
  try {
    localStorage.setItem(USER_ID_KEY, userId);
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
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

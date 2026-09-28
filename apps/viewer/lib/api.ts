import { tokenKey, userKey } from "./session";

export const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

export interface ViewerSession {
  viewerId: string;
  orgId: string;
  email: string;
}

export function storeSession(orgSlug: string, token: string, viewer: ViewerSession) {
  localStorage.setItem(tokenKey(orgSlug), token);
  localStorage.setItem(userKey(orgSlug), JSON.stringify(viewer));
}

export function clearSession(orgSlug: string) {
  localStorage.removeItem(tokenKey(orgSlug));
  localStorage.removeItem(userKey(orgSlug));
}

export function getToken(orgSlug: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(tokenKey(orgSlug));
}

export function getStoredViewer(orgSlug: string): ViewerSession | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(userKey(orgSlug));
  return raw ? (JSON.parse(raw) as ViewerSession) : null;
}

export function authHeaders(orgSlug: string): Record<string, string> {
  const token = getToken(orgSlug);
  return token ? { authorization: `Bearer ${token}` } : {};
}

// Every protected page's data fetch goes through this, so a revoked or
// expired session is handled in exactly one place: on a 401, clear this
// org's session and send the viewer back to its login page. Without this,
// each page would need to repeat that check itself (see Review Focus #2).
export async function portalFetch(
  orgSlug: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(orgSlug), ...(init.headers ?? {}) },
  });
  if (res.status === 401) {
    clearSession(orgSlug);
    if (typeof window !== "undefined") window.location.href = `/${orgSlug}/login`;
  }
  return res;
}

export interface OrgBranding {
  displayName: string;
  logoUrl: string | null;
}

export interface LibraryAsset {
  assetId: string;
  title: string;
  durationSeconds: number | null;
  latestCompletedJobId: string | null;
}

export interface PageInfo {
  nextPageToken: string;
  totalCount: number;
}

export interface ProgressEntry {
  assetId: string;
  positionSeconds: number;
  updatedAt: string;
}

export interface HistoryEntry {
  assetId: string;
  title: string;
  positionSeconds: number;
  updatedAt: string;
  available: boolean;
  latestCompletedJobId: string | null;
}

export interface ThumbnailsResponse {
  thumbnails: string[];
}

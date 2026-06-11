export const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

export const JOB_STATES = {
  1: { label: "Queued", color: "text-amber-400" },
  2: { label: "Processing", color: "text-sky-400" },
  3: { label: "Completed", color: "text-emerald-400" },
  4: { label: "Failed", color: "text-rose-400" },
  5: { label: "Cancelled", color: "text-slate-400" },
} as Record<number, { label: string; color: string }>;

export interface Job {
  jobId: string;
  assetId: string;
  createdByUserId: string;
  state: number;
  progressPercent: number;
  errorMessage: string;
  submittedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface SessionUser {
  userId: string;
  email: string;
  displayName: string;
  role: number | string;
}

const TOKEN_KEY = "vidforge.token";
const USER_KEY = "vidforge.user";

export const ROLE_NAMES: Record<number, string> = { 1: "VIEWER", 2: "EDITOR", 3: "ADMIN", 4: "OWNER" };

export function storeSession(token: string, user: SessionUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(
    USER_KEY,
    JSON.stringify({ ...user, role: ROLE_NAMES[user.role as number] ?? user.role }),
  );
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): SessionUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as SessionUser) : null;
}

export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

// EventSource can't set headers, so the token rides as a query param.
export function sseUrl(path: string): string {
  const token = getToken();
  return `${GATEWAY_URL}${path}${token ? `?access_token=${encodeURIComponent(token)}` : ""}`;
}

export interface Asset {
  assetId: string;
  title: string;
  status: "UPLOADING" | "UPLOADED" | "PROCESSING" | "READY" | "FAILED" | "ARCHIVED";
  sourceStorageKey: string | null;
  sourceBytes: number | null;
  durationSeconds: number | null;
  createdBy: string;
  createdAt: string;
  latestCompletedJobId: string | null;
}

export interface ProgressEvent {
  jobId: string;
  state: number;
  percent: number;
  currentRendition: string;
}

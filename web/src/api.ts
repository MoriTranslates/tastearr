import type { PublicSettings, Season, TasteProfile } from "../../shared/api";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-Tastearr"] = "1"; // CSRF guard: cross-site forms can't set custom headers
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
    signal: opts.signal,
  });
  const text = await res.text();
  let data: Record<string, unknown> | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("tastearr:auth"));
    throw new ApiError((data?.error as string) ?? res.statusText, res.status, data);
  }
  return data as T;
}

// The API contract lives in shared/api.ts, so server and UI can't drift apart.
export type {
  AddPlan,
  ArrOptions,
  ArrSettings,
  Candidate,
  Followed,
  Job,
  Pick,
  Pref,
  Season,
  Section,
  Show,
  Status,
} from "../../shared/api";

/** Settings as the browser sees them (secrets masked). */
export type Settings = PublicSettings;
/** The taste profile, or `{ building: true }` while the first one is built. */
export type Profile = TasteProfile & { building?: boolean };

export const SEASONS: Season[] = ["WINTER", "SPRING", "SUMMER", "FALL"];
export const seasonName = (s: Season) => s[0] + s.slice(1).toLowerCase();
export function shiftSeason(s: { season: Season; year: number }, by: number) {
  const idx = s.year * 4 + SEASONS.indexOf(s.season) + by;
  return { season: SEASONS[((idx % 4) + 4) % 4], year: Math.floor(idx / 4) };
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`tastearr.${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`tastearr.${key}`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};

import { useEffect, useState } from "react";
import { api, type Job } from "../api";
import { useToast } from "../components/ui";
import { errorMessage } from "../lib/errors";

/** Version, uptime and background jobs, refreshed every few seconds. */
export function useSystemInfo() {
  const toast = useToast();
  const [info, setInfo] = useState<{ version: string; uptime: number; node: string; jobs: Job[] } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ version: string; uptime: number; node: string; jobs: Job[] }>("/system")
        .then((x) => alive && setInfo(x))
        .catch((e) => toast(errorMessage(e), true));
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [toast]);
  return info;
}

/** Connection checks; `checkHealth` runs them again. */
export function useHealth() {
  const toast = useToast();
  const [health, setHealth] = useState<{ checks: { name: string; ok: boolean; detail: string }[] } | null>(null);
  const checkHealth = () => {
    setHealth(null);
    api<NonNullable<typeof health>>("/system/health")
      .then(setHealth)
      .catch((e) => toast(errorMessage(e), true));
  };
  useEffect(checkHealth, [toast]);
  return { health, checkHealth };
}

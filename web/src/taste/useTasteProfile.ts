import { useEffect, useState } from "react";
import { api, type Job, type Profile } from "../api";

/** The taste profile and its build job; polls every 2 s while the profile is building. */
export function useTasteProfile() {
  const [p, setP] = useState<Profile | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [prof, sys] = await Promise.all([api<Profile>("/profile"), api<{ jobs: Job[] }>("/system")]);
        if (!alive) return;
        const j = sys.jobs.find((x) => x.name === "profile") ?? null;
        setJob(j);
        if (!prof.building) setP(prof);
        if (prof.building || j?.state === "running") timer = setTimeout(load, 2000);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  return { p, setP, job, setJob, error };
}

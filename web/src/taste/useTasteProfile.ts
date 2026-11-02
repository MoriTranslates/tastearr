import { useEffect, useRef, useState } from "react";
import { api, type Job, type Profile } from "../api";
import { pollUntil } from "../lib/poll";
import { errorMessage } from "../lib/errors";

const profileJob = (jobs: Job[]) => jobs.find((x) => x.name === "profile") ?? null;

/** The taste profile and its build job; polls every 2 s while the profile is building. */
export function useTasteProfile(onRebuildError: (message: string) => void) {
  const [p, setP] = useState<Profile | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRebuildPoll = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const [prof, sys] = await Promise.all([api<Profile>("/profile"), api<{ jobs: Job[] }>("/system")]);
        if (!alive) return;
        const j = profileJob(sys.jobs);
        setJob(j);
        if (!prof.building) setP(prof);
        if (prof.building || j?.state === "running") timer = setTimeout(load, 2000);
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
      stopRebuildPoll.current?.(); // leaving the page ends the "Rebuild now" follow-up too
    };
  }, []);

  /** Starts a rebuild and follows its job until it finishes, then shows the new profile. */
  async function rebuild() {
    await api("/profile/rebuild", { body: {} });
    // Keep the known failure history while the new run starts.
    setJob((prev) => ({
      lastError: null,
      lastErrorAt: null,
      lastSuccessAt: null,
      ...prev,
      name: "profile",
      state: "running",
      detail: "Starting",
      startedAt: Date.now(),
      finishedAt: null,
    }));
    stopRebuildPoll.current?.();
    stopRebuildPoll.current = pollUntil({
      step: async () => profileJob((await api<{ jobs: Job[] }>("/system")).jobs),
      keepGoing: (j) => j?.state === "running",
      onResult: (j) => {
        setJob(j);
        if (j?.state !== "running") void api<Profile>("/profile").then(setP, (e) => onRebuildError(errorMessage(e)));
      },
      onError: (e) => onRebuildError(errorMessage(e)),
      delayMs: 2000,
      firstDelayMs: 1500,
    });
  }

  return { p, job, error, rebuild };
}

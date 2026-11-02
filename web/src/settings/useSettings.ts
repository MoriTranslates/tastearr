import { useEffect, useState } from "react";
import { api, type Settings } from "../api";
import { useToast } from "../components/ui";

export type Save = (patch: Partial<Settings>) => Promise<Settings>;

export function useSettings() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Settings>("/settings")
      .then(setS)
      .catch((e) => setError(e.message));
  }, []);
  const save: Save = async (patch) => {
    const next = await api<Settings>("/settings", { method: "PUT", body: patch });
    setS(next);
    return next;
  };
  return { s, setS, save, error, toast };
}

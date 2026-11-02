import { useEffect, useState } from "react";
import { api, type Settings } from "../api";
import { useToast } from "../components/ui";
import { errorMessage } from "../lib/errors";

export type Save = (patch: Partial<Settings>) => Promise<Settings>;

export function useSettings() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Settings>("/settings")
      .then(setS)
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const save: Save = async (patch) => {
    const next = await api<Settings>("/settings", { method: "PUT", body: patch });
    setS(next);
    return next;
  };
  /** Re-reads the settings after something other than `save` changed them on the server (a detected app, an extra Sonarr). */
  const reload = async () => {
    const next = await api<Settings>("/settings");
    setS(next);
    return next;
  };
  return { s, save, reload, error, toast };
}

import { useEffect, useState } from "react";
import { api, type Followed, type Show } from "../api";
import { errorMessage } from "../lib/errors";

export type ShowsData = { sonarr: Show[]; following: Followed[] };

export function useShows() {
  const [data, setData] = useState<ShowsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setError(null);
    api<ShowsData>("/shows")
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  }, [reload]);

  return { data, setData, error, retry: () => setReload((x) => x + 1) };
}

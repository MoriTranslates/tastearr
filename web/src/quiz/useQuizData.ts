import { useEffect, useState } from "react";
import { api, type Pref } from "../api";
import type { QuizData } from "./types";
import { errorMessage } from "../lib/errors";

/** The quiz questions plus the viewer's genre answers and gore toggle (both editable locally). */
export function useQuizData() {
  const [data, setData] = useState<QuizData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Record<string, Pref>>({});
  const [noGore, setNoGore] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setError(null);
    api<QuizData>("/quiz")
      .then((d) => {
        setData(d);
        setPrefs(d.genrePrefs);
        setNoGore(d.noGore);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [reload]);

  return { data, setData, error, retry: () => setReload((x) => x + 1), prefs, setPrefs, noGore, setNoGore };
}

import { useEffect, useState } from "react";
import { store, type Status } from "../api";
import type { SortKey } from "./helpers";

/** The viewer's sort and filter choices; each is remembered between visits except the air day and "show hidden". */
export function usePickFilters(status: Status, initDay: number | null) {
  const hideInLibrary = status.prefs?.hideInLibrary ?? false;
  const [day, setDay] = useState<number | null>(initDay);
  const [sort, setSort] = useState<SortKey>(() => store.get("sort", "match"));
  // Settings defaults (my services, hide in library, hide shorts) apply until the viewer changes the toggle here.
  const [services, setServicesRaw] = useState<string[]>(() => store.get<string[] | null>("services", null) ?? status.prefs?.services ?? []);
  const [showLibrary, setShowLibraryRaw] = useState(() => store.get<boolean | null>("showLibrary", null) ?? !hideInLibrary);
  const [showFiltered, setShowFiltered] = useState(false);
  const setServices = (v: string[]) => {
    setServicesRaw(v);
    store.set("services", v);
  };
  const setShowLibrary = (v: boolean) => {
    setShowLibraryRaw(v);
    store.set("showLibrary", v);
  };
  useEffect(() => store.set("sort", sort), [sort]);
  const clearFilters = () => {
    setDay(null);
    setServicesRaw([]);
    store.set("services", null); // back to "my services" from Settings next time
    setShowFiltered(true);
    setShowLibrary(true);
  };
  return { day, setDay, sort, setSort, services, setServices, showLibrary, setShowLibrary, showFiltered, setShowFiltered, clearFilters };
}

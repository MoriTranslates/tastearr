/** Hand-written response shapes of the public Sonarr / Radarr v3 APIs (no real hosts or keys). */

export const sonarrStatus = { appName: "Sonarr", instanceName: "Sonarr", version: "4.0.9.2244", branch: "main", authentication: "forms" };
export const radarrStatus = { appName: "Radarr", instanceName: "Radarr", version: "5.14.0.9383", branch: "master" };

export const qualityProfiles = [
  { id: 1, name: "Any", upgradeAllowed: false, cutoff: 1, items: [] },
  { id: 4, name: "HD-1080p", upgradeAllowed: true, cutoff: 7, items: [] },
];
export const rootFolders = [{ id: 1, path: "/tv", accessible: true, freeSpace: 123456789 }];
export const tagList = [{ id: 2, label: "anime" }];

/** CJK and punctuation-heavy titles, the kind real libraries contain. */
export const cjkSeries = [
  { id: 11, title: "葬送のフリーレン", tvdbId: 424536, year: 2023, monitored: true, seasons: [{ seasonNumber: 1, monitored: true }] },
  { id: 12, title: "Re:ZERO -Starting Life in Another World-", tvdbId: 305089, year: 2016, monitored: true, seasons: [] },
  { id: 13, title: "【推しの子】", tvdbId: 421069, year: 2023, monitored: false, seasons: [] },
];
export const movies = [{ id: 5, title: "君の名は。", tmdbId: 372058, imdbId: "tt5311514", year: 2016, monitored: true, hasFile: true }];

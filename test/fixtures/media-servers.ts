/** Hand-written response shapes of the public Plex, plex.tv and Jellyfin APIs (no real hosts or tokens). */

export const plexRoot = { MediaContainer: { friendlyName: "Living Room", version: "1.41.3.9314-a0bfb8370", machineIdentifier: "abc" } };
export const plexSections = {
  MediaContainer: {
    size: 3,
    Directory: [
      { key: "1", type: "movie", title: "Movies" },
      { key: "2", type: "show", title: "アニメ" },
      { key: "3", type: "show", title: "TV Shows" },
    ],
  },
};
export const plexShows = {
  MediaContainer: {
    Metadata: [
      {
        ratingKey: "100",
        title: "葬送のフリーレン",
        Guid: [{ id: "imdb://tt22248376" }, { id: "tvdb://424536" }],
        leafCount: 28,
        viewedLeafCount: 12,
        userRating: 9,
      },
      {
        ratingKey: "101",
        title: "Legacy Agent Show",
        guid: "com.plexapp.agents.thetvdb://81797/1?lang=en",
        leafCount: 24,
        viewedLeafCount: 0,
      },
      { ratingKey: "102", title: "HAMA Show", guid: "com.plexapp.agents.hama://anidb-4521?lang=en", leafCount: 13, viewedLeafCount: 13 },
      { ratingKey: "103", title: "No ids at all", leafCount: 5, viewedLeafCount: 5 },
    ],
  },
};
export const plexSeasons = {
  MediaContainer: {
    Metadata: [
      { index: 1, leafCount: 28, viewedLeafCount: 12 },
      { index: 0, leafCount: 2, viewedLeafCount: 0 },
    ],
  },
};
export const plexResources = [
  {
    name: "Home Plex",
    clientIdentifier: "srv1",
    provides: "server",
    owned: true,
    accessToken: "server-token",
    connections: [
      { uri: "https://192-168-1-5.hash.plex.direct:32400", address: "192.168.1.5", port: 32400, local: true, relay: false },
      { uri: "https://relay.plex.direct", address: "1.2.3.4", port: 8443, local: false, relay: true },
    ],
  },
  { name: "Phone", clientIdentifier: "c1", provides: "player", owned: true, accessToken: "x", connections: [] },
];

export const jfInfo = { ServerName: "Media Box", Version: "10.10.3", Id: "x" };
export const jfUsers = [
  { Id: "u1", Name: "adam" },
  { Id: "u2", Name: "ゲスト" },
];
export const jfViews = {
  Items: [
    { Id: "v1", Name: "Anime", CollectionType: "tvshows" },
    { Id: "v2", Name: "Movies", CollectionType: "movies" },
  ],
};
export const jfSeries = {
  Items: [
    {
      Id: "s1",
      Name: "葬送のフリーレン",
      ProviderIds: { Tvdb: "424536" },
      RecursiveItemCount: 28,
      UserData: { UnplayedItemCount: 16, IsFavorite: true },
    },
    { Id: "s2", Name: "No tvdb", ProviderIds: { Imdb: "tt1" }, RecursiveItemCount: 10, UserData: { UnplayedItemCount: 10 } },
    { Id: "s3", Name: "Unwatched", ProviderIds: { Tvdb: "999" }, RecursiveItemCount: 12, UserData: { UnplayedItemCount: 12, Rating: 7 } },
  ],
};
export const jfSeasons = {
  Items: [
    { Id: "se1", Name: "Season 1", IndexNumber: 1, RecursiveItemCount: 28, UserData: { UnplayedItemCount: 16 } },
    { Id: "sp", Name: "Specials" },
  ],
};

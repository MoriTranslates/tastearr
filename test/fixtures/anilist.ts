import { media } from "../helpers.ts";

/** Hand-written AniList GraphQL replies. */
export const page = (list: unknown[], hasNextPage = false) => ({ data: { Page: { pageInfo: { hasNextPage }, media: list } } });
export const cjkMedia = media(154587, {
  title: { romaji: "Sousou no Frieren", english: "Frieren: Beyond Journey's End", native: "葬送のフリーレン" },
  genres: ["Adventure", "Drama", "Fantasy"],
});
export const userList = {
  data: {
    MediaListCollection: {
      lists: [
        { entries: [{ mediaId: 1, status: "COMPLETED", score: 90, progress: 26 }] },
        { entries: [{ mediaId: 2, status: "DROPPED", score: 0, progress: 3 }] },
      ],
    },
  },
};
export const malPage1 = {
  data: [{ node: { id: 52991, title: "葬送のフリーレン" }, list_status: { status: "completed", score: 10, num_episodes_watched: 28 } }],
  paging: { next: "https://api.myanimelist.net/v2/users/adam/animelist?offset=1000" },
};
export const malPage2 = {
  data: [
    {
      node: { id: 5114, title: "Fullmetal Alchemist: Brotherhood" },
      list_status: { status: "dropped", score: 0, num_episodes_watched: 2 },
    },
  ],
  paging: {},
};

import type { LibraryMovie } from "../core/taste/types.js";
import { arrOptions, arrRequest, arrStatus, tastearrTag, type ArrConn } from "./arr.js";

/** Radarr v3 API calls. Each takes the instance to talk to. */

export type RadarrMovie = LibraryMovie;

const call = <T>(conn: ArrConn, method: string, path: string, body?: unknown) => arrRequest<T>("Radarr", conn, method, path, body);

export const status = (conn: ArrConn) => arrStatus("Radarr", conn);
export const options = (conn: ArrConn) => arrOptions("Radarr", conn);
export const ensureTag = (conn: ArrConn) => tastearrTag("Radarr", conn);

export const allMovies = (conn: ArrConn) => call<RadarrMovie[]>(conn, "GET", "/movie");
export const lookupTmdb = (conn: ArrConn, tmdbId: number) => call<RadarrMovie>(conn, "GET", `/movie/lookup/tmdb?tmdbId=${tmdbId}`);
export const lookupImdb = (conn: ArrConn, imdbId: string) => call<RadarrMovie>(conn, "GET", `/movie/lookup/imdb?imdbId=${imdbId}`);
export const addMovie = (conn: ArrConn, movie: unknown) => call<RadarrMovie>(conn, "POST", "/movie", movie);

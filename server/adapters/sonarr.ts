import type { LibrarySeries } from "../core/taste/types.js";
import { arrOptions, arrRequest, arrStatus, arrTags, tastearrTag, type ArrConn } from "./arr.js";

/** Sonarr v3 API calls. Each takes the instance to talk to; which one, and what to send, is decided by the caller. */

export type SonarrSeries = LibrarySeries;

const call = <T>(conn: ArrConn, method: string, path: string, body?: unknown) => arrRequest<T>("Sonarr", conn, method, path, body);

export const status = (conn: ArrConn) => arrStatus("Sonarr", conn);
export const options = (conn: ArrConn) => arrOptions("Sonarr", conn);
export const tags = (conn: ArrConn) => arrTags("Sonarr", conn);
export const qualityProfiles = (conn: ArrConn) => call<{ id: number; name: string }[]>(conn, "GET", "/qualityprofile");
export const ensureTag = (conn: ArrConn) => tastearrTag("Sonarr", conn);

export const allSeries = (conn: ArrConn) => call<SonarrSeries[]>(conn, "GET", "/series");
export const getSeries = (conn: ArrConn, id: number) => call<SonarrSeries>(conn, "GET", `/series/${id}`);
export const putSeries = (conn: ArrConn, id: number, series: unknown) => call(conn, "PUT", `/series/${id}`, series);
export const addSeries = (conn: ArrConn, series: unknown) => call<SonarrSeries>(conn, "POST", "/series", series);

/** Sonarr's series search: "tvdb:123" or a title. */
export const lookup = (conn: ArrConn, term: string) => call<SonarrSeries[]>(conn, "GET", `/series/lookup?term=${term}`);

export const command = (conn: ArrConn, body: Record<string, unknown>) => call<{ id: number }>(conn, "POST", "/command", body);
export const commandStatus = (conn: ArrConn, id: number) => call<{ status: string }>(conn, "GET", `/command/${id}`);

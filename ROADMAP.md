# Roadmap

Tastearr is an anime season planner: learn what you like, rank each season for you, add it to Sonarr/Radarr or follow it on your streaming service. This file tracks what's planned and what was considered and deliberately left out, so the core stays small.

## Next

- Several Sonarr/Radarr instances (a separate anime or 4K Sonarr), with "In library" across all of them
- Region setting for streaming links, plus a "my services" default for filters
- Weekly digest alert ("airing this week" plus what you're behind on)

## Maybe later

Each of these came up in reviews or user tests. They're reasonable but not essential for a solid anime MVP.

| Idea | Why not now |
|---|---|
| Overseerr/Jellyseerr request mode | Only matters for households with approval flows; direct Sonarr add covers most users |
| Plex watchlist as a taste signal | Small gain over Sonarr, watch history and AniList; needs plex.tv discover API work |
| Tautulli and Plex Home / per-user profiles | Real value for families, but a large change (profiles everywhere) |
| "Still watching?" drop-detection prompts | Needs reliable per-user watch history first |
| Wait-for-BD / uncensored release flag | Data isn't available in AniList; would need a curated list |
| AniList write-back (add picks to Planning) | Needs AniList OAuth; read-only import covers the taste side |
| Trakt and Simkl import | OAuth flows; AniList and MAL already cover most anime fans |
| Staff and studio as taste signals | Offline evaluation showed no ranking gain from studio; staff adds API load |
| PV/trailer embeds and staff on cards | A trailer link is enough for now |
| Regular TV (non-anime) | Different data sources (TMDB/TVmaze) and no seasonal chart; out of scope for the anime MVP |
| Native mobile app | The web app works on phones; ntfy covers notifications |
| Opt-in adult (hentai) library | Kept out of the main chart on purpose; would need its own root folder and filters |

## Decisions

- Login is always required once an account exists. "Not when I'm on my home network" matches Sonarr's "Disabled for local addresses" and never applies to proxied requests.
- Adding a sequel you don't own only monitors that season. When the season is unknown, only new episodes are monitored. Nothing is ever deleted.
- Match % is calibrated against your own history with `npm run eval`; 50% means you keep roughly 1 in 4 shows like it.
- Default sort is by match. The "Top pick" card never shows something you already have.

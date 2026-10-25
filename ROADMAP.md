# Roadmap

Tastearr is an anime season planner: learn what you like, rank each season for you, add it to Sonarr/Radarr or follow it on your streaming service. This file tracks what's planned and what was considered and deliberately left out, so the core stays small.

## Next

- Weekly digest alert ("airing this week" plus what you're behind on)
- Region setting for streaming links (AniList lists every region's services; "my services" covers most of it for now)
- Pick which Sonarr instance a new show is added to (extra instances are read-only for now)

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
| "No progress in 3 weeks, drop?" badge on My Shows | Needs last-watched dates from Plex/Jellyfin, which aren't read yet |
| Franchise ties without AniList links (Precure, Love Live! sister series) | Needs keyword or staff matching; AniList sequel links cover most franchises |
| Dual-audio / language preference for adds | Belongs in Sonarr's custom formats, which Tastearr already uses via your profile |
| Separate webhook keys for Sonarr and Radarr | One scoped key (not the admin key) is enough for a home setup |
| Several Radarr instances | Anime movies are few; one Radarr covers almost everyone |
| Staff, studio and PV embeds on cards; airing countdowns | AniChart-style extras; AniList's own page is one tap away |
| "New strong match" alerts as pre-air shows gain tags | Needs per-show alert history; the season alert covers the main moment |
| A separate read-only key for import lists | The webhook key already can't read or change anything else |
| Keyword "pseudo-tags" from titles and descriptions for pre-air shows with no tags anywhere | Measured as a small gain; must stay out of training to not hurt the main eval |
| Popularity snapshots at first sight, to evaluate pre-air scoring on real data | The pre-air floor is calibrated by simulation for now |
| Movie continuations judged by the last TV season watched | Rare; affects a few franchise films |
| Progress shown during a long first season download | One-time wait per season; the spinner says it can take a minute |
| Soft "never" (a penalty instead of hiding) | Testers expected "never" to mean never; hidden shows stay reachable under "Show hidden ones" |

## Decisions

- Prefer standard \*arr conventions over new ideas: Custom List import lists, a health page, a database backup, `/ping`, UMASK, unprivileged image.
- A new season the ID list hasn't mapped yet is matched through its earlier season in Sonarr (same TVDB series, next season number when TVDB lists it). A match picked by hand is saved only after Sonarr accepted it.
- Extra Sonarr instances count for "You have this" and can be monitored; new shows go to the main one.
- Popularity before a show airs gets a floor, because AniList numbers are tiny until it starts. Training weighs recent seasons more (0.9 per season back).
- Match % for a show you're watching never reads below 75–90%: the badge and the number shouldn't disagree.
- Auto-add is off by default and conservative: confident, mapped, non-short picks only; never anything rated down, hidden, seen, watched or followed; each show at most once; a per-season cap; same season-only monitoring as the Add button.
- "Never" means never: a genre or tag marked never always hides the show (it stays visible under "Show hidden ones", with the reason).
- Import lists contain only 👍 from the Picks page in the last four months, never quiz answers, so enabling a list can't pull in a back catalogue.
- Shows with almost no tags before airing borrow tags from their source manga or novel; a low score on such a show reads "Too early to tell".
- Login is always required once an account exists. "Not when I'm on my home network" matches Sonarr's "Disabled for local addresses" and never applies to proxied requests.
- Adding a sequel you don't own only monitors that season. When the season is unknown, only new episodes are monitored. Nothing is ever deleted.
- Match % is calibrated against your own history with `npm run eval`; 50% means you keep roughly 1 in 4 shows like it.
- Default sort is by match. The "Top pick" card never shows something you already have.

<p align="center"><img src="web/public/favicon.svg" width="72" alt="Tastearr"></p>

# Tastearr

**Anime season picks that know what you actually watch.** Tastearr learns your taste from your library, your watch history and your AniList/MAL list, then ranks every show in the new season for you. Add the ones you want to Sonarr or Radarr, or follow them and get an alert when each episode is out, with a link to where it streams.

- **Season picks, laid out like AniChart.** Shows are split into **Continuing**, **New**, **Shorts** and **Movies**. Each has a match score and the reason for it ("Continues Black Clover", "Isekai · Female Harem · like Hell Mode"). You can sort by match, popularity, AniList score, air time or title.
- **Weekly schedule.** Shows are laid out Monday to Sunday in your time zone, with how many you already follow each day. **Light days** come with the best picks airing then. Filter by day ("Monday shows") or by streaming service (Crunchyroll, Netflix, HIDIVE…).
- **Sequel-aware.** A new season of something you finished goes straight to the top. A sequel to something you dropped is pushed down.
- **Learns from everything you have:**
  - Sonarr and Radarr libraries.
  - Plex or Jellyfin/Emby watch progress, per season.
  - Your public AniList or MyAnimeList list: completed, scores, drops.
  - 👍/👎 on picks, and "Not into it anymore" on airing shows.
  - A **two-minute quiz** for brand-new users.
- **Works without the \*arrs.** No Sonarr? Press **Follow** and use Tastearr as a seasonal tracker that points you to legal streams.
- **One-click add** to Sonarr (as an anime series; for a sequel you don't own it monitors only the new season) or to Radarr for anime movies.
- **Phone alerts** through [ntfy](https://ntfy.sh), Gotify or Discord:
  - when Sonarr/Radarr finishes a download;
  - when a followed show airs;
  - when next season's picks are ready.
- **My Shows.** Your airing anime with watch progress, plus a "Not into it anymore" button that mutes alerts, teaches your profile, and can unmonitor the show in Sonarr.

Data comes from [AniList](https://anilist.co). ID mapping comes from [Fribb/anime-lists](https://github.com/Fribb/anime-lists).

## How it connects to your stack

| App | Access | What Tastearr does with it |
|---|---|---|
| **Sonarr** | API key, read + write | **Reads** your series list to learn what you picked.<br>**Writes:**<br>• Adds anime you choose, with your profile, root folder and tags, plus a `tastearr` tag.<br>• Can monitor a new season of a show you already have.<br>• Can unmonitor a show you drop.<br>It never deletes anything. |
| **Radarr** | API key, read + write | Same as Sonarr, for anime movies. |
| **Sonarr/Radarr webhook** | Sonarr/Radarr → Tastearr | Sends "new episode" and "movie ready" alerts, for anime only. Uses its own webhook key, not your admin key. |
| **Plex** | "Sign in with Plex", **read-only** | Reads watched episode counts and your ratings. Tastearr gets its own device token, which you can revoke in Plex → Authorized Devices. |
| **Jellyfin / Emby** | API key + user, **read-only** | Same as Plex. |
| **AniList / MyAnimeList** | Public list by username | Completed shows, scores and drops. MAL needs a free API client ID. |

Every connection is optional.

## Install

### Unraid

Add the template from [`unraid/tastearr.xml`](unraid/tastearr.xml), then open `http://<server>:8383`.

### Docker Compose

```yaml
services:
  tastearr:
    image: ghcr.io/moritranslates/tastearr:latest
    container_name: tastearr
    user: 1000:1000
    ports:
      - 8383:8383
    volumes:
      - ./tastearr:/config
      # optional, lets setup read Sonarr's API key; remove after setup
      - /path/to/sonarr/config:/appdata/sonarr:ro
    environment:
      - TZ=Etc/UTC
    restart: unless-stopped
```

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8383` | Web UI port |
| `TASTEARR_CONFIG` | `/config` | Database and settings |
| `TASTEARR_APPDATA` | `/appdata` | Where "Find my apps" looks for Sonarr's `config.xml` |
| `TRUST_PROXY` | | Your reverse proxy's IP/CIDR (e.g. `172.18.0.0/16`) or a hop count. `true` is refused because it would let anyone fake their IP. |
| `TASTEARR_ALLOWED_HOSTS` | | Extra hostnames allowed for the local-network login bypass (see Security) |

## Setup

The first visit asks you to create an account. A setup guide then walks you through Sonarr/Radarr, watch history, and your AniList/MAL list or the quiz. Each step explains what it's for and can be skipped.

For **phone alerts**:
1. Install ntfy and subscribe to a hard-to-guess topic.
2. Paste the topic's address under Settings → Alerts.
3. In Sonarr/Radarr, add a Webhook connection with **On Import** ticked, using the address shown in Settings.

## Security

- **An account is always required.** "Authentication required: **Disabled for local addresses**" works like it does in Sonarr. It only applies to direct connections from private IPs: anything arriving through a reverse proxy or tunnel needs a login unless `TRUST_PROXY` names that proxy. It's also ignored when the page is opened under an unknown hostname, which protects against DNS rebinding.
- **Secrets never go back to the browser.** That covers saved keys and tokens, and keys found by "Find my apps". A saved key is only re-used for the address it was saved with.
- **State-changing requests need a custom header** (CSRF protection). Request logs never include query strings or webhook keys.
- **Separate keys.** The admin API key (`X-Api-Key` header) is separate from the webhook key. Alert buttons use signed, expiring links.

## How the taste model works

**Training data:** every show from your last N seasons (8 by default), plus anything you've rated, listed or watched.

**Labels:** each show is labelled from your library, your watch progress and your list status. Labels are per TVDB season where possible, and long franchises are down-weighted.

**Lift:** for each genre, tag and source type (light novel, manga…), Tastearr works out how much more often than average you keep a show that has it. Smoothing stops rare tags from swinging it.

**Scoring a new show:**
- Mostly from its tags (genres count half), plus a popularity term that's relative within the season.
- A strong **franchise term**: did you finish, drop, or never see the previous season?
- Shows with very little tag data are pulled toward neutral and marked "rough guess". Pre-air shows borrow tags from their prequel.

**Quiz:** answers act as pseudo-counts. They matter on day one and fade as real data comes in.

## Development

```bash
npm install
TASTEARR_CONFIG=.devconfig npm run dev:server   # API on :8383
npm run dev:web                                 # Vite on :5173, proxies /api
npm run build && npm start
```

Requires Node 22.13+ (uses the built-in `node:sqlite`).

## Roadmap

- Regular TV seasons (TMDB/Trakt/TVmaze as the AniList equivalent)
- Several Sonarr/Radarr instances (anime, 4K)
- Overseerr/Jellyseerr request mode
- Household profiles (Plex Home users, Jellyfin users)
- "Still watching?" prompts and a weekly digest

## License

[GPL-3.0](LICENSE), the same licence Sonarr uses.

<p align="center"><img src="web/public/favicon.svg" width="72" alt="Tastearr"></p>

# Tastearr

Tastearr learns what kind of anime you actually watch and recommends each season's new shows, ranked for you. You tick the ones you want and they go straight into Sonarr.

- **Learns your taste automatically** from your Sonarr library and your Plex or Jellyfin/Emby watch history. Shows you finish count for more, and shows you drop after an episode count against.
- **Taste quiz** for new users, or anyone without a library to learn from. Mark genres Love / OK / Never, then rate about 30 well-known shows.
- **Seasonal picks** with a match score and the reason for it ("Isekai, Female Harem · like Hell Mode"). Browse the current, next or any past season.
- **One-click add to Sonarr** as an anime series, using your quality profile, root folder and tags. For a sequel to a show you don't have, it only monitors the new season.
- **My Shows**: your airing anime with watch progress and a "Not into it anymore" button. Dropping a show stops its alerts, teaches the taste model, and can unmonitor it in Sonarr.
- **Phone alerts** through [ntfy](https://ntfy.sh), Gotify or Discord: one when a new episode lands, and one when next season's picks are ready.
- **Auto-detect**: mount your appdata folder read-only and Tastearr reads the Sonarr API key and Plex token itself.

Show data comes from [AniList](https://anilist.co). AniList-to-TVDB matching uses [Fribb/anime-lists](https://github.com/Fribb/anime-lists).

## Install

### Unraid

Add the template from [`unraid/tastearr.xml`](unraid/tastearr.xml), or use Docker → Add Container with the settings below. Then open `http://<server>:8383`.

### Docker Compose

```yaml
services:
  tastearr:
    image: ghcr.io/moritranslates/tastearr:latest
    container_name: tastearr
    ports:
      - 8383:8383
    volumes:
      - ./tastearr:/config
      # optional, for one-click setup:
      - /path/to/appdata:/appdata:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped
```

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8383` | Web UI port |
| `TASTEARR_CONFIG` | `/config` | Database and settings |
| `TASTEARR_APPDATA` | `/appdata` | Where auto-detect looks for `*sonarr*/config.xml` and Plex's `Preferences.xml` |
| `TASTEARR_HOST_IP` | | Your server's LAN IP, so auto-detect can build URLs for apps on bridge networking |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy so local-network login bypass sees real client IPs |

Auto-detect reads container addresses from the Docker socket. If you run the container as a non-root user (for example `--user 99:100`), that user needs read access to the socket, or you can type the addresses yourself.

## Setup

1. **Settings → Sonarr**: enter the URL and API key (or click **Find my apps**), click **Test & load options**, then pick your anime quality profile and root folder.
2. **Settings → Watch history**: choose Plex or Jellyfin, test it, and tick your anime libraries.
3. No library yet? Take the **Quiz**.
4. **Alerts** (optional):
   - Install the ntfy app on your phone and subscribe to a hard-to-guess topic.
   - Paste the topic URL into Settings.
   - In Sonarr, add a Webhook connection with **On Import** ticked, pointing at the URL shown in Settings. That turns on new-episode alerts.
   - To get the "Not into it anymore" button on alerts, set the address your phone can reach Tastearr at.

## How the taste model works

Tastearr looks at every show that aired in your last N seasons (8 by default), and at anything you've rated. For each genre and tag it works out how much more often than average you keep a show with it, smoothed so that rare tags don't swing the result. This is the **×** number on the Taste page.

A new show's score combines the average and the strongest of its genre/tag numbers, plus a small boost for popularity. Shows with only a few genres/tags are pulled toward neutral. The match percentage is that score on a 0–100 scale. "Like …" names the favourite whose genres and tags overlap most with the new show.

## Development

```bash
npm install
npm run dev:server   # API on :8383 (set TASTEARR_CONFIG=.devconfig)
npm run dev:web      # Vite on :5173, proxies /api
npm run build && npm start
```

Requires Node 22.13+ (uses the built-in `node:sqlite`).

## Roadmap

- Radarr: anime movies and regular films
- Regular TV via TMDB/Trakt
- Multiple user profiles (household members)
- Plex Home managed users

## License

[GPL-3.0](LICENSE), the same licence Sonarr uses.

# Changelog

## Unreleased

- New filter, on by default: "Skip explicit shorts" (Settings, Picks). The user likes ecchi and fan service but dislikes
  pure porn, and dropped three Fall 2026 shows that show actual sex (My Girlfriend's Friend, Now That I Can Control
  Reality With A Mouse Cursor, I'm Dating a Dark Summoner). They are short (TV_SHORT, 6-12 min), tagged Ecchi with a very
  high Nudity rank, and not flagged adult by AniList, so they slipped through. A show is now never picked or
  auto-added when it is 15 minutes or less (episode length when known, otherwise the format), has the Ecchi genre and a
  Nudity tag rank of 75 or more. Full-length ecchi is not affected. Profile training is unchanged: a drop alone can't
  fix this, because the profile learns traits that these shows share with ecchi the user likes.

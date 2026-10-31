# MALRI Player TV Listings

The MALRI view is available at `/malri`. It shows an archive of actual successful
Telegram publications, including the original captions and a retained copy of
each successfully sent poster. It does not read Telegram history or trigger a
Telegram send when someone opens or refreshes the page.

## Enable a channel

In **Channels > Edit**, enable **Show published posts in MALRI Player** and save.
Channels are excluded by default. Disabling the setting also hides their
previously archived posts and images from the feed immediately.

New posts appear after the next successful publication by the existing bot.
Older posts, whose temporary files have already been deleted, are not imported.
Text fallbacks stay text-only, so the feed does not claim that a rejected image
was published. Telegram tokens, private channel IDs and message IDs are never
returned by the feed.

## Endpoints

- `GET /api/malri/posts`: sanitized active posts, UK timezone and refresh time.
- `GET /api/malri/posters/<32-character-id>`: the retained image for an active,
  enabled post. Invalid, disabled and expired IDs return 404.
- `GET /malri`: the MALRI Player view, with poster details, filters and keyboard
  or TV remote navigation. It uses only same-origin assets and no CDN.

Storage is under `storage/malri-feed/`, outside the public document root. The
archive is bounded to 400 active posts and seven days. Listings normally expire
with the configured Telegram expiry time. Archive errors are logged without
changing the existing bot's send or duplicate-prevention behavior.

## Hosting repair

This deployment uses Node.js with `httpdocs/public` as its document root. A
subscription-level PHP front-controller rule must exempt the exact hostname
`telegram.defecttracker.uk`, retaining the existing private-file access rules.
Otherwise paths such as `/admin/channels` loop through a nonexistent `index.php`
and Apache reports AH00124 / HTTP 500. Do not raise the redirect limit.

## Checks

`node --test tests/malri_feed.test.js` checks opt-in, caption fidelity, image
retention, expiry, disabled sources, private data exclusion, duplicate IDs,
bounded retention and damaged-index handling. The suite is also included in
`npm test`. These checks do not send messages or call a remote provider.

# reddit-queue

Relays a Reddit queue to Discord. Install from [Devvit](https://developers.reddit.com/apps/modqueue2discord), and [configure a webhook URL](https://support.discord.com/hc/articles/228383668) where the mod queue should be sent. App is [open source](https://github.com/KockaAdmiralac/reddit-queue) and available on GitHub. You can submit feedback through [GitHub Issues](https://github.com/KockaAdmiralac/reddit-queue/issues).

## Screenshots

| Posts | Comments |
| ----- | -------- |
| ![Post "b3p15" by u/KockaAdmiralac being filtered by AutoModerator.](https://i.redd.it/f4loqrbpspdg1.png) | ![Comment that says "This is a comment that says boopis" by u/KockaAdmiralac being filtered by AutoModerator.](https://i.redd.it/gsganrbpspdg1.png) |

## Changelog

### v0.0.5

When Discord returns an HTTP error, Devvit throws an exception rather than setting [`Response.ok`](https://developer.mozilla.org/en-US/docs/Web/API/Response/ok). This error should now be handled.

### v0.0.4

Initial release to Devvit. Previously used to use the Reddit Data API. For this version, check [commit 696e04](https://github.com/KockaAdmiralac/reddit-queue/tree/696e04815282a3b42625c31a2b3b8632c7cd9178).

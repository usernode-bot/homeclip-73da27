# Demo media

Files here are staging demo fixtures only (see `server.js`'s seed block):

- `demo-subs.vtt` — fake captions for the HLS demo episode (9000012).
- `demo-video.webm` — a 10-second Big Buck Bunny clip (CC BY 3.0,
  Blender Foundation, via test-videos.co.uk), VP9 in WebM so playback
  works in every browser, including headless ones with no H.264 decoder.
  Serves demo episode 9000063 and exercises the Downloads flow on a
  same-origin source.

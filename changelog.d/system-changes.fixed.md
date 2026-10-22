- A summarizer request no longer carries an empty turn, or a `---` separator
  with nothing after it, where a message left empty for it sat, as one of
  thinking alone was: merging consecutive messages passes over an empty one,
  and its neighbours join as they would without it.
- With the head window disabled (`headWindowTokens: 0`), a compile after
  `resetHeadWindow` under `adaptiveResolution` no longer sends history from
  before the reset twice, and under kv-unified no longer throws
  `CanonicalForestError` (`duplicate-chunk-id`) for it: the middle's ranges
  overlapped each other, and the recent window when it starts before the
  reset.
- A `WindowedPassthroughStrategy` compile that refuses no longer moves the
  window's anchor; only a compile that sends does. So a retry with a larger
  budget still sends the older turns that fit.
- `getRenderStats()` before the first compile no longer counts a message in
  both the head and the tail when the recent window starts inside the head
  window: the tail starts where the head ends, as a compile's does.

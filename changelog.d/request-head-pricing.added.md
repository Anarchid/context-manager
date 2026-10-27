- `SelectOptions.requestHead` and `RenderStats.request`: a compile given its
  request's head, the system prompt and tool definitions it sends (the
  existing `RequestOverhead`), reports what the request carries besides the
  rendered context: `headTokens` for the head and `injectedTokens` for the
  compile's message-position injections. Both are in the units of `total` at
  the compile's multiplier, priced as a calibration sample prices them. A compile
  given no head reports no `request`, and a head changes nothing the compile
  selects. The head's price is the store's estimate of the system prompt and
  of the tool definitions as JSON, not the provider's count. This is the
  report #323 asked for in its second fix.
- `RenderStats.calibration.ceiling`: the largest multiplier the strategy
  applies, 1.8, reported with every calibration. A multiplier learned or
  loaded above it is applied at it, as before.

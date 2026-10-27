- `recoverLiteralThinkingWrappedCompression` on `AutobiographicalConfig` (off
  by default): for a model without native reasoning that writes a whole
  compression or merge answer inside one closed literal `<thinking>…</thinking>`
  text wrapper, the strategy keeps the prose inside it as the memory, where it
  stripped the answer to nothing and went on to the plain-prose retry. Only that
  exact shape is recovered: one wrapper around the whole answer, in a response
  with text blocks only. A single leading wrapper followed by public prose keeps
  the prose after it, as before. Any other think-like markup under the option,
  more than one wrapper or one beside a native reasoning block, leaves the
  answer empty, so it takes the retry and quarantine path rather than storing
  control-shaped text. A recovered answer is stored and replayed as its plain
  prose, and logs `compression:literal-thinking-wrapper-recovered`.

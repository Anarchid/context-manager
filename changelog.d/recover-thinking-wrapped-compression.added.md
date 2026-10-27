- `recoverLiteralThinkingWrappedCompression` on `AutobiographicalConfig` (off
  by default): for a model without native reasoning that writes a whole
  compression or merge answer inside one closed literal `<thinking>…</thinking>`
  (or `<think>…</think>`) text wrapper, the strategy keeps the prose inside it
  as the memory, where it stripped the answer to nothing and went on to the
  plain-prose retry. Only that shape is read differently: an answer of text
  blocks alone, one wrapper around all of it, no tag in its body. Every other
  answer is read exactly as with the option off, so the option never drops or
  changes a memory the default reading stores. A recovered answer is stored as
  its plain prose, with no replay carrier, as any text-only answer, and logs
  `compression:literal-thinking-wrapper-recovered`, with the summary's id, once
  the summary is stored.

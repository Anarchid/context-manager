- `recoverLiteralThinkingWrappedCompression` on `AutobiographicalConfig` (off
  by default): for a model without native reasoning that writes a whole
  compression or merge answer inside one closed literal `<thinking>…</thinking>`
  (or `<think>…</think>`) text wrapper, the strategy keeps the prose inside it
  as the memory, where it stripped the answer to nothing and went on to the
  plain-prose retry. Only that shape is read differently: an answer of text
  blocks alone, one wrapper around all of it, no tag in its body. Every other
  answer is read exactly as with the option off, so the option never drops a
  memory the default reading stores: the one shape it reads differently is
  stored as the prose inside the wrapper (the default strips a `<thinking>`
  wrapper to nothing and keeps a `<think>` one verbatim, tags included). The
  drain script passes the option through from a recipe too. A recovered answer is stored as
  its plain prose, with no replay carrier, as any text-only answer, and logs
  `compression:literal-thinking-wrapper-recovered`, with the summary's id, once
  the summary is stored.

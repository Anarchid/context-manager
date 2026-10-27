- `recoverLiteralThinkingWrappedCompression` on `AutobiographicalConfig` (off
  by default): for a model without native reasoning that writes a whole
  compression or merge answer inside one closed literal `<thinking>…</thinking>`
  (or `<think>…</think>`) text wrapper, the strategy keeps the prose inside it
  as the memory, where it stripped the answer to nothing and went on to the
  plain-prose retry. It reads only an answer of text blocks alone that opens
  with a plain `<thinking>` or `<think>` tag; any other answer, one with native
  reasoning beside its text included, is read as before. Among those it reads:
  one leading wrapper followed by prose keeps that prose verbatim, mentions of
  tags in it included; a leading wrapper with another opening tag inside it
  (nesting), or followed at once by another tag (wrappers back to back), or by
  nothing, counts as empty and takes the retry, rather than storing
  control-shaped text; an opening tag never closed counts as empty. A recovered answer
  is stored as its plain prose, with no replay carrier, as any text-only answer,
  and logs `compression:literal-thinking-wrapper-recovered`.

- `recoverLiteralThinkingWrappedCompression` on `AutobiographicalConfig` (off
  by default): for a model without native reasoning that writes a whole
  compression or merge answer inside one closed literal `<thinking>…</thinking>`
  (or `<think>…</think>`) text wrapper, the strategy keeps the prose inside it
  as the memory, where it stripped the answer to nothing and went on to the
  plain-prose retry. It reads only an answer of text blocks alone; one with
  native reasoning beside its text is read as before. An answer that opens with
  a leading wrapper followed by public prose keeps that prose, as before, unless
  what would be kept is still tag-shaped (another wrapper, or a close tag that
  ends something the preamble opened): that answer counts as empty and takes the
  retry, rather than storing control-shaped text. A mention of a thinking tag
  mid-content stays content. A recovered answer is stored as its plain prose,
  with no replay carrier, as any text-only answer, and logs
  `compression:literal-thinking-wrapper-recovered`.

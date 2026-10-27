- `recoverLiteralThinkingWrappedCompression` on `AutobiographicalConfig` (off
  by default): for a model without native reasoning that writes a whole
  compression or merge answer inside one closed literal `<thinking>…</thinking>`
  (or `<think>…</think>`) text wrapper, the strategy keeps the prose inside it
  as the memory, where it stripped the answer to nothing and went on to the
  plain-prose retry. It reads only an answer of text blocks alone that opens
  with a plain `<thinking>` or `<think>` tag; any other answer, one with native
  reasoning beside its text included, is read as before. Among those it reads:
  a whole-answer wrapper whose body holds more tags (nested, or several
  wrappers back to back) counts as empty and takes the retry, rather than
  storing control-shaped text; one leading wrapper followed by prose keeps that
  prose verbatim, mentions of tags in it included, unless it starts with
  another tag; an opening tag never closed counts as empty. A recovered answer
  is stored as its plain prose, with no replay carrier, as any text-only answer,
  and logs `compression:literal-thinking-wrapper-recovered`.

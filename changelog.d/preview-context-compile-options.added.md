- `ContextManager.previewContext`'s `opts` takes the select options a compile
  takes, all but `dryRun`, which a preview always sets: `identity`,
  `kvUnifiedImmutablePrefixHash` and `kvUnifiedContinuityRelaxation` beside
  `thinkingBinding`. Its dry select passes them on, so a kv-unified agent's
  preview runs with the prefix hash and continuity relaxation its compile
  uses. A dry select, a preview's or a `dryRun` compile's, now logs no
  `[kv-continuity-relaxation]` line, since a dry run isn't the live state.

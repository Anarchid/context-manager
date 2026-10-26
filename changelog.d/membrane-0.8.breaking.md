- **Callers that construct a `Membrane` and pass it to context-manager:**
  context-manager now depends on `@animalabs/membrane` `^0.8.0` (was
  `^0.7.1`). If your own membrane stays on 0.7, npm installs a second copy
  for context-manager, and TypeScript refuses your `Membrane` where
  context-manager takes one ("Property 'abortOutcome' is missing …",
  TS2741). JavaScript isn't refused, but context-manager then runs on a
  membrane 0.7 instance, which this release's tests don't cover.
  - **Migration:** take `@animalabs/membrane` `^0.8.0` alongside this
    release, so context-manager shares your copy.
  - **Unchanged:** context-manager's own code. This change moves only its
    membrane range, and membrane 0.8.0's changelog lists no breaking change.

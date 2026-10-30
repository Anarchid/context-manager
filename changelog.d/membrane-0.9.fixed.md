- **Hosts on membrane 0.9.0:** context-manager asked for
  `@animalabs/membrane` `^0.8.0` and now accepts `^0.8.0 || ^0.9.0`, so a
  host on either version shares its copy with context-manager. Before, a
  host on 0.9.0 got a second membrane installed for context-manager, and
  TypeScript refused the host's `Membrane` where context-manager takes one
  ("Type 'import("…/membrane").Membrane' is not assignable to type
  'import("…/membrane").Membrane'", TS2322). A host on 0.8 changes nothing.
  - **Unchanged:** context-manager's own code, which uses nothing membrane
    0.9.0 adds, and the requests membrane sends for it. Through the
    Anthropic, OpenRouter and an OpenAI-compatible adapter, with a system
    prompt, an image, a tool call and its result and a cache breakpoint,
    and with thinking, by `complete()`, `stream()` and `streamYielding()`,
    membrane 0.9.0 sent the same method, path, headers and body as 0.8.0 in
    all 36 cases compared.
  - The lockfile now installs 0.9.0, so this release's tests run on it; the
    same code ran on 0.8.0 before this change. membrane 0.9.0's own changes
    reach context-manager's calls when the host's `Membrane` is 0.9;
    membrane's changelog for 0.9.0 says what they are.

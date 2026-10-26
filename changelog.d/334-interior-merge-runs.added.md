- `getStrandedSummaries()` lists the summaries no merge can take as the store
  stands: each summary left alone at its level, in a run of one that is
  neither the newest nor waiting, with its level, its tokens and the holes of
  its level or below beside it (a quarantined chunk or merge, by its record's
  key, or an operator hold), and their tokens together. A stray beside a hole
  may merge once the hole fills, with what lands there. It reads the newest
  run as the merge check
  does, so a summary alone in the last run of its level isn't listed until
  something of its level lands past it. Its cost grows with the store, since
  it places every message, so it suits an audit rather than every request,
  and `getCompressionDebt()`, which a host reads on every provider call,
  doesn't call it. When it can't read what it needs, it
  returns no list and says why. `audit-topology` prints each stray with what
  heals it (#334).
- `repair-topology --mode rebuild` gives a partner, where it can free one, to
  each summary the store would leave alone at its level once re-folded: a
  crossed summary's child, the messages it releases from a crossed L1 (which
  the chunker re-chunks where they stand), a summary already stranded, and a
  summary the re-fold would make alone, such as a dissolved tower's top. It
  dissolves the tower over one neighbour of that level, the side whose tower
  holds fewer leaves, passing over a side whose neighbour would still be held,
  too wide or queued, or whose tower holds a stale generation (an L1 no
  chunk record names, over messages another L1's record holds), which stays
  where it is and is named where that side would partner the stray; a
  stray that is itself a stale generation gets no partner. It does this on a store with nothing crossed too, so a
  rebuild heals the strays it can. It projects the re-fold as a drain lands
  it, queued merges first and then the lowest level first, and reads a run
  with a summary of a higher level after it as one that can't grow, since
  what the live end makes forms past that summary. It plans over the summaries as
  the strategy's loader keeps them, and `--apply` writes that store with
  the plan's changes; the open that verifies it fails the script (exit 2)
  if it changes or drops anything written, and counts the chunk records it
  appends. The
  rule reads the resident's settings,
  which the store doesn't hold, so the script takes them as flags
  (`--merge-threshold`, `--merge-max-span` and `--merge-hold`, each also as
  `--flag=value`, and `--no-speculative-production`) and prints the values it
  used; `audit-topology` takes the same flags for its stray list. The plan
  lists each partner as `partner …`, and each summary it can't partner as
  `STILL STRANDED …` with why. With `--rebuild-since`, no tower that starts
  before the cutoff is dissolved to give a summary a partner.
- `drain-autobiographical` lands the store as the rebuild's plan projected
  it. It picks merges bottom up: none while a chunk or a merge is queued,
  then the lowest level's group, so a group beside a released chunk's
  summary or a lower merge's is picked once that summary has landed. And it
  reads runs as the planner does, so a run with a summary of a higher level
  after it merges as one that can't grow. Its start line prints the run
  settings its strategy merges by (`runs`), the holdback among them, and
  each line says whether merge picks wait for queued work
  (`mergesUnpicked`); it finishes only once none do. Its finish line says
  why it stopped (`stopped`: drained, max-steps, tick-error or
  debt-unreadable), and run again with the same flags it goes on from the
  store as it stands; a resident restarted on a store it leaves unfinished
  finishes by its own rules and can leave strays the audit lists;
  its usage names `--recipe`, `--tools-log` and `--clear-merge-quarantine`.
  A strategy subclass can
  merge the same way by overriding the protected `landsAsPlanned()`.

- `previewContext`'s `opts.excludePins`: pin and document-mark ids, as
  `pinRange` and `markDocument` return them, that the preview's dry select
  reads as absent, so a caller can ask whether a compile would fit were they
  unpinned without unpinning them. Nothing is unpinned or written, and the
  option adds no log call; an id no pin has is ignored, and no compile
  takes the option.

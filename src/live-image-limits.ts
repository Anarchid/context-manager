/**
 * The live-image window's limits, clamped to the request ceilings.
 *
 * A strategy's live window keeps the images it counts (top-level image
 * blocks; see `AutobiographicalConfig.maxLiveImages`) newest-first up to a
 * count (`maxLiveImages`) and a byte budget (`maxLiveImageBytes`). The
 * request ceilings (`maxRequestImages`, `maxRequestImageBytes`) are the most
 * one request may carry, so the window's own limits never exceed them: an
 * unlimited (0) target means "up to the ceiling", and a target above the
 * ceiling keeps the ceiling's worth. What the window doesn't count, it
 * doesn't bound. A caller that appends to a compiled request without
 * recompiling, such as a turn's continuation rounds, can read both through
 * the strategy's `liveImageLimits()` and stop below the ceiling; nothing
 * here bounds what it appends.
 */

import type { LiveImageLimits } from './types/strategy.js';

/**
 * The provider refuses a request carrying more than 600 images and documents
 * together ("too many images and documents: 601 + 0 > 600", measured
 * 2026-10-13 and again on 2026-10-19). 500 leaves room for documents, which
 * nothing here counts, and for image blocks a host adds outside the compile.
 */
export const DEFAULT_MAX_REQUEST_IMAGES = 500;

/**
 * membrane refuses, before sending it, a request whose serialized messages
 * exceed its byte cap: 28 MiB unless `MEMBRANE_MAX_REQUEST_BYTES` says
 * otherwise (membrane 0.5.87 and 0.6.0, `assertWithinByteBudget`, checked at
 * every round of a tool loop). 24 MiB of base64 images leaves 4 MiB of that
 * default cap for everything else the messages carry: their text, their JSON,
 * and any documents or other media.
 */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 24 * 1024 * 1024;

/** A window limit as the window reads it: a whole number of 1 or more, or 0
 *  for none. Any value that isn't a positive finite number (0, a negative,
 *  NaN, Infinity) is none, as the window's own checks (`limit > 0 && kept >=
 *  limit`) already read it. A fraction is floored, to at least 1, so the
 *  limit reported is the limit kept. */
function asLimit(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 0;
}

/** Whether a configured ceiling is one the window can read: 0 (none), or a
 *  finite number above 0. */
function wellFormedCeiling(value: number): boolean {
  return value === 0 || (Number.isFinite(value) && value > 0);
}

/** A ceiling as configured: 0 is none, a finite number above 0 is floored to
 *  at least 1, and any other value (a negative, NaN, Infinity) takes the
 *  default, so a malformed config doesn't remove the bound (the warning names
 *  it). */
function asCeiling(value: number, fallback: number): number {
  return wellFormedCeiling(value) ? asLimit(value) : fallback;
}

/**
 * `target` kept within `ceiling`, where 0 means no limit for either: an
 * unlimited target becomes the ceiling, and no ceiling leaves the target as
 * it is. A target that isn't a positive finite number counts as unlimited,
 * as the window's own checks already treat it. `ceiling` is one
 * resolveLiveImageLimits gives.
 */
export function clampToCeiling(target: number, ceiling: number): number {
  const c = asLimit(ceiling);
  const t = asLimit(target);
  if (c === 0) return t;
  return t === 0 ? c : Math.min(t, c);
}

/** The window's configured limits, the defaults applied where unset. */
export interface ConfiguredImageLimits {
  maxLiveImages: number;
  maxLiveImageBytes: number;
  maxRequestImages: number;
  maxRequestImageBytes: number;
}

/** The limits a strategy's window applies, and the ceilings above them. */
export function resolveLiveImageLimits(configured: ConfiguredImageLimits): LiveImageLimits {
  const ceiling = {
    images: asCeiling(configured.maxRequestImages, DEFAULT_MAX_REQUEST_IMAGES),
    bytes: asCeiling(configured.maxRequestImageBytes, DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  };
  return {
    target: {
      images: clampToCeiling(configured.maxLiveImages, ceiling.images),
      bytes: clampToCeiling(configured.maxLiveImageBytes, ceiling.bytes),
    },
    ceiling,
  };
}

const MiB = 1024 * 1024;

/** A byte figure as the strategies' lines give it: in MiB when it's a whole
 *  number of them, and in bytes otherwise, so two figures that differ never
 *  read alike. */
function showBytes(n: number): string {
  return n % MiB === 0 ? `${n / MiB} MiB` : `${n} bytes`;
}

/**
 * The " (default)" a line puts after a setting whose value is a default: one
 * the host didn't give (`defaulted`), or a ceiling it gave malformed, which
 * takes its default (see asCeiling).
 */
function defaultMark(
  name: string,
  configured: ConfiguredImageLimits,
  defaulted: ReadonlySet<string>,
): string {
  const malformedCeiling = (name === 'maxRequestImages' || name === 'maxRequestImageBytes') &&
    !wellFormedCeiling(configured[name]);
  return defaulted.has(name) || malformedCeiling ? ' (default)' : '';
}

/**
 * Which of the window's limits a request ceiling sets: a limit the host gave
 * as none (0, or anything that isn't a positive finite number) or above its
 * ceiling, where that ceiling is itself a limit. The window then keeps the
 * ceiling's worth. (With no ceiling the window keeps the limit as given, so
 * the two never match there.)
 */
export function ceilingSetLimits(configured: ConfiguredImageLimits): { images: boolean; bytes: boolean } {
  const { target, ceiling } = resolveLiveImageLimits(configured);
  return {
    images: target.images === ceiling.images && asLimit(configured.maxLiveImages) !== ceiling.images,
    bytes: target.bytes === ceiling.bytes && asLimit(configured.maxLiveImageBytes) !== ceiling.bytes,
  };
}

/**
 * The line a strategy says once for each ceiling, the first time an image
 * falls past a ceiling that sets the window's limit (see ceilingSetLimits):
 * which ceiling, at what value, and the window limit of 0 or above it that
 * the ceiling held, so an operator who set no limit sees where one now
 * applies. An image falls past the count ceiling when the window already
 * keeps the ceiling's worth, and past the byte ceiling when it doesn't fit
 * with what's kept, a single image bigger than the ceiling included.
 */
export function ceilingBoundLine(
  strategy: string,
  kind: 'images' | 'bytes',
  configured: ConfiguredImageLimits,
  defaulted: ReadonlySet<string>,
): string {
  const ceiling = resolveLiveImageLimits(configured).ceiling;
  const [ceilingName, limitName, value, show] = kind === 'images'
    ? ['maxRequestImages', 'maxLiveImages', configured.maxLiveImages, String] as const
    : ['maxRequestImageBytes', 'maxLiveImageBytes', configured.maxLiveImageBytes, showBytes] as const;
  const limit = asLimit(value) === 0 ? `${value} (no limit)` : show(asLimit(value));
  const mark = (name: string) => defaultMark(name, configured, defaulted);
  return `[${strategy}] an image fell past ${ceilingName} ${show(ceiling[kind])}${mark(ceilingName)}, ` +
    `which holds ${limitName} ${limit}${mark(limitName)} to it, so images past it are now shown as placeholders`;
}

/**
 * The warning a strategy gives once, when it initializes, or null when there
 * is nothing to say: a ceiling configured as something other than 0 or a
 * finite number above it, which takes the default, and a limit (not 0) above
 * its ceiling, which is kept at the ceiling. `maxCompressionImageBytes`, when
 * given, is the compression prompt's byte budget, held to the byte ceiling
 * too. `defaulted` names the settings the host didn't give, which the line
 * marks "(default)", so a host isn't told about a setting as if they had
 * made it. A byte figure reads in MiB when it's a whole number of them.
 */
export function liveImageLimitsWarning(
  strategy: string,
  configured: ConfiguredImageLimits & { maxCompressionImageBytes?: number },
  defaulted: ReadonlySet<string>,
): string | null {
  const said: string[] = [];
  const ceiling = resolveLiveImageLimits(configured).ceiling;
  const count = (n: number) => String(n);
  const bytes = showBytes;
  const setting = (name: string, shown: string) => `${name} ${shown}${defaultMark(name, configured, defaulted)}`;
  if (!wellFormedCeiling(configured.maxRequestImages)) {
    said.push(`maxRequestImages ${configured.maxRequestImages} isn't 0 or a finite number above it, so the default ${count(ceiling.images)} applies`);
  }
  if (!wellFormedCeiling(configured.maxRequestImageBytes)) {
    said.push(`maxRequestImageBytes ${configured.maxRequestImageBytes} isn't 0 or a finite number above it, so the default ${bytes(ceiling.bytes)} applies`);
  }
  const above = (
    name: string, value: number | undefined, ceilingName: string, limit: number, keeps: string, show: (n: number) => string,
  ) => {
    const v = value === undefined ? 0 : asLimit(value);
    if (limit > 0 && v > limit) {
      said.push(`${setting(name, show(v))} is above ${setting(ceilingName, show(limit))}, so ${keeps} at most ${show(limit)}`);
    }
  };
  above('maxLiveImages', configured.maxLiveImages, 'maxRequestImages', ceiling.images, 'the live window keeps', count);
  above('maxLiveImageBytes', configured.maxLiveImageBytes, 'maxRequestImageBytes', ceiling.bytes, 'the live window keeps', bytes);
  above('maxCompressionImageBytes', configured.maxCompressionImageBytes, 'maxRequestImageBytes', ceiling.bytes, 'a compression prompt keeps', bytes);
  return said.length === 0 ? null : `[${strategy}] ${said.join('; ')}`;
}

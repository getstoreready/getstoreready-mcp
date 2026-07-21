import type { DesignLayer, RunLike } from './design-utils.js';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'in',
  'on',
  'the',
  'to',
  'with',
  'your',
]);

export type HighlightStyleKind = 'pill' | 'accent' | 'mixed' | null;

export interface HighlightHint {
  style: HighlightStyleKind;
  /** Phrase that was highlighted in the template (for agent context). */
  sourcePhrase?: string;
}

export function detectHighlightHint(runs: RunLike[] | undefined): HighlightHint {
  if (!runs?.length) return { style: null };

  const pill = runs.find((r) => r.bg && r.text.trim());
  const accent = runs.find((r) => (r.italic || r.color) && r.text.trim() && !r.bg);

  if (pill && accent) {
    return {
      style: 'mixed',
      sourcePhrase: [accent.text.trim(), pill.text.trim()].filter(Boolean).join(' / '),
    };
  }
  if (pill) return { style: 'pill', sourcePhrase: pill.text.trim() };
  if (accent) return { style: 'accent', sourcePhrase: accent.text.trim() };
  if (runs.length > 1) return { style: 'accent' };
  return { style: null };
}

function hasStyledRuns(runs: RunLike[]): boolean {
  return runs.some((r) => r.bg || r.italic || r.color || r.weight);
}

function findPhraseSpan(haystack: string, needle: string): { start: number; end: number } | null {
  const n = needle.trim();
  if (!n) return null;
  const exact = haystack.indexOf(n);
  if (exact >= 0) return { start: exact, end: exact + n.length };
  const ci = haystack.toLowerCase().indexOf(n.toLowerCase());
  if (ci >= 0) return { start: ci, end: ci + n.length };
  return null;
}

function pickHighlightStyle(sourceRuns: RunLike[]): Omit<RunLike, 'text'> {
  const hit =
    sourceRuns.find((r) => r.bg) ?? sourceRuns.find((r) => r.italic || r.color);
  if (!hit) return {};
  return {
    bg: hit.bg,
    color: hit.color,
    italic: hit.italic,
    weight: hit.weight,
  };
}

function rebuildRunsWithPhrase(
  sourceRuns: RunLike[],
  text: string,
  phrase: string,
): RunLike[] | null {
  const style = pickHighlightStyle(sourceRuns);
  const span = findPhraseSpan(text, phrase);
  if (!span) return null;

  const runs: RunLike[] = [];
  if (span.start > 0) runs.push({ text: text.slice(0, span.start) });
  runs.push({
    bg: style.bg,
    color: style.color,
    italic: style.italic,
    weight: style.weight,
    text: text.slice(span.start, span.end),
  });
  if (span.end < text.length) runs.push({ text: text.slice(span.end) });
  return runs.length ? runs : null;
}

function pickAccentWord(words: string[]): string | null {
  if (!words.length) return null;
  if (words.length === 1) return words[0]!;
  let best = words[0]!;
  let bestScore = -1;
  const mid = Math.floor(words.length / 2);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const base = STOP_WORDS.has(w.toLowerCase()) ? 0 : w.length;
    const score = base + (i === mid ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = w;
    }
  }
  return best;
}

/** Bear-style middle word accent (italic / color). */
function rebuildAccentRuns(sourceRuns: RunLike[], text: string, phrase?: string): RunLike[] {
  const accentRun =
    sourceRuns.find((r) => r.italic && r.text.trim()) ??
    sourceRuns.find((r) => r.color && r.text.trim() && !r.bg);
  if (!accentRun) return rebuildProportionalRuns(sourceRuns, text);

  const style: Omit<RunLike, 'text'> = {
    color: accentRun.color,
    italic: accentRun.italic,
    weight: accentRun.weight,
  };

  const trimmed = text.trim();
  const explicit = phrase?.trim();
  if (explicit) {
    const byPhrase = rebuildRunsWithPhrase(sourceRuns, trimmed, explicit);
    if (byPhrase) return byPhrase;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [{ ...style, text: trimmed }];

  const accentWord = explicit && words.includes(explicit) ? explicit : pickAccentWord(words);
  if (!accentWord) return [{ text: trimmed }];

  const idx = trimmed.toLowerCase().indexOf(accentWord.toLowerCase());
  if (idx < 0) return rebuildProportionalRuns(sourceRuns, text);

  const runs: RunLike[] = [];
  if (idx > 0) runs.push({ text: trimmed.slice(0, idx) });
  runs.push({ ...style, text: trimmed.slice(idx, idx + accentWord.length) });
  if (idx + accentWord.length < trimmed.length) {
    runs.push({ text: trimmed.slice(idx + accentWord.length) });
  }
  return runs;
}

/** Pill / hashtag highlight (Bear "#tags" screens). */
function rebuildPillRuns(sourceRuns: RunLike[], text: string, phrase?: string): RunLike[] {
  const pillRun = sourceRuns.find((r) => r.bg && r.text.trim());
  if (!pillRun) return rebuildProportionalRuns(sourceRuns, text);

  const style: Omit<RunLike, 'text'> = {
    bg: pillRun.bg,
    color: pillRun.color,
    italic: pillRun.italic,
    weight: pillRun.weight,
  };

  const trimmed = text.trim();
  const explicit = phrase?.trim();

  const hash = explicit?.startsWith('#') ? explicit : trimmed.match(/#[\w-]+/)?.[0];
  if (hash) {
    const byHash = rebuildRunsWithPhrase(sourceRuns, trimmed, hash);
    if (byHash) return byHash;
  }

  if (explicit) {
    const byPhrase = rebuildRunsWithPhrase(sourceRuns, trimmed, explicit);
    if (byPhrase) return byPhrase;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2) return [{ ...style, text: trimmed }];

  const keyword = words[words.length - 1]!;
  const before = trimmed.slice(0, trimmed.length - keyword.length);
  return [{ text: before }, { ...style, text: keyword }];
}

function snapRunStartCut(
  dst: string,
  prev: number,
  target: number,
  srcRun: RunLike | undefined,
): number {
  const lo = Math.max(prev + 1, target - 6);
  const hi = Math.min(dst.length, target + 6);
  const srcStartsWithSpace = !!srcRun?.text.startsWith(' ');
  const srcBgWord = !!srcRun?.bg && srcRun.text.trim().length > 0;

  if (srcBgWord && !srcStartsWithSpace) {
    for (let p = lo; p <= hi; p++) {
      if (p > prev && dst[p] !== ' ') return p;
    }
    let p = target;
    while (p < dst.length && dst[p] === ' ') p++;
    return Math.max(prev, p);
  }

  for (let p = lo; p <= hi; p++) {
    if (dst[p] === ' ') return Math.max(prev, p);
    if (p > prev && dst[p - 1] === ' ') return p;
  }
  return Math.max(prev, Math.min(dst.length, target));
}

function normalizeHighlightedRunEdges(runs: RunLike[], sourceRuns: RunLike[]): RunLike[] {
  const out = runs.map((r) => ({ ...r }));
  for (let i = 0; i < out.length; i++) {
    const src = sourceRuns[i];
    const run = out[i]!;
    if (!src?.bg || !src.text.trim()) continue;

    if (!src.text.startsWith(' ') && /^\s+/.test(run.text)) {
      const lead = run.text.match(/^\s+/)![0]!;
      run.text = run.text.slice(lead.length);
      if (i > 0) out[i - 1]!.text += lead;
    }
    if (!src.text.endsWith(' ') && /\s+$/.test(run.text)) {
      const trail = run.text.match(/\s+$/)![0]!;
      run.text = run.text.slice(0, run.text.length - trail.length);
      if (i + 1 < out.length) out[i + 1]!.text = trail + out[i + 1]!.text;
    }
  }
  return out;
}

/** Proportional fallback — same algorithm as @gsr/shared translate. */
function rebuildProportionalRuns(sourceRuns: RunLike[], translated: string): RunLike[] {
  if (!sourceRuns.length) return [];
  const dst = translated;
  if (!dst.length) return sourceRuns.map((r) => ({ ...r, text: '' }));

  const srcLens = sourceRuns.map((r) => r.text.length);
  const srcTotal = Math.max(
    1,
    srcLens.reduce((a, b) => a + b, 0),
  );
  const dstTotal = dst.length;

  const cuts: number[] = [0];
  let acc = 0;
  for (let i = 0; i < sourceRuns.length - 1; i++) {
    acc += srcLens[i]!;
    cuts.push(Math.round((acc / srcTotal) * dstTotal));
  }
  cuts.push(dstTotal);

  for (let i = 1; i < cuts.length - 1; i++) {
    cuts[i] = snapRunStartCut(dst, cuts[i - 1] ?? 0, cuts[i]!, sourceRuns[i]);
  }
  cuts[cuts.length - 1] = dstTotal;

  const runs = sourceRuns.map((run, i) => ({
    ...run,
    text: dst.slice(cuts[i]!, cuts[i + 1]!),
  }));
  return normalizeHighlightedRunEdges(runs, sourceRuns);
}

/**
 * Apply new copy while preserving template highlight styling (pill, italic accent, …).
 * Mirrors the translate pipeline's rebuildStyledRuns behaviour.
 */
export function applyTextPreservingStyle(
  sourceLayer: Pick<DesignLayer, 'text' | 'runs'>,
  newText: string,
  highlightPhrase?: string,
): { text: string; runs?: RunLike[] } {
  const sourceRuns = sourceLayer.runs;
  if (!sourceRuns?.length || !hasStyledRuns(sourceRuns)) {
    return { text: newText };
  }

  const hint = detectHighlightHint(sourceRuns);
  const usesRunsOnly = !sourceLayer.text;

  let runs: RunLike[];
  if (hint.style === 'pill') {
    runs = rebuildPillRuns(sourceRuns, newText, highlightPhrase);
  } else if (hint.style === 'accent' || hint.style === 'mixed') {
    runs = rebuildAccentRuns(sourceRuns, newText, highlightPhrase);
    if (hint.style === 'mixed') {
      const pill = sourceRuns.find((r) => r.bg && r.text.trim());
      const hash = newText.match(/#[\w-]+/)?.[0];
      if (pill && hash) {
        const pillRuns = rebuildPillRuns(sourceRuns, newText, hash);
        if (pillRuns.length > 1) runs = pillRuns;
      }
    }
  } else {
    runs = rebuildProportionalRuns(sourceRuns, newText);
  }

  return {
    text: usesRunsOnly ? '' : newText,
    runs,
  };
}

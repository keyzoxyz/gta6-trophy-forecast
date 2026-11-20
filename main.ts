// gta6-trophy-rarity-forecast-01 — model v2 (Node 22, standard library only).
//
// THE ONE IDEA
// Exophase's earn rate is 100 * earners / tracked. The page's `tracked` count only changes when
// Exophase refreshes the game (launch night: 638 -> 3,868 in one step; every printed rate fell to
// about 1/6 of itself while no player's trophy changed), while `earners` move smoothly with play.
// The house's own baseline forecasts the *rate* — so a refresh takes it outside its band on every
// trophy at once, which is exactly what the practice punishes (loss ~1.51, coverage 0).
//
// This entry forecasts in the *earners space* instead: it converts every read into the earners each
// read implies, models earners with a growth curve, forecasts the tracked count with the same
// machinery, and divides. A refresh then moves both numerator's history and the denominator's
// forecast together, so the refresh is not a surprise: it is arithmetic.
//
// SPREAD
// Three honest parts, added in quadrature on the logit scale:
//   - the growth curve's own residual (weighted, over the reads),
//   - a horizon random walk (sigma 0.5 logit / sqrt(day)),
//   - a refresh risk term: the larger of zero and a log-ratio between the largest and latest tracked
//     counts, capped. If the page has not refreshed yet in the case's history, the model believes a
//     refresh may land before the target and says so in its band. Where the history already holds a
//     refresh, the term shrinks, because the cohort is established.
//
// The 100%-trophy is held at 99.9 (it is earned by everyone; only rounding noise moves it). A trophy
// at 0.00% is held near the smallest positive rate the case shows — it cannot be extrapolated, only
// bounded — with a wide band.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6448536269514722, -0.6744897501960817, 0.0, 0.6744897501960817, 1.6448536269514722];
/** Random-walk spread, logit units per square-root day. */
const WALK = 0.25;
/**
 * The logit shift a first refresh costs a rate, measured from this competition's own documented
 * record: Exophase's launch-night refresh took the tracked count 638 -> 3,868 in one step while no
 * player's trophy changed, so every printed rate fell by ln(638/3868) = -1.80 logit units. A history
 * that has never seen its cohort change may see exactly that before the target, and the rules say so;
 * a history that already shows refreshes does not use this term at all, it extrapolates its own.
 */
const FIRST_REFRESH_LOGIT = -1.8;
/** The band half-width for an unrefreshed history's diluted median, in logit units. */
const FIRST_REFRESH_SPREAD = 0.4;
/** Refresh-risk weight on the earners-space band when the cohort has moved at least once. */
const REFRESH_RISK = 0.2;
/** Capped log-ratio that the refresh term may contribute. */
const REFRESH_CAP = 1.2;
/** Smallest band half-width (logit): the page prints two decimals; a point forecast is false precision. */
const MIN_SPREAD = 0.2;
/** Largest band half-width (logit). */
const MAX_SPREAD = 3.2;
/** The tracked-count forecast may exceed the last read by this multiple at most. */
const TRACKED_GROWTH_CAP = 14;

interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name?: string; platform?: string; release_date?: string };
  trophies: Array<{ id: number; name?: string; tier?: string; points?: number; secret?: boolean }>;
  history: Array<{
    slot: string;
    at: string;
    players_tracked: number;
    trophies_earned: number;
    rates: Array<number | null>;
  }>;
}

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clamp(pct) / (100 - clamp(pct)));
const expit = (x: number): number => 100 / (1 + Math.exp(-x));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const LOG1P_H = (h: number): number => Math.log1p(Math.max(0, h));

function hoursFrom(iso: string, releaseIso: string): number {
  const a = Date.parse(iso);
  const b = Date.parse(releaseIso);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, (a - b) / 3_600_000) : 0;
}

/** Weighted least squares of y on x; null when the design is degenerate. */
function wls(x: number[], y: number[], w: number[]): { b: number; a: number; resid: number } | null {
  const n = x.length;
  if (n < 2) return null;
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sw += w[i]!; sx += w[i]! * x[i]!; sy += w[i]! * y[i]!; }
  if (!(sw > 0)) return null;
  const mx = sx / sw, my = sy / sw;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    sxx += w[i]! * dx * dx;
    sxy += w[i]! * dx * (y[i]! - my);
  }
  if (!(sxx > 1e-9)) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let ssr = 0, sw2 = 0;
  for (let i = 0; i < n; i++) {
    const r = y[i]! - (a + b * x[i]!);
    ssr += w[i]! * r * r;
    sw2 += w[i]!;
  }
  const dof = Math.max(1, n - 2);
  return { b, a, resid: Math.sqrt(Math.max(0, ssr / dof)) };
}

/** Recency weights: later reads say more about where the page is now. */
function recency(n: number, i: number): number {
  return n <= 1 ? 1 : 0.45 + 0.55 * (i / (n - 1));
}

/** The five quantiles around a median, non-decreasing after rounding. */
function band(id: number, medianPct: number, spread: number): { id: number; q: number[] } {
  const l = logit(medianPct);
  const s = Math.max(MIN_SPREAD, Math.min(MAX_SPREAD, spread));
  const q = Z.map((z) => round4(clamp(expit(l + z * s))));
  for (let i = 1; i < q.length; i++) if (q[i]! < q[i - 1]!) q[i] = q[i - 1]!;
  return { id, q };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();

for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hist = c.history;
  if (hist.length === 0) throw new Error(`${file} has no history`);
  const last = hist[hist.length - 1]!;
  const releaseIso = `${c.game.release_date ?? '2026-11-19'}T00:00:00Z`;
  const targetH = hoursFrom(c.target, releaseIso);
  const horizonDays = c.horizon_minutes / 1440;

  // ── tracked: forecast the denominator, on the CURRENT cohort's own segment ─────────────────
  // The tracked count is a step function: Exophase replaces the cohort in one refresh, and between
  // refreshes it drifts slowly upward. A single line through the whole history therefore measures the
  // step, not the drift, and extrapolates the step — over-forecasting the denominator by multiples and
  // pushing every rate far too low. So the fit uses only the reads from the last refresh onward: the
  // segment that shares the cohort the target will be measured in.
  const xs = hist.map((h) => LOG1P_H(hoursFrom(h.at, releaseIso)));
  const segStart = lastCohortStart(hist);
  const segIdx: number[] = [];
  for (let k = segStart; k < hist.length; k++) segIdx.push(k);
  const trkSegX = segIdx.map((k) => xs[k]!);
  const trkSegY = segIdx.map((k) => Math.log(Math.max(1, hist[k]!.players_tracked)));
  const trkSegW = segIdx.map((_, j) => recency(segIdx.length, j));
  const trkFit = wls(trkSegX, trkSegY, trkSegW);
  let trackedTarget: number;
  let trackedUncert: number;
  if (trkFit !== null && segIdx.length >= 3) {
    const fitted = Math.exp(trkFit.a + trkFit.b * LOG1P_H(targetH));
    trackedTarget = Math.min(last.players_tracked * TRACKED_GROWTH_CAP,
      Math.max(last.players_tracked * 0.98, fitted));
    trackedUncert = trkFit.resid * 0.6;
  } else {
    trackedTarget = last.players_tracked;
    trackedUncert = 0;
  }

  // ── has this history ever seen the cohort change? ──────────────────────────────────────────
  // `tracked` only moves when Exophase refreshes the game, in one step, and the step is what
  // re-bases every printed rate at once. A history of one flat tracked count is therefore a history
  // that ends before its first refresh, and the target may well sit after it.
  const distinctTracked = new Set(hist.map((h) => h.players_tracked)).size;
  const cohortMoved = distinctTracked > 1;
  let maxTrk = last.players_tracked;
  for (const h of hist) if (h.players_tracked > maxTrk) maxTrk = h.players_tracked;
  const refreshTerm = cohortMoved
    ? Math.min(REFRESH_CAP, REFRESH_RISK * Math.sqrt(horizonDays))
    : FIRST_REFRESH_SPREAD;

  // ── per trophy ──────────────────────────────────────────────────────────────────────────────
  const trophies = c.trophies.map((t, i) => {
    // earners each read implies
    const obs: Array<{ x: number; y: number; w: number }> = [];
    let lastRate: number | null = null;
    for (let k = 0; k < hist.length; k++) {
      const h = hist[k]!;
      const r = h.rates[i];
      if (r === null || r === undefined || !Number.isFinite(r)) continue;
      lastRate = r;
      if (r <= 0.005 || r >= 99.995) continue;   // censored ends handled below
      const earners = (r / 100) * h.players_tracked;
      obs.push({ x: xs[k]!, y: Math.log(Math.max(earners, 0.5)), w: recency(hist.length, k) });
    }

    if (lastRate !== null && lastRate >= 99.995) return band(t.id, 99.9, Math.max(MIN_SPREAD, 0.16));
    if (lastRate === null) {
      const med = 0.03;
      return band(t.id, med, 1.2);
    }
    if (lastRate <= 0.005) {
      const floor = rarestPositive(hist, i);
      const med = Math.max(0.02, Math.min(0.4, floor * 0.45));
      return band(t.id, med, Math.max(0.8, 1.2));
    }

    // An unrefreshed history: the target may sit after a first refresh, which re-bases this rate by
    // the documented factor. Forecast the diluted rate, with the band the shift deserves.
    if (!cohortMoved) {
      const diluted = expit(logit(lastRate) + FIRST_REFRESH_LOGIT);
      return band(t.id, Math.max(0.01, diluted), FIRST_REFRESH_SPREAD);
    }

    // Fit earners; persistence floor keeps a flat history from inventing growth.
    const fit = wls(obs.map((o) => o.x), obs.map((o) => o.y), obs.map((o) => o.w));
    const lastEarners = (lastRate / 100) * last.players_tracked;
    let earnersTarget: number;
    let growthResid: number;
    if (fit !== null) {
      const fitted = Math.exp(fit.a + fit.b * LOG1P_H(Math.max(0, targetH)));
      earnersTarget = Math.min(lastEarners * 25, Math.max(lastEarners * 0.8, fitted));
      growthResid = fit.resid * 1.2;
    } else {
      earnersTarget = lastEarners;
      growthResid = 0;
    }

    let rateTarget = 100 * earnersTarget / Math.max(1, trackedTarget);
    rateTarget = Math.min(99.9, Math.max(0.01, rateTarget));

    // The band: growth residual, the walk, the refresh risk, and the tracked uncertainty, in quadrature.
    const walkTerm = WALK * Math.sqrt(horizonDays);
    const trackedTerm = trackedUncert;
    const spread = Math.sqrt(growthResid * growthResid + walkTerm * walkTerm + refreshTerm * refreshTerm + trackedTerm * trackedTerm);
    return band(t.id, rateTarget, spread);
  });

  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}

/**
 * The index where the history's current cohort begins: the read after the last refresh that moved the
 * tracked count by more than 10%. Reads before it were counted over a different population, and mixing
 * them into a growth fit measures the refresh instead of the drift.
 */
function lastCohortStart(hist: CaseFile['history']): number {
  let start = 0;
  for (let k = 1; k < hist.length; k++) {
    const prev = hist[k - 1]!.players_tracked;
    const cur = hist[k]!.players_tracked;
    if (prev > 0 && Math.abs(cur - prev) / prev > 0.1) start = k;
  }
  return start;
}

/** The smallest positive rate the history shows for trophy i. */
function rarestPositive(hist: CaseFile['history'], i: number): number {
  let best = Infinity;
  for (const h of hist) {
    const r = h.rates[i];
    if (r !== null && r !== undefined && r > 0.005 && r < best) best = r;
  }
  return Number.isFinite(best) ? best : 0.05;
}
// gta6-twitch-ccu-forecast-01: forecast GTA VI's launch-day Twitch viewers, hour by
// hour, from the first hour's print plus the past launch curves the case carries.
//
// Model. Every comparable launch contributes its release-day curve as log-ratios to
// its own hour-1 print: r_h = ln(viewers_h / viewers_1) for h = 2..24. The shape a
// launch follows depends mostly on how much of it had already materialised by hour 1
// (a rolling-midnight unlock has a big hour 1 and a modest rise; a launch whose global
// unlock lands later in the UTC day has a small hour 1 and a steep rise), so each
// comparable is weighted by a Gaussian kernel on the log distance between its hour-1
// print and this case's hour-1 print. Per hour, the forecast's centre is the weighted
// median log-ratio and its spread is the weighted interquartile range, smoothed across
// neighbouring hours. Early-access-contaminated launches are down-weighted (their
// release-day shape is flattened by players who started early); weak and
// target-history entries carry no launch curve and are skipped. When no comparable
// yields a usable curve, the forecast falls back to persistence (every hour at the
// hour-1 print, with the house baseline's widening spread).
//
// The program is a pure function of the case file: no randomness, no network, no
// clock reads, so two runs on the same input write the same bytes.
//
//   node main.ts            (reads /input, writes /output, as the grader runs it)
//   MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts   (local run)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

/** Quantile levels, in the order each forecast row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at LEVELS. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const HOUR_MS = 3_600_000;
/** Kernel bandwidth on log hour-1 prints (leave-one-out optimum is flat near 1). */
const KERNEL_BW = 1.0;
/** Weight of early-access-contaminated launches relative to clean comparables. */
const CONTAMINATED_WEIGHT = 0.75;
/** Smallest log-spread allowed for any hour, so near-identical neighbours still widen. */
const SIGMA_FLOOR = 0.22;
/** Spread of the persistence fallback, in log units per square-root hour. */
const FALLBACK_SIGMA = 0.15;
/** Output bounds: every quantile stays a finite number in (0, 1e9]. */
const Q_MIN = 0.01;
const Q_MAX = 1_000_000_000;

interface HourlyPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  day_start: string;
  unlock?: string;
  hourly: HourlyPoint[];
}

interface CaseFile {
  known?: Array<{ hour: number; viewers: number }>;
  comparables?: Comparable[];
}

/** The forecast always covers exactly hours 2..24, in order, as the spec requires. */
const HOURS = Array.from({ length: 23 }, (_, i) => i + 2);

/** Round to 2 decimals (half up), matching the baseline's output format. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** The tier recorded in a comparable's unlock note ("Tier: comparable." etc.). */
function tierOf(comp: Comparable): string {
  const note = comp.unlock ?? "";
  const marker = "Tier: ";
  const at = note.indexOf(marker);
  if (at < 0) return "comparable";
  const rest = note.slice(at + marker.length);
  const end = rest.indexOf(".");
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/**
 * A comparable's release-day hourly viewers, hours 1..24, or null when the curve is
 * incomplete or degenerate (a missing hour, or a non-positive count anywhere: log
 * ratios need strictly positive counts). Hours are aligned by timestamp against the
 * comparable's own day_start, so gaps or extra points elsewhere in its series do not
 * matter.
 */
function releaseDayCurve(comp: Comparable): number[] | null {
  const start = Date.parse(comp.day_start);
  if (!Number.isFinite(start) || !Array.isArray(comp.hourly)) return null;
  const byHour = new Map<number, number>();
  for (const point of comp.hourly) {
    const at = Date.parse(point.from);
    if (!Number.isFinite(at)) continue;
    const offset = Math.round((at - start) / HOUR_MS);
    if (offset < 0 || offset > 23 || byHour.has(offset)) continue;
    byHour.set(offset, point.viewers);
  }
  if (byHour.size < 24) return null;
  const day: number[] = [];
  for (let k = 0; k < 24; k++) {
    const v = byHour.get(k) as number;
    if (!(v > 0) || !Number.isFinite(v)) return null;
    day.push(v);
  }
  return day;
}

/** Weighted quantile with linear interpolation on cumulative weight. */
function weightedQuantile(pairs: Array<{ value: number; weight: number }>, q: number): number {
  const sorted = [...pairs].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, p) => sum + p.weight, 0);
  if (!(total > 0)) return sorted[Math.floor(sorted.length / 2)].value;
  const target = q * total;
  let acc = 0;
  let prevValue = sorted[0].value;
  let prevAcc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc >= target) {
      if (acc === prevAcc) return p.value;
      const frac = (target - prevAcc) / (acc - prevAcc);
      return prevValue + frac * (p.value - prevValue);
    }
    prevValue = p.value;
    prevAcc = acc;
  }
  return sorted[sorted.length - 1].value;
}

/** Three-point moving average; endpoints stay as they are. */
function smooth3(xs: number[]): number[] {
  if (xs.length < 3) return [...xs];
  const out = [xs[0]];
  for (let i = 1; i < xs.length - 1; i++) out.push((xs[i - 1] + xs[i] + xs[i + 1]) / 3);
  out.push(xs[xs.length - 1]);
  return out;
}

/** Clamp, enforce non-decreasing order, and round one row of quantiles. */
function finishRow(qs: number[]): number[] {
  const out = qs.map((q) => Math.min(Math.max(q, Q_MIN), Q_MAX));
  for (let k = 1; k < out.length; k++) out[k] = Math.max(out[k], out[k - 1]);
  const rounded = out.map(round2);
  for (let k = 1; k < rounded.length; k++) rounded[k] = Math.max(rounded[k], rounded[k - 1]);
  return rounded;
}

/** Persistence fallback: every hour at the hour-1 print, spread widening with time. */
function persistenceForecast(p1: number, hours: number[]): Array<{ hour: number; q: number[] }> {
  return hours.map((h) => ({
    hour: h,
    q: finishRow(Z.map((z) => p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(h - 1)))),
  }));
}

/**
 * The comparable-weighted forecast. Returns null when no comparable yields a usable
 * curve, so the caller can fall back to persistence.
 */
function modelForecast(
  p1: number,
  comps: Comparable[],
  hours: number[],
): Array<{ hour: number; q: number[] }> | null {
  const logP1 = Math.log(p1);
  const curves: Array<{ weight: number; ratios: number[] }> = [];
  for (const comp of comps) {
    const tier = tierOf(comp);
    if (tier === "target-history" || tier === "weak") continue;
    const tierWeight = tier === "early-access-contaminated" ? CONTAMINATED_WEIGHT : 1;
    const day = releaseDayCurve(comp);
    if (day === null) continue;
    const h1 = day[0];
    const distance = (Math.log(h1) - logP1) / KERNEL_BW;
    const weight = tierWeight * Math.exp(-0.5 * distance * distance);
    if (!(weight > 0) || !Number.isFinite(weight)) continue;
    curves.push({ weight, ratios: day.slice(1).map((v) => Math.log(v / h1)) });
  }
  if (curves.length === 0) return null;

  const medians: number[] = [];
  const sigmas: number[] = [];
  for (let j = 0; j < 23; j++) {
    const pairs = curves.map((c) => ({ value: c.ratios[j], weight: c.weight }));
    medians.push(weightedQuantile(pairs, 0.5));
    const q25 = weightedQuantile(pairs, 0.25);
    const q75 = weightedQuantile(pairs, 0.75);
    sigmas.push(Math.max(SIGMA_FLOOR, (q75 - q25) / 1.349));
  }
  const smoothMedians = smooth3(medians);
  const smoothSigmas = smooth3(sigmas);
  for (let j = 1; j < smoothSigmas.length; j++) {
    if (smoothSigmas[j] < smoothSigmas[j - 1]) smoothSigmas[j] = smoothSigmas[j - 1];
  }
  return hours.map((h) => {
    const j = h - 2;
    const median = smoothMedians[j] ?? 0;
    const sigma = smoothSigmas[j] ?? SIGMA_FLOOR;
    return { hour: h, q: finishRow(Z.map((z) => p1 * Math.exp(median + z * sigma))) };
  });
}

/** Forecast one case. Never throws: any failure degrades to the persistence shape. */
function forecastCase(c: CaseFile): Array<{ hour: number; q: number[] }> {
  const hours = HOURS;
  const known = Array.isArray(c.known) ? c.known : [];
  const first = known.find((row) => row.hour === 1) ?? known[0];
  const p1 = first !== undefined && Number.isFinite(first.viewers) ? Math.max(1, first.viewers) : 1;
  try {
    const modelled = Array.isArray(c.comparables) ? modelForecast(p1, c.comparables, hours) : null;
    if (modelled !== null) return modelled;
  } catch {
    // Fall through to persistence: a malformed comparable must not sink the case.
  }
  return persistenceForecast(p1, hours);
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith(".in"))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -".in".length);
  let hours: Array<{ hour: number; q: number[] }>;
  try {
    const parsed = JSON.parse(readFileSync(join(INPUT_DIR, file), "utf8")) as CaseFile;
    hours = forecastCase(parsed);
  } catch {
    // An unreadable case file still gets a well-formed (if useless) forecast.
    hours = Array.from({ length: 23 }, (_, i) => ({ hour: i + 2, q: [1, 1, 1, 1, 1] }));
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}

import Spline from "cubic-spline";

type TimeValue = { Time: number; Value: number };

const MakeSpline = (range: TimeValue[]) => {
  const xs = range.map((v) => v.Time);
  const ys = range.map((v) => v.Value);
  return new Spline(xs, ys);
};

// Syllable bounce targets (from spicy-card SyllableVocals.ts)
export const ScaleRange: TimeValue[] = [
  { Time: 0, Value: 0.95 },
  { Time: 0.7, Value: 1.025 },
  { Time: 1, Value: 1 },
];

export const YOffsetRange: TimeValue[] = [
  { Time: 0, Value: 1 / 100 },
  { Time: 0.9, Value: -(1 / 60) },
  { Time: 1, Value: 0 },
];

export const GlowRange: TimeValue[] = [
  { Time: 0, Value: 0 },
  { Time: 0.1, Value: 1 },
  { Time: 0.7, Value: 1 },
  { Time: 1, Value: 0 },
];

// Line glow targets (from spicy-card LineVocals.ts)
export const LineGlowRange: TimeValue[] = [
  { Time: 0, Value: 0 },
  { Time: 0.5, Value: 1 },
  { Time: 0.925, Value: 1 },
  { Time: 1, Value: 0 },
];

// Pre-built splines
export const ScaleSpline = MakeSpline(ScaleRange);
export const YOffsetSpline = MakeSpline(YOffsetRange);
export const GlowSpline = MakeSpline(GlowRange);
export const LineGlowSpline = MakeSpline(LineGlowRange);

// Spring damping/frequency configs
export const SyllableSpringConfig = {
  Scale: { dampingRatio: 0.6, frequency: 0.7 },
  YOffset: { dampingRatio: 0.4, frequency: 1.25 },
  Glow: { dampingRatio: 0.5, frequency: 1 },
} as const;

export const LineSpringConfig = {
  Glow: { dampingRatio: 0.5, frequency: 1 },
} as const;

export const InterludeSpringConfig = {
  Scale: { dampingRatio: 0.7, frequency: 5 },
  YOffset: { dampingRatio: 0.4, frequency: 1.25 },
  Glow: { dampingRatio: 0.5, frequency: 1 },
  Opacity: { dampingRatio: 0.5, frequency: 1 },
} as const;

// Emphasized syllable detection (from spicy-card)
const MinimumEmphasizedDuration = 1.2; // seconds
const MaximumEmphasizedCharacters = 12;

export const IsEmphasized = (durationMs: number, textLength: number): boolean =>
  durationMs / 1000 >= MinimumEmphasizedDuration && textLength <= MaximumEmphasizedCharacters;

// Clamp utility
export const Clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

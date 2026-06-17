import Spring from "./Spring";

export type SyllableSprings = {
  Scale: Spring;
  YOffset: Spring;
  Glow: Spring;
};

export type LineSprings = {
  Glow: Spring;
};

export type InterludeSprings = {
  Scale: Spring;
  YOffset: Spring;
  Glow: Spring;
  Opacity: Spring;
};

export type SpringSet = SyllableSprings | LineSprings | InterludeSprings;

type ApplyFn = (springs: SpringSet, deltaTime: number) => void;

type SpringEntry = {
  springs: SpringSet;
  apply: ApplyFn;
};

const registry = new WeakMap<Element, SpringEntry>();
const activeEntries = new Set<SpringEntry>();

let rafId = 0;
let lastTime = 0;
let running = false;

const prefersReducedMotion =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function tick(now: number) {
  if (!running) return;

  const deltaTime = lastTime === 0 ? 0 : Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  for (const entry of activeEntries) {
    const springs = entry.springs as Record<string, Spring>;
    for (const spring of Object.values(springs)) {
      spring.Update(deltaTime);
    }
    entry.apply(entry.springs, deltaTime);
  }

  rafId = requestAnimationFrame(tick);
}

export function registerSprings(
  el: Element,
  springs: SpringSet,
  apply: ApplyFn,
): void {
  const entry: SpringEntry = { springs, apply };
  registry.set(el, entry);
  activeEntries.add(entry);

  if (!running) startLoop();
}

export function unregisterSprings(el: Element): void {
  const entry = registry.get(el);
  if (entry) {
    activeEntries.delete(entry);
    registry.delete(el);
  }

  if (activeEntries.size === 0) stopLoop();
}

export function setTargets(
  el: Element,
  targets: Partial<Record<keyof SpringSet, number>>,
  force?: true,
): void {
  const entry = registry.get(el);
  if (!entry) return;

  const springs = entry.springs;
  for (const [key, value] of Object.entries(targets)) {
    const spring = (springs as Record<string, Spring>)[key];
    if (!spring) continue;
    if (force) spring.Set(value);
    else spring.Final = value;
  }
}

export function isSleeping(el: Element): boolean {
  const entry = registry.get(el);
  if (!entry) return true;

  const springs = entry.springs;
  for (const spring of Object.values(springs)) {
    if (!spring.IsSleeping()) return false;
  }
  return true;
}

export function startLoop(): void {
  if (running || prefersReducedMotion) return;
  running = true;
  lastTime = 0;
  rafId = requestAnimationFrame(tick);
}

export function stopLoop(): void {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

export function getReducedMotion(): boolean {
  return prefersReducedMotion;
}

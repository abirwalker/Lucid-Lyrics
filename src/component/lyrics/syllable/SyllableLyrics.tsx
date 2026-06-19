import type { Syllable, SyllableData, VocalPart } from "~/lib/api/types";
import { toast } from "~/lib/sonner";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { useLenis, useLenisContent } from "~/component/ui/Lenis";
import { useStore } from "@nanostores/solid";
import { $current_position, $romanize, $romanize_position, $track_colors, getBlurmap } from "~/stores";
import { getSyllableColor, setSyllableColor, clearSyllableColorMap, makeSyllableKey, seededRandom } from "~/lib/colorExtract";
import { useRenderer } from "~/context/LyricsRenderer";
import { SPACE_REGEX, splitGraphemes } from "~/lib/string";
import { seekTo } from "~/lib/spotify/player";
import { Interlude } from "~/component/lyrics/Interlude";
import Spring from "~/lib/Spring";
import {
  ScaleSpline,
  YOffsetSpline,
  GlowSpline,
  SyllableSpringConfig,
  IsEmphasized,
  Clamp,
} from "~/lib/SpringConfig";

// Match spicy-card's d3-ease sinOut for letter staggering
const easeSinOut = (t: number): number => 1 - Math.cos((t * Math.PI) / 2);

type LetterSpringData = {
  springs: { Scale: Spring; YOffset: Spring; Glow: Spring };
  el: HTMLSpanElement;
  start: number;
  duration: number;
  glowDuration: number;
};

type SyllableSpringData = {
  springs: { Scale: Spring; YOffset: Spring; Glow: Spring };
  el: HTMLSpanElement;
  syllable: Syllable;
  emphasized: boolean;
  surpriseBounce: boolean;
  surpriseColor: boolean; // 10% chance — adds album color tint
  _surpriseColor?: string;
  _wordEndTime?: number; // End time of the whole word (ms) — tint persists until this
  letters: LetterSpringData[];
  _state?: "active" | "past" | "upcoming";
};

export type SyllableLyricsProps = {
  lyrics: SyllableData;
  widgetHidden: boolean;
};

type LineEntry =
  | {
      type: "lyric";
      index: number;
      contentIndex: number;
      content: SyllableData["Content"][number];
    }
  | {
      type: "interlude";
      index: number;
      start: number;
      end: number;
      oppAligned: boolean;
      isIntro: boolean;
      isRTL?: boolean;
    };

type Word = { Syllables: Syllable[] };

function getVocalPartBounds(content: SyllableData["Content"][number]) {
  const lead = content.Lead.Syllables;
  let start = lead.length > 0 ? lead[0].StartTime * 1000 : Infinity;
  let end = lead.length > 0 ? lead[lead.length - 1].EndTime * 1000 : 0;

  content.Background?.forEach((bg) => {
    if (bg.Syllables.length > 0) {
      start = Math.min(start, bg.Syllables[0].StartTime * 1000);
      end = Math.max(end, bg.Syllables[bg.Syllables.length - 1].EndTime * 1000);
    }
  });

  return { end, start: start === Infinity ? 0 : start };
}

type LeadRendererProps = {
  vocalPart: VocalPart;
  background?: boolean;
  oppAligned?: boolean;
  hasBg?: boolean;
  romanize: boolean;
  romanize_position: "top" | "bottom" | "replace";
  getCurrentPos: () => number;
  lineStatus: () => "past" | "active" | "upcoming";
  isRTL?: boolean;
  hasOppAligned?: boolean;
};

function LeadRenderer(props: LeadRendererProps) {
  // Spring physics state - shared across all syllables in this line
  const allSyllableSprings: SyllableSpringData[] = [];
  let rafId = 0;
  let lastTime = 0;
  const trackColors = useStore($track_colors);

  // When palette updates (extraction finishes), re-assign colors to all surprise syllables
  // that were assigned stale default colors before extraction completed
  createEffect(on(trackColors, () => {
    clearSyllableColorMap();
    for (const data of allSyllableSprings) {
      if (data.surpriseColor) {
        data._surpriseColor = undefined;
      }
    }
  }));

  // Simple weighted random from palette
  // Deterministic random from palette — same syllable always gets same color
  const randomTrackColor = (seed: string) => {
    const c = trackColors();
    const colors = [c.LIGHT_VIBRANT, c.VIBRANT_NON_ALARMING, c.DESATURATED];
    const r = seededRandom(seed);
    const idx = r < 0.50 ? 0 : r < 0.80 ? 1 : 2;
    return colors[idx].replace(/^rgb\(/, "").replace(/\)$/, "");
  };

  // Match spicy-card: update targets only on state change
  const updateLiveTextState = (data: SyllableSpringData, timeScale: number, forceTo?: true) => {
    const { springs: s } = data;
    const useEmphasized = data.emphasized || data.surpriseBounce;
    const scale = ScaleSpline.at(timeScale);
    const yOffset = YOffsetSpline.at(timeScale);
    const glowAlpha = GlowSpline.at(timeScale);
    if (forceTo) {
      s.Scale.Set(scale);
      s.YOffset.Set(useEmphasized ? yOffset * 1.5 : yOffset);
      s.Glow.Set(glowAlpha);
    } else {
      s.Scale.Final = scale;
      s.YOffset.Final = useEmphasized ? yOffset * 1.5 : yOffset;
      s.Glow.Final = glowAlpha;
    }
  };

  // Match spicy-card: apply spring values to DOM
  const updateLiveTextVisuals = (
    data: SyllableSpringData,
    _timeScale: number,
    deltaTime: number,
  ): boolean => {
    const { el, springs: s } = data;
    if (!el) return true;
    const scale = s.Scale.Update(deltaTime);
    const yOffset = s.YOffset.Update(deltaTime);
    const glowAlpha = s.Glow.Update(deltaTime);
    const isSurprise = data.surpriseBounce || data.surpriseColor;
    const intensity = data.emphasized ? 2 : isSurprise ? 2.5 : 1;
    el.style.transform = `translateY(calc(var(--lyrics-size, 1em) * ${yOffset * intensity}))`;
    el.style.scale = scale.toString();

    // Tint + bloom persists for the entire word duration, plus a fade-out after
    const pos = props.getCurrentPos();
    const wordEnd = data._wordEndTime;
    const tintFading = data.surpriseColor && wordEnd !== undefined && pos > wordEnd && pos <= wordEnd + 300;
    const tintActive = data.surpriseColor && wordEnd !== undefined && pos >= data.syllable.StartTime * 1000 && pos <= wordEnd;

    // Reduce tint bloom for long-duration short words (played >1s, <15 chars)
    const syllableDuration = (data.syllable.EndTime - data.syllable.StartTime);
    const isLongShort = tintActive && syllableDuration > 1 && data.syllable.Text.length < 15;
    const tintBlur = isLongShort ? 14 : 28;
    const tintOpacity = isLongShort ? 0.5 : 0.8;

    const blur = tintActive ? tintBlur : tintFading ? tintBlur : isSurprise ? 18 : 4 + 8 * glowAlpha * intensity;
    const opacity = tintActive ? tintOpacity : tintFading ? tintOpacity * (1 - (pos - wordEnd!) / 300) : glowAlpha * (data.emphasized ? 1.2 : isSurprise ? 0.7 : 0.7);
    el.style.setProperty("--text-shadow-blur-radius", `${blur}px`);
    el.style.setProperty("--text-shadow-opacity", `${opacity}`);

    if (data.surpriseColor && !data._surpriseColor) {
      // Use shared map so main view and NPV show the same color
      const key = makeSyllableKey(data.syllable.Text, data.syllable.StartTime);
      const existing = getSyllableColor(key);
      if (existing) {
        data._surpriseColor = existing;
      } else {
        const color = randomTrackColor(key + "_colorpick");
        setSyllableColor(key, color);
        data._surpriseColor = color;
      }
    }
    const color = data._surpriseColor || "255 255 255";
    const showTint = tintActive || tintFading;

    // Subtle tint: blend first palette color with white for non-surprise active glow
    let glowColor = "255 255 255";
    if (!showTint) {
      const c = trackColors();
      const accent = c.LIGHT_VIBRANT || c.VIBRANT_NON_ALARMING;
      if (accent) {
        const [r, g, b] = accent.split(",").map(Number);
        const mix = 0.20;
        glowColor = `${Math.round(r * mix + 255 * (1 - mix))} ${Math.round(g * mix + 255 * (1 - mix))} ${Math.round(b * mix + 255 * (1 - mix))}`;
      }
    }

    el.style.setProperty("--glow-color", showTint ? color : glowColor);
    el.style.setProperty("--glow-intensity", showTint ? "2.5" : "1.5");
    el.style.setProperty("--tint-color", showTint ? color : "");
    if (showTint && data._surpriseColor) {
      const [r, g, b] = data._surpriseColor.split(" ").map(Number);
      const mix = 0.32;
      el.style.setProperty("--lyrics-text-color", `${Math.round(r * mix + 255 * (1 - mix))} ${Math.round(g * mix + 255 * (1 - mix))} ${Math.round(b * mix + 255 * (1 - mix))}`);
    }
    el.classList.toggle("surprise-tint", showTint);
    return s.Scale.IsSleeping() && s.YOffset.IsSleeping() && s.Glow.IsSleeping();
  };

  const tick = (now: number) => {
    const dt = lastTime === 0 ? 0 : Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    const pos = props.getCurrentPos();
    for (const data of allSyllableSprings) {
      const { syllable: syn } = data;
      const start = syn.StartTime * 1000;
      const end = syn.EndTime * 1000;
      const duration = end - start;
      if (duration <= 0) continue;

      const timeScale = Clamp((pos - start) / duration, 0, 1);
      const isActive = pos >= start && pos <= end;
      const isPast = pos > end;

      // Detect state transitions
      const prevState = data._state ?? "upcoming";
      const newState = isActive ? "active" : isPast ? "past" : "upcoming";
      const stateChanged = newState !== prevState;
      data._state = newState;

      if (stateChanged && newState === "active") {
        // Force springs to starting position on activation
        data.springs.Scale.Set(0.95);
        data.springs.YOffset.Set(1 / 100);
        data.springs.Glow.Set(0);

        // Surprise bounce for short non-emphasized syllables (20% chance)
        if (data.surpriseBounce && !data.emphasized) {
          data.springs.Scale.Set(0.97);
          data.springs.YOffset.Set(0.5 / 100);
          data.springs.Glow.Set(0.8); // Start glow immediately
          toast(`🎯 Surprise bounce: "${data.syllable.Text}"`, {
            duration: 1500,
            style: { "font-size": "12px", opacity: 0.8 },
          });
        }

        // Surprise color (10% chance)
        if (data.surpriseColor) {
          data.springs.Glow.Set(0.8);
          toast(`🎨 Color: "${data.syllable.Text}"`, {
            duration: 1500,
            style: { "font-size": "12px", opacity: 0.8 },
          });
        }

        for (const letter of data.letters) {
          letter.springs.Scale.Set(0.95);
          letter.springs.YOffset.Set(1 / 100);
          letter.springs.Glow.Set(0);
        }
      }

      // Per-letter animation for emphasized syllables
      if (data.emphasized && data.letters.length > 0) {
        const timeAlpha = easeSinOut(timeScale);
        for (const letter of data.letters) {
          const letterTime = timeAlpha - letter.start;
          const letterTimeScale = Clamp(letterTime / letter.duration, 0, 1);
          const glowTimeScale = Clamp(letterTime / letter.glowDuration, 0, 1);
          if (isActive) {
            letter.springs.Scale.Final = ScaleSpline.at(letterTimeScale);
            letter.springs.YOffset.Final = YOffsetSpline.at(letterTimeScale);
            letter.springs.Glow.Final = GlowSpline.at(glowTimeScale);
          } else if (isPast) {
            // Let springs settle naturally to rest
            letter.springs.Scale.Final = 1;
            letter.springs.YOffset.Final = 0;
            letter.springs.Glow.Final = 0;
          }
          const ls = letter.springs;
          const scale = ls.Scale.Update(dt);
          const yOff = ls.YOffset.Update(dt);
          const glowAlpha = ls.Glow.Update(dt);
          letter.el.style.transform = `translateY(calc(var(--lyrics-size, 1em) * ${yOff * 2}))`;
          letter.el.style.scale = scale.toString();
          letter.el.style.setProperty("--text-shadow-blur-radius", `${4 + 3 * glowAlpha * 2}px`);
          letter.el.style.setProperty("--text-shadow-opacity", `${glowAlpha * 0.8}`);
        }
      }

      // Update syllable-level targets
      if (isActive) {
        updateLiveTextState(data, timeScale);
      } else if (isPast) {
        // Let springs settle naturally
        data.springs.Scale.Final = 1;
        data.springs.YOffset.Final = 0;
        data.springs.Glow.Final = 0;
      }

      // Update spring physics and apply visuals (always — lets springs settle)
      updateLiveTextVisuals(data, timeScale, dt);
    }

    rafId = requestAnimationFrame(tick);
  };

  onMount(() => {
    if (allSyllableSprings.length > 0) {
      rafId = requestAnimationFrame(tick);
    }
  });

  onCleanup(() => {
    if (rafId) cancelAnimationFrame(rafId);
  });

  const words = createMemo(() => {
    const syllables = props.vocalPart.Syllables;
    const result: Word[] = [];
    let currentWord: Word | null = null;

    for (let i = 0; i < syllables.length; i++) {
      const syllable = syllables[i];
      const isFirstInWord = i === 0 || !syllables[i - 1].IsPartOfWord;

      if (isFirstInWord) {
        currentWord = { Syllables: [syllable] };
        result.push(currentWord);
      } else if (currentWord) {
        currentWord.Syllables.push(syllable);
      }
    }
    return result;
  });

  // Word-level bounce: words under 12 chars with duration > 1s
  const wordBounceMap = createMemo(() => {
    const map = new Set<Syllable>();
    for (const word of words()) {
      const text = word.Syllables.map((s) => s.Text).join("");
      if (text.length > 12) continue;
      const start = word.Syllables[0].StartTime * 1000;
      const end = word.Syllables[word.Syllables.length - 1].EndTime * 1000;
      if (end - start <= 1000) continue;
      const wordSeed = makeSyllableKey(text, word.Syllables[0].StartTime);
      if (seededRandom(wordSeed + "_wbounce") >= 0.20) continue;
      for (const s of word.Syllables) map.add(s);
    }
    return map;
  });

  // Map each syllable to its word's end time (ms) — tint persists until word ends
  const syllableWordEndMap = createMemo(() => {
    const map = new Map<Syllable, number>();
    for (const word of words()) {
      const wordEnd = word.Syllables[word.Syllables.length - 1].EndTime * 1000;
      for (const s of word.Syllables) map.set(s, wordEnd);
    }
    return map;
  });

  const handleClick = () => seekTo(props.vocalPart.StartTime * 1000);

  const showTop = () => props.romanize && props.romanize_position === "top";
  const showBottom = () => props.romanize && props.romanize_position === "bottom";
  const useReplace = () => props.romanize && props.romanize_position === "replace";

  const paddingInline = () => {
    if (!props.hasOppAligned) return "0";

    return props.oppAligned
      ? "var(--lyrics-line-default-padding) 0"
      : "0 var(--lyrics-line-default-padding)";
  };

  return (
    <span
      class="syllable-line"
      classList={{
        "background-line": props.background,
        "has-bg-line": props.hasBg,
        "opp-aligned": props.oppAligned,
      }}
      style={{
        "padding-inline": paddingInline(),
        "text-align": props.oppAligned ? "end" : "start", // for some reason scss makes end => right and start => left
      }}
      onClick={handleClick}
      role="button"
      tabIndex={0}
    >
      <For each={words()}>
        {(word, wordIdx) => {
          const wordSyllables = word.Syllables;
          const isTrailing =
            !wordSyllables[wordSyllables.length - 1].IsPartOfWord &&
            wordIdx() !== words().length - 1;

          const hasRomanizedInWord = createMemo(() =>
            wordSyllables.some((s) => !!s.RomanizedText && props.romanize && !useReplace()),
          );

          return (
            <span
              class="word"
              classList={{
                "has-romanized-bottom": showBottom() && hasRomanizedInWord(),
                "has-romanized-top": showTop() && hasRomanizedInWord(),
                "trailing-whitespace": isTrailing,
              }}
            >
              <For each={wordSyllables}>
                {(syllable) => {
                  const displayText = createMemo(() =>
                    useReplace() ? (syllable.RomanizedText ?? syllable.Text) : syllable.Text,
                  );
                  const splitText = createMemo(() => splitGraphemes(displayText()));
                  const hasRomanizedForSyllable = createMemo(
                    () => !!syllable.RomanizedText && props.romanize && !useReplace(),
                  );
                  const romanizedSplit = createMemo(() =>
                    hasRomanizedForSyllable() ? splitGraphemes(syllable.RomanizedText || "") : [],
                  );

                  type RomanizedProps = { position: "bottom" | "top" };
                  const RomanizedLyrics = (rProps: RomanizedProps) => (
                    <Show when={hasRomanizedForSyllable()}>
                      <span class={`romanized-text at-${rProps.position}`}>
                        <For each={romanizedSplit()}>
                          {(char, charIdx) => {
                            const charDuration =
                              (syllable.EndTime * 1000 - syllable.StartTime * 1000) /
                              romanizedSplit().length;
                            const charStart = syllable.StartTime * 1000 + charIdx() * charDuration;
                            const charEnd = charStart + charDuration;

                            const progress = createMemo(() => {
                              const status = props.lineStatus();
                              if (status === "past") return 100;
                              if (status === "upcoming") return 0;

                              const pos = props.getCurrentPos();
                              if (pos < charStart) return 0;
                              if (pos >= charEnd) return 100;
                              return ((pos - charStart) / charDuration) * 100;
                            });

                            return (
                              <span
                                class="char romanized"
                                style={{
                                  "--char-progress": `${progress()}%`,
                                  "--char-progress-2": `${progress() > 0 ? progress() + 20 : 0}%`,
                                  "-webkit-text-fill-color": "transparent",
                                  "background-clip": "text",
                                  "background-image": `linear-gradient(90deg, rgba(255, 255, 255, 0.7) var(--char-progress), rgba(255, 255, 255, 0.3) var(--char-progress-2))`,
                                  display: "inline-block",
                                }}
                              >
                                {char}
                              </span>
                            );
                          }}
                        </For>
                      </span>
                    </Show>
                  );

                  // Track syllable activation for bounce effect
                  const isSyllableActive = createMemo(() => {
                    const status = props.lineStatus();
                    if (status === "past") return false;
                    if (status === "upcoming") return false;

                    const start = syllable.StartTime * 1000;
                    const end = syllable.EndTime * 1000;
                    const pos = props.getCurrentPos();
                    return pos >= start && pos < end;
                  });

                  // Calculate syllable duration
                  const syllableDuration = createMemo(() => {
                    const start = syllable.StartTime * 1000;
                    const end = syllable.EndTime * 1000;
                    return end - start;
                  });

                  // Spring physics for bounce, Y-offset, glow
                  const emphasized = IsEmphasized(syllableDuration(), displayText().length);
                  const syllableSprings = {
                    Scale: new Spring(
                      0,
                      SyllableSpringConfig.Scale.dampingRatio,
                      SyllableSpringConfig.Scale.frequency,
                    ),
                    YOffset: new Spring(
                      0,
                      SyllableSpringConfig.YOffset.dampingRatio,
                      SyllableSpringConfig.YOffset.frequency,
                    ),
                    Glow: new Spring(
                      0,
                      SyllableSpringConfig.Glow.dampingRatio,
                      SyllableSpringConfig.Glow.frequency,
                    ),
                  };
                  let springRegistered = false;
                  const bounceRand = Math.random();
                  const colorRand = Math.random();

                  const syllableSpringData: SyllableSpringData = {
                    el: undefined as any,
                    emphasized,
                    surpriseBounce: !emphasized && (bounceRand < 0.20 || wordBounceMap().has(syllable)),
                    surpriseColor: !emphasized && colorRand < 0.15,
                    _wordEndTime: syllableWordEndMap().get(syllable),
                    letters: [],
                    syllable,
                    springs: syllableSprings,
                  };

                  return (
                    <span
                      class="syllable"
                      classList={{
                        "has-romanized-bottom": showBottom() && hasRomanizedForSyllable(),
                        "has-romanized-top": showTop() && hasRomanizedForSyllable(),
                        active: isSyllableActive(),
                      }}
                      ref={(el) => {
                        if (!el) return;
                        syllableSpringData.el = el;
                        if (!springRegistered) {
                          allSyllableSprings.push(syllableSpringData);
                          // Initialize springs at starting position
                          syllableSprings.Scale.Set(0.95);
                          syllableSprings.YOffset.Set(1 / 100);
                          syllableSprings.Glow.Set(0);
                          updateLiveTextVisuals(syllableSpringData, 0, 0);
                          springRegistered = true;
                        }
                      }}
                    >
                      <Show when={showTop()}>
                        <RomanizedLyrics position="top" />
                      </Show>
                      <span class="syllable-wrapper">
                        <span>
                          {emphasized ? (
                            // Emphasized: per-letter spans with individual springs
                            <For each={splitText()}>
                              {(char, charIdx) => {
                                const letterCount = splitText().length;
                                const relativeTimestep = 1 / letterCount;
                                const letterStart = charIdx() * relativeTimestep;

                                // Gradient progress for emphasized letters
                                const charProgress = createMemo(() => {
                                  const status = props.lineStatus();
                                  if (status === "past") return 100;
                                  if (status === "upcoming") return 0;

                                  const pos = props.getCurrentPos();
                                  const start = syllable.StartTime * 1000;
                                  const end = syllable.EndTime * 1000;

                                  if (pos >= end) return 100;
                                  if (pos < start) return 0;

                                  const charDuration = (end - start) / letterCount;
                                  const charStart = start + charIdx() * charDuration;
                                  const charEnd = charStart + charDuration;

                                  if (pos < charStart) return 0;
                                  if (pos >= charEnd) return 100;

                                  return ((pos - charStart) / charDuration) * 100;
                                });

                                return (
                                  <span
                                    class="char"
                                    style={{
                                      "--char-progress": `${charProgress()}%`,
                                      "--char-progress-2": `${charProgress() > 0 ? charProgress() + 20 : 0}%`,
                                      "background-image": `linear-gradient(${props.isRTL ? 270 : 90}deg, rgba(255, 255, 255, 0.85) var(--char-progress), rgba(255, 255, 255, 0.4) var(--char-progress-2))`,
                                    }}
                                    ref={(el) => {
                                      if (!el || syllableSpringData.letters[charIdx()]) return;
                                      const letterSprings = {
                                        Scale: new Spring(
                                          0,
                                          SyllableSpringConfig.Scale.dampingRatio,
                                          SyllableSpringConfig.Scale.frequency,
                                        ),
                                        YOffset: new Spring(
                                          0,
                                          SyllableSpringConfig.YOffset.dampingRatio,
                                          SyllableSpringConfig.YOffset.frequency,
                                        ),
                                        Glow: new Spring(
                                          0,
                                          SyllableSpringConfig.Glow.dampingRatio,
                                          SyllableSpringConfig.Glow.frequency,
                                        ),
                                      };
                                      letterSprings.Scale.Set(0.95);
                                      letterSprings.YOffset.Set(1 / 100);
                                      letterSprings.Glow.Set(0);
                                      syllableSpringData.letters[charIdx()] = {
                                        duration: relativeTimestep,
                                        el,
                                        glowDuration: 1 - letterStart,
                                        springs: letterSprings,
                                        start: letterStart,
                                      };
                                    }}
                                  >
                                    {char}
                                  </span>
                                );
                              }}
                            </For>
                          ) : (
                            // Normal: character gradient progress
                            <For each={splitText()}>
                              {(char, charIdx) => {
                                if (SPACE_REGEX.test(char)) return " ";

                                const charProgress = createMemo(() => {
                                  const status = props.lineStatus();
                                  if (status === "past") return 100;
                                  if (status === "upcoming") return 0;

                                  // Line is active — check syllable-level progress
                                  const pos = props.getCurrentPos();
                                  const start = syllable.StartTime * 1000;
                                  const end = syllable.EndTime * 1000;

                                  // Position past this syllable's end but line still active
                                  if (pos >= end) return 100;
                                  if (pos < start) return 0;

                                  const charDuration = (end - start) / splitText().length;
                                  const charStart = start + charIdx() * charDuration;
                                  const charEnd = charStart + charDuration;

                                  if (pos < charStart) return 0;
                                  if (pos >= charEnd) return 100;

                                  return ((pos - charStart) / charDuration) * 100;
                                });

                                // Glow intensity peaks near the playhead, fades outward
                                const charGlowIntensity = createMemo(() => {
                                  const status = props.lineStatus();
                                  if (status === "past") return 0.15;
                                  if (status === "upcoming") return 0;

                                  const pos = props.getCurrentPos();
                                  const start = syllable.StartTime * 1000;
                                  const end = syllable.EndTime * 1000;
                                  if (pos < start || pos >= end) return 0;

                                  const totalChars = splitText().length;
                                  const charCenter = (charIdx() + 0.5) / totalChars;
                                  const syllableProgress = (pos - start) / (end - start);
                                  const distance = Math.abs(syllableProgress - charCenter);
                                  return Math.max(0.15, 1 - distance * 3.5);
                                });

                                return (
                                  <span
                                    class="char"
                                    style={{
                                      "--char-progress": `${charProgress()}%`,
                                      "--char-progress-2": `${charProgress() > 0 ? charProgress() + 20 : 0}%`,
                                      "--char-glow-intensity": charGlowIntensity(),
                                      "--shadow-alpha": (charProgress() / 200) * 0.85,
                                      "--shadow-blur": `${charProgress() * 0.06}px`,
                                      "background-image": `linear-gradient(${props.isRTL ? 270 : 90}deg, rgba(255, 255, 255, 0.85) var(--char-progress), rgba(255, 255, 255, 0.4) var(--char-progress-2))`,
                                    }}
                                  >
                                    {char}
                                  </span>
                                );
                              }}
                            </For>
                          )}
                        </span>
                      </span>

                      <Show when={showBottom()}>
                        <RomanizedLyrics position="bottom" />
                      </Show>
                    </span>
                  );
                }}
              </For>
            </span>
          );
        }}
      </For>
    </span>
  );
}

function SyllableLyrics(props: SyllableLyricsProps) {
  // eslint-disable-next-line oxc/no-unassigned-vars
  let containerRef!: HTMLDivElement;
  const itemRefs = new Map<number, HTMLDivElement>();
  const elementToIndex = new WeakMap<Element, number>();

  let highestActiveIndex = 0;
  let lastSeenPos = 0;

  const [isUserScroll, setIsUserScroll] = createSignal(false);
  const [isInteracting, setIsInteracting] = createSignal(false);
  const [visibleElements, setVisibleElements] = createSignal<Set<number>>(new Set());

  const [isMobile, setIsMobile] = createSignal(false);
  const [isNPV, setIsNPV] = createSignal(false);

  const currentPos = useStore($current_position);
  const romanize = useStore($romanize);
  const romanize_position = useStore($romanize_position);
  const { setIsActiveVisible, setJumpToActive } = useRenderer();
  const getLenis = useLenis();
  const getContentRef = useLenisContent();

  const updateLayoutVars = () => {
    if (!containerRef) return;
    const style = getComputedStyle(containerRef);
    setIsMobile(style.getPropertyValue("--is-mobile") === "1");
    setIsNPV(style.getPropertyValue("--is-npv") === "1");
  };

  const lineEntries = createMemo((): LineEntry[] => {
    const content = props.lyrics.Content || [];
    const entries: LineEntry[] = [];
    let lineIdx = 0;

    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      const { start, end } = getVocalPartBounds(c);

      if (i === 0 && start > 2000) {
        entries.push({
          end: start,
          index: lineIdx++,
          isIntro: true,
          isRTL: c.IsRTL,
          oppAligned: c.OppositeAligned,
          start: 0,
          type: "interlude",
        });
      }

      entries.push({
        content: c,
        contentIndex: i,
        index: lineIdx++,
        type: "lyric",
      });

      if (i < content.length - 1) {
        const nextLine = content[i + 1];
        const nextBounds = getVocalPartBounds(nextLine);
        const gap = nextBounds.start - end;

        if (gap > 2000) {
          entries.push({
            end: Math.max(0, nextBounds.start - 100),
            index: lineIdx++,
            isIntro: false,
            isRTL: nextLine.IsRTL,
            oppAligned: nextLine.OppositeAligned,
            start: Math.max(0, end - 100),
            type: "interlude",
          });
        }
      }
    }

    return entries;
  });
  const allBounds = createMemo(() => {
    return lineEntries().map((entry) => {
      if (entry.type === "interlude") {
        return { end: entry.end, start: entry.start };
      }
      return getVocalPartBounds(entry.content);
    });
  });

  const activeIndices = createMemo(
    () => {
      const pos = currentPos();
      const bounds = allBounds();
      if (bounds.length === 0) return [0];

      const indices: number[] = [];
      for (let i = 0; i < bounds.length; i++) {
        if (pos >= bounds[i].start && pos <= bounds[i].end) {
          indices.push(i);
        }
      }

      if (indices.length === 0 && pos > 0) {
        const nextIdx = bounds.findIndex((b) => b.start > pos);
        return [nextIdx === -1 ? bounds.length - 1 : Math.max(0, nextIdx - 1)];
      }

      return indices.length > 0 ? indices : [0];
    },
    [],
    {
      equals: (a, b) => a.length === b.length && a.every((val, i) => val === b[i]),
    },
  );

  const scrollToIndex = createMemo((prevIdx: number) => {
    const pos = currentPos();
    const isSeek = Math.abs(pos - lastSeenPos) > 1200;
    lastSeenPos = pos;

    const indices = activeIndices();
    if (indices.length === 0) return prevIdx || 0;

    let targetIdx = indices[0] ?? 0;

    if (indices.length > 1) {
      const entries = lineEntries();
      const currentEntry = entries[indices[indices.length - 1]];
      const isRTL =
        currentEntry?.type === "lyric"
          ? romanize() && romanize_position() === "replace"
            ? false
            : currentEntry.content.IsRTL
          : currentEntry?.type === "interlude"
            ? !(romanize() && romanize_position() === "replace") && currentEntry.isRTL
            : false;

      targetIdx = isRTL ? indices[0] : indices[indices.length - 1];
    }

    if (isSeek || pos === 0) {
      highestActiveIndex = targetIdx;
      return targetIdx;
    }

    if (targetIdx > highestActiveIndex) {
      highestActiveIndex = targetIdx;
    }

    return Math.max(targetIdx, highestActiveIndex);
  }, 0);

  const [scrollOffset, setScrollOffset] = createSignal(0);

  function updateOffset(isWidgetHidden = props.widgetHidden ?? false) {
    const lenis = getLenis();
    if (!lenis) return;

    const rootEl = lenis.rootElement as HTMLElement;
    const height =
      rootEl === document.documentElement || rootEl === document.body
        ? window.innerHeight
        : rootEl?.clientHeight || window.innerHeight;

    let baseOffset = height / 2.7;

    if (isNPV()) {
      baseOffset = height / 2.7;
    } else if (isMobile() && !isWidgetHidden) {
      baseOffset = 48;
    } else if (romanize() && romanize_position() !== "replace") {
      if (romanize_position() === "top") {
        baseOffset = height / 2.4;
      } else if (romanize_position() === "bottom") {
        baseOffset = height / 3.2;
      }
    }

    const activeCount = activeIndices().length;
    const lineOffset = activeCount > 1 ? (activeCount - 1) * 24 : 0;

    setScrollOffset(-(baseOffset + lineOffset));
  }

  const performScroll = (immediate: boolean, forceScroll = false) => {
    const lenis = getLenis();
    const idx = scrollToIndex();
    const targetRef = itemRefs.get(idx);

    if (!lenis || !targetRef || !targetRef.isConnected) return;
    if (!forceScroll && isUserScroll()) return;

    const wrapper = lenis.rootElement;
    if (!wrapper) return;

    const targetRect = targetRef.getBoundingClientRect();
    let targetY: number;

    const anchorOffset = isMobile() ? 0 : targetRect.height / 3;

    if (wrapper === document.documentElement || wrapper === document.body) {
      targetY = targetRect.top + anchorOffset + window.scrollY + scrollOffset();
    } else {
      const wrapperRect = wrapper.getBoundingClientRect();
      targetY = targetRect.top + anchorOffset - wrapperRect.top + lenis.scroll + scrollOffset();
    }

    lenis.scrollTo(targetY, {
      immediate,
      lock: false,
    });
  };

  createEffect(
    on(
      () => props.widgetHidden,
      (widgetHidden) => {
        requestAnimationFrame(() => {
          updateOffset(widgetHidden);
          performScroll(true, true);
        });
      },
    ),
  );

  createEffect(() => {
    const idx = scrollToIndex();

    if (!isUserScroll() && idx !== -1 && itemRefs.has(idx)) {
      requestAnimationFrame(() => {
        performScroll(false);
      });
    }
  });

  createEffect(
    on(
      [romanize, romanize_position],
      () => {
        const handleRomanize = () => {
          const lenis = getLenis();
          if (lenis) {
            lenis.resize();
            updateOffset();
            performScroll(true, true);
          }
        };
        requestAnimationFrame(handleRomanize);
        setTimeout(handleRomanize, 50);
      },
      { defer: true },
    ),
  );

  let scrollTimeout: ReturnType<typeof setTimeout>;

  const handleUserInteraction = () => {
    setIsInteracting(true);
    setIsUserScroll(true);
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => setIsInteracting(false), 5000);
  };

  createEffect(() => {
    const activeVisible = visibleElements().has(scrollToIndex());
    setIsActiveVisible(activeVisible);

    if (!isInteracting() && isUserScroll()) {
      if (activeVisible) {
        setIsUserScroll(false);
        performScroll(false);
      }
    }
  });

  createEffect((prevPos: number) => {
    const pos = currentPos();
    if (prevPos !== undefined && Math.abs(pos - prevPos) > 1200) {
      performScroll(true, true);
    }
    return pos;
  }, currentPos());

  let observer: IntersectionObserver | undefined;

  createEffect(() => {
    lineEntries();

    if (!observer) {
      observer = new IntersectionObserver(
        (entries) => {
          setVisibleElements((prev) => {
            const nextSet = new Set(prev);
            let hasChanges = false;

            for (const entry of entries) {
              const idx = elementToIndex.get(entry.target);
              if (idx === undefined) continue;

              if (entry.isIntersecting) {
                if (!nextSet.has(idx)) {
                  nextSet.add(idx);
                  hasChanges = true;
                }
              } else {
                if (nextSet.has(idx)) {
                  nextSet.delete(idx);
                  hasChanges = true;
                }
              }
            }

            return hasChanges ? nextSet : prev;
          });
        },
        { threshold: 0.01 },
      );
    }

    observer.disconnect();

    queueMicrotask(() => {
      itemRefs.forEach((el) => observer!.observe(el));
    });

    onCleanup(() => observer?.disconnect());
  });

  onMount(() => {
    setJumpToActive(() => () => {
      getLenis()?.resize();
      performScroll(false, true);
    });

    const contentRef = getContentRef();
    const lenis = getLenis();

    const onResize = () => {
      requestAnimationFrame(() => {
        updateLayoutVars();
        if (lenis) {
          lenis.resize();
          updateOffset();
          performScroll(true, true);
        }
      });
    };

    const ro = new ResizeObserver(onResize);

    onResize();
    requestAnimationFrame(onResize);
    requestAnimationFrame(() => requestAnimationFrame(onResize));

    if (contentRef) {
      ro.observe(contentRef);
      contentRef.addEventListener("wheel", handleUserInteraction, { passive: true });
      contentRef.addEventListener("touchmove", handleUserInteraction, { passive: true });
    }
    onCleanup(() => {
      if (contentRef) {
        contentRef.removeEventListener("wheel", handleUserInteraction);
        contentRef.removeEventListener("touchmove", handleUserInteraction);
      }
      ro.disconnect();
      clearTimeout(scrollTimeout);
      setIsActiveVisible(true);
      setJumpToActive(null);
    });
  });

  const hasOppAligned = createMemo(() => props.lyrics.Content.some((v) => v.OppositeAligned));

  const getBlurAmount = (index: number, reset = false): string => {
    if (reset) return "0px";

    const blurmap = getBlurmap();
    const active = activeIndices();
    let distance = Math.abs(index - scrollToIndex());

    for (const a of active) {
      const d = Math.abs(index - a);
      if (d < distance) distance = d;
    }

    const blur = distance >= blurmap.length ? blurmap[blurmap.length - 1] : blurmap[distance];
    return `${blur}px`;
  };

  const getLineOpacity = (index: number): number => {
    const active = activeIndices();
    let distance = Math.abs(index - scrollToIndex());

    for (const a of active) {
      const d = Math.abs(index - a);
      if (d < distance) distance = d;
    }

    if (distance === 0) return 1;
    if (distance === 1) return 0.85;
    if (distance === 2) return 0.55;
    return Math.max(0.2, 1 - distance * 0.25);
  };

  return (
    <div class="syllable-lyrics" ref={containerRef}>
      <For each={lineEntries()}>
        {(entry) => {
          const blur = createMemo(() => getBlurAmount(entry.index, isUserScroll()));
          const lineOpacity = createMemo(() => getLineOpacity(entry.index));
          const isActive = createMemo(() => {
            const isTarget = activeIndices().includes(entry.index);

            if (isTarget && entry.index === lineEntries().length - 1) {
              const endTime =
                entry.type === "interlude" ? entry.end : getVocalPartBounds(entry.content).end;

              return currentPos() <= endTime;
            }

            return isTarget;
          });

          const lineStatus = createMemo(() => {
            const active = activeIndices();
            if (active.includes(entry.index)) return "active";

            const endTime =
              entry.type === "interlude" ? entry.end : getVocalPartBounds(entry.content).end;

            if (currentPos() >= endTime) return "past";
            if (active.length > 0 && active[0] > entry.index) return "past";
            return "upcoming";
          });

          const isLineRTL = () => {
            if (entry.type === "interlude")
              return entry.isRTL && !(romanize() && romanize_position() === "replace");
            const shouldUseRomanizedReplace = romanize() && romanize_position() === "replace";
            return entry.content.IsRTL && !shouldUseRomanizedReplace;
          };

          const hasRomanizedText = createMemo(() => {
            if (entry.type === "interlude") return false;
            const syllables = entry.content.Lead.Syllables;
            return syllables.some((s) => s.RomanizedText && romanize());
          });

          return (
            <div
              class="line-wrapper"
              classList={{
                "has-romanized": hasRomanizedText(),
                "interlude-wrapper": entry.type === "interlude",
                "roman-bottom": romanize() && romanize_position() === "bottom",
                "roman-replace": romanize() && romanize_position() === "replace",
                "roman-top": romanize() && romanize_position() === "top",
                rtl: isLineRTL(),
              }}
              ref={(el) => {
                if (!el) return;
                elementToIndex.set(el, entry.index);
                itemRefs.set(entry.index, el);
              }}
              style={{
                "--l-blur": blur(),
                "--l-opacity": isActive() ? 1 : lineOpacity(),
                "--l-scale": isActive() ? 1.01 : 1,
                "filter": blur() !== "0px" ? `blur(${blur()})` : undefined,
              }}
            >
              {entry.type === "interlude" ? (
                <Interlude
                  start={entry.start}
                  end={entry.end}
                  currentPos={currentPos()}
                  oppAligned={entry.oppAligned}
                  rtl={isLineRTL()}
                />
              ) : (
                <>
                  <LeadRenderer
                    vocalPart={entry.content.Lead}
                    oppAligned={entry.content.OppositeAligned}
                    hasBg={!!entry.content.Background}
                    romanize={romanize()}
                    romanize_position={romanize_position()}
                    getCurrentPos={currentPos}
                    lineStatus={lineStatus}
                    isRTL={isLineRTL()}
                    hasOppAligned={hasOppAligned()}
                  />
                  <Show when={entry.content.Background}>
                    {(bg) => (
                      <For each={bg()}>
                        {(item) => (
                          <LeadRenderer
                            background
                            vocalPart={item}
                            oppAligned={entry.content.OppositeAligned}
                            romanize={romanize()}
                            romanize_position={romanize_position()}
                            getCurrentPos={currentPos}
                            lineStatus={lineStatus}
                            isRTL={isLineRTL()}
                            hasOppAligned={hasOppAligned()}
                          />
                        )}
                      </For>
                    )}
                  </Show>
                </>
              )}
            </div>
          );
        }}
      </For>
    </div>
  );
}

export default SyllableLyrics;

import { franc } from 'franc-min';

const JAPANESE_REGEX = /([ぁ-んァ-ン々])/;
const CHINESE_REGEX = /\p{Script=Han}/u;
const KOREAN_REGEX =
  /[\uac00-\ud7af]|[\u1100-\u11ff]|[\u3130-\u318f]|[\ua960-\ua97f]|[\ud7b0-\ud7ff]/;
const CYRILLIC_REGEX = /[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]{2,}/;
const GREEK_REGEX = /[\u0370-\u03FF\u1F00-\u1FFF]/;

// Indic Scripts
const HINDI_REGEX = /[\u0900-\u097F]/;
const PUNJABI_REGEX = /[\u0a00-\u0a7f]/;
const GUJARATI_REGEX = /[\u0a80-\u0af0]/;
const MALAYALAM_REGEX = /[\u0d00-\u0d7f]/;
const TELUGU_REGEX = /[\u0c00-\u0c7f]/;
const TAMIL_REGEX = /[\u0b80-\u0bff]/;
const BENGALI_REGEX = /[\u0980-\u09ff]/;

export type SupportedLanguage =
  | 'japanese'
  | 'korean'
  | 'chinese'
  | 'greek'
  | 'cyrillic'
  | 'hindi'
  | 'punjabi'
  | 'malayalam'
  | 'gujarati'
  | 'tamil'
  | 'telugu'
  | 'bengali';

export function detectLanguage(text: string): SupportedLanguage | 'unknown' | null {
  const lang = franc(text);

  if (lang === 'jpn' || JAPANESE_REGEX.test(text)) return 'japanese';
  if (lang === 'kor' || KOREAN_REGEX.test(text)) return 'korean';
  if (lang === 'cmn' || CHINESE_REGEX.test(text)) return 'chinese';

  if (
    ['bel', 'bul', 'kaz', 'mkd', 'rus', 'srp', 'tgk', 'ukr'].includes(lang) ||
    CYRILLIC_REGEX.test(text)
  ) {
    return 'cyrillic';
  }

  // 3. Indic Languages
  // Note: We check Bengali, Gujarati, Punjabi, Malayalam, Tamil, and Telugu
  // before Hindi because Hindi's Devanagari block can sometimes overlap with other scripts in detection libraries.
  if (lang === 'ben' || BENGALI_REGEX.test(text)) return 'bengali';
  if (lang === 'guj' || GUJARATI_REGEX.test(text)) return 'gujarati';
  if (lang === 'pan' || PUNJABI_REGEX.test(text)) return 'punjabi';
  if (lang === 'mal' || MALAYALAM_REGEX.test(text)) return 'malayalam';
  if (lang === 'tam' || TAMIL_REGEX.test(text)) return 'tamil';
  if (lang === 'tel' || TELUGU_REGEX.test(text)) return 'telugu';
  if (lang === 'hin' || HINDI_REGEX.test(text)) return 'hindi';

  // Greek
  if (lang === 'ell' || GREEK_REGEX.test(text)) return 'greek';

  return 'unknown';
}

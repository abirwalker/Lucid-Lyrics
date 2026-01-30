import type { SupportedLanguage } from '@/utils/lyrics/language.ts';
import { romanizeChinese } from '@/utils/lyrics/romanizers/chinese.ts';
import { romanizeCyrillic } from '@/utils/lyrics/romanizers/cyrillic.ts';
import { romanizeGreek } from '@/utils/lyrics/romanizers/greek.ts';
import { romanizeJapanese } from '@/utils/lyrics/romanizers/japanese.ts';
import { romanizeKorean } from '@/utils/lyrics/romanizers/korean.ts';
import { romanizeHindi } from '@/utils/lyrics/romanizers/hindi.ts';
import { romanizePunjabi } from '@/utils/lyrics/romanizers/punjabi.ts';
import { romanizeMalayalam } from '@/utils/lyrics/romanizers/malayalam.ts';
import { romanizeGujarati } from '@/utils/lyrics/romanizers/gujarati.ts';
import { romanizeTamil } from '@/utils/lyrics/romanizers/tamil.ts';
import { romanizeTelugu } from '@/utils/lyrics/romanizers/telugu.ts';
import { romanizeBengali } from '@/utils/lyrics/romanizers/bengali.ts';

export const Romanizers: Record<SupportedLanguage, (text: string) => Promise<string> | string> = {
  hindi: romanizeHindi,
  japanese: romanizeJapanese,
  korean: romanizeKorean,
  chinese: romanizeChinese,
  cyrillic: romanizeCyrillic,
  punjabi: romanizePunjabi,
  tamil: romanizeTamil,
  telugu: romanizeTelugu,
  bengali: romanizeBengali,
  malayalam: romanizeMalayalam,
  gujarati: romanizeGujarati,
  greek: romanizeGreek,
};

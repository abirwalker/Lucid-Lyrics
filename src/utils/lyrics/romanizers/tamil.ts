import { tamilRomanization } from '@/lib/tamilRomanization.ts';

export function romanizeTamil(text: string) {
  return tamilRomanization(text);
}

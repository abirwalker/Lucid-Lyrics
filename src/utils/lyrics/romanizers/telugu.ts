import { teluguRomanization } from '@/lib/teluguRomanization.ts';

export function romanizeTelugu(text: string) {
  return teluguRomanization(text);
}

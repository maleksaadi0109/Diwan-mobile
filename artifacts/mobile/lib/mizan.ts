/**
 * Client for ميزان العرب (mizanalarab.com) — a verified-text source for
 * classical Arabic poetry. The mobile client requests only the fields the
 * import pipeline needs (title, poet name, ordered verse text).
 *
 * Poem lookups are routed through the shared api-server's /api/mizan/poem/:id
 * proxy rather than fetched directly, because mizanalarab.com sends no CORS
 * allow-origin header — a direct browser fetch (web preview, or any future
 * web build) fails outright, even though native app fetches are unaffected.
 * Proxying server-side makes the feature work the same way everywhere.
 */

import { apiDomain } from './api';
export { POEM_CATALOG } from './readyCatalog';
export type { CatalogPoemEntry } from './readyCatalog';

export interface MizanVersePayload {
  id: string | number;
  order_num?: number;
  order_index?: number;
  text: string;
}

export interface MizanPoemResponse {
  id: string | number;
  title: string;
  poet_name?: string;
  poet?: { name?: string; era?: string };
  era?: string;
  meter_name?: string;
  bahr?: string;
  verses: MizanVersePayload[];
}

export interface ParsedMizanPoem {
  title: string;
  poetName: string;
  era?: string;
  meter?: string;
  verses: { orderIndex: number; text: string; externalId?: string }[];
}

export interface MizanExplanation {
  text: string;
  author?: string;
  authorDeathHijri?: string;
  sourceTitle?: string;
  type: 'classical' | 'verse';
}

/** Mizan verse IDs are opaque provider identifiers, but must never be URL paths. */
export function isSafeMizanVerseId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(value);
}

/** Extracts the poem id from a mizanalarab.com/poem/{id} URL. */
export function extractMizanPoemId(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('صيغة رابط ميزان العرب غير صحيحة');
  }
  const validHosts = ['mizanalarab.com', 'www.mizanalarab.com'];
  if (!validHosts.includes(parsed.hostname.toLowerCase())) {
    throw new Error('الرابط يجب أن يكون من موقع mizanalarab.com');
  }
  const match = parsed.pathname.match(/\/poem\/([^/?#]+)/i);
  if (!match || !match[1]) {
    throw new Error('تعذر استخراج معرف القصيدة من الرابط');
  }
  return match[1].trim();
}

export async function fetchMizanPoem(poemId: string): Promise<MizanPoemResponse> {
  if (!isSafeMizanVerseId(poemId)) throw new Error('معرف القصيدة من ميزان العرب غير صالح');
  const endpoint = `https://${apiDomain()}/api/mizan/poem/${encodeURIComponent(poemId)}`;
  let response: Response;
  try {
    response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('تعذر الاتصال بموقع ميزان العرب، تحقق من الإنترنت');
  }
  if (!response.ok) {
    let message = `فشل جلب القصيدة من ميزان العرب (HTTP ${response.status})`;
    try {
      const errBody = (await response.json()) as { error_message?: string };
      if (errBody?.error_message) message = errBody.error_message;
    } catch {
      // ignore — fall back to the generic message above
    }
    throw new Error(message);
  }
  const data = (await response.json()) as MizanPoemResponse;
  if (
    !data ||
    typeof data.title !== 'string' ||
    !data.title.trim() ||
    !Array.isArray(data.verses) ||
    data.verses.length === 0 ||
    data.verses.some((verse) => !verse || typeof verse.text !== 'string' || !verse.text.trim())
  ) {
    throw new Error('استجابة ميزان العرب ناقصة أو غير متوافقة');
  }
  return data;
}

export function parseMizanPoem(response: MizanPoemResponse): ParsedMizanPoem {
  const poetName = nonEmptyString(response.poet_name) || nonEmptyString(response.poet?.name) || 'شاعر غير معروف';
  const era = nonEmptyString(response.poet?.era) || nonEmptyString(response.era);
  const meter = nonEmptyString(response.meter_name) || nonEmptyString(response.bahr);
  const verses = response.verses.map((v, idx) => ({
    orderIndex: v.order_num ?? v.order_index ?? idx + 1,
    text: v.text,
    ...(typeof v.id === 'string' || typeof v.id === 'number'
      ? isSafeMizanVerseId(String(v.id))
        ? { externalId: String(v.id) }
        : {}
      : {}),
  }));
  return { title: response.title.trim(), poetName, era, meter, verses };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseClassical(raw: unknown, verseId: string): MizanExplanation[] {
  const records = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  return records.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    const text = nonEmptyString(item.text);
    if (!text) return [];
    if (item.verse_id != null && String(item.verse_id) !== verseId) return [];
    return [{
      text,
      author: nonEmptyString(item.author),
      authorDeathHijri: nonEmptyString(item.author_death_hijri),
      sourceTitle: nonEmptyString(item.source_title),
      type: 'classical' as const,
    }];
  });
}

function parseVerseExplanation(raw: unknown): MizanExplanation[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const item = raw as Record<string, unknown>;
  const text = nonEmptyString(item.text) ?? nonEmptyString(item.explanation) ?? nonEmptyString(item.meaning);
  return text ? [{ text, type: 'verse' }] : [];
}

export async function fetchMizanExplanations(verseId: string): Promise<MizanExplanation[]> {
  if (!isSafeMizanVerseId(verseId)) throw new Error('معرف البيت من ميزان العرب غير صالح');
  const base = `https://${apiDomain()}/api/mizan/explanations`;
  const requests = (['classical', 'verse'] as const).map(async (kind) => {
    let response: Response;
    try {
      response = await fetch(`${base}/${kind}/${encodeURIComponent(verseId)}`, {
        headers: { Accept: 'application/json' },
      });
    } catch {
      throw new Error('تعذر الاتصال بميزان العرب، تحقق من الإنترنت');
    }
    if (!response.ok) {
      throw new Error(`تعذر جلب الشرح من ميزان العرب (HTTP ${response.status})`);
    }
    const raw: unknown = await response.json();
    return kind === 'classical' ? parseClassical(raw, verseId) : parseVerseExplanation(raw);
  });
  const results = await Promise.allSettled(requests);
  const items = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  if (results.every((result) => result.status === 'rejected')) {
    throw results[0].status === 'rejected' && results[0].reason instanceof Error
      ? results[0].reason
      : new Error('تعذر جلب شرح البيت من ميزان العرب');
  }
  return items;
}

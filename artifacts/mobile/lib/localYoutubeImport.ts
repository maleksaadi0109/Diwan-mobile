import type { MizanPoemResponse } from './mizan';

/** Android can contact Mizan directly; the web/iOS proxy is only needed for web CORS. */
export async function fetchMizanPoemOnDevice(poemId: string): Promise<MizanPoemResponse> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/.test(poemId)) {
    throw new Error('معرف القصيدة من ميزان العرب غير صالح');
  }
  let response: Response;
  try {
    response = await fetch(`https://mizanalarab.com/api/poems/${encodeURIComponent(poemId)}`, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new Error('تعذر الاتصال بموقع ميزان العرب، تحقق من الإنترنت');
  }
  if (!response.ok) throw new Error(`فشل جلب النص من ميزان العرب (HTTP ${response.status})`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object') throw new Error('استجابة ميزان العرب غير صالحة');
  const poem = data as Partial<MizanPoemResponse>;
  if (
    typeof poem.title !== 'string' || !poem.title.trim() ||
    !Array.isArray(poem.verses) || !poem.verses.length ||
    poem.verses.some((verse) => !verse || typeof verse.text !== 'string' || !verse.text.trim())
  ) {
    throw new Error('استجابة ميزان العرب ناقصة أو غير متوافقة');
  }
  return poem as MizanPoemResponse;
}
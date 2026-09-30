import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const MIZAN_BASE_URL = "https://mizanalarab.com";

function isSafePoemId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,40}$/.test(value);
}

// Proxies mizanalarab.com's poem API server-side. The site has no CORS
// allow-origin header, so a browser (web preview, and any future web
// deployment) cannot fetch it directly — only native app fetches are
// unaffected by CORS. Routing through our own server avoids that entirely.
router.get("/mizan/poem/:id", async (req, res): Promise<void> => {
  const { id } = req.params;
  if (!isSafePoemId(id)) {
    res.status(400).json({ error_code: "INVALID_POEM_ID", error_message: "معرف القصيدة غير صالح" });
    return;
  }

  try {
    const upstream = await fetch(`${MIZAN_BASE_URL}/api/poems/${encodeURIComponent(id)}`, {
      headers: { Accept: "application/json" },
    });
    if (!upstream.ok) {
      res.status(502).json({
        error_code: "MIZAN_FETCH_FAILED",
        error_message: `فشل جلب القصيدة من ميزان العرب (HTTP ${upstream.status})`,
      });
      return;
    }
    const data = await upstream.json();
    res.json(data);
  } catch (error) {
    logger.warn({ err: error, id }, "Mizan Al-Arab poem fetch failed");
    res.status(502).json({
      error_code: "MIZAN_FETCH_FAILED",
      error_message: "تعذر الاتصال بموقع ميزان العرب، حاول مرة أخرى",
    });
  }
});

for (const kind of ["classical", "verse"] as const) {
  router.get(`/mizan/explanations/${kind}/:id`, async (req, res): Promise<void> => {
    const { id } = req.params;
    if (!isSafePoemId(id)) {
      res.status(400).json({ error_code: "INVALID_VERSE_ID", error_message: "معرف البيت غير صالح" });
      return;
    }

    try {
      const upstream = await fetch(
        `${MIZAN_BASE_URL}/api/explanations/${kind}/${encodeURIComponent(id)}`,
        { headers: { Accept: "application/json" } },
      );
      if (!upstream.ok) {
        res.status(502).json({
          error_code: "MIZAN_FETCH_FAILED",
          error_message: `فشل جلب الشرح من ميزان العرب (HTTP ${upstream.status})`,
        });
        return;
      }
      const raw: unknown = await upstream.json();
      const entries = Array.isArray(raw) ? raw : [raw];
      const safeEntries = entries.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const item = entry as Record<string, unknown>;
        if (item.verse_id != null && String(item.verse_id) !== id) return [];
        if (kind === "classical") {
          if (typeof item.text !== "string" || !item.text.trim()) return [];
          return [{
            text: item.text,
            ...(typeof item.author === "string" && { author: item.author }),
            ...(typeof item.author_death_hijri === "string" && { author_death_hijri: item.author_death_hijri }),
            ...(typeof item.source_title === "string" && { source_title: item.source_title }),
            ...(item.verse_id != null && { verse_id: String(item.verse_id) }),
          }];
        }
        const text = [item.text, item.explanation, item.meaning].find(
          (value): value is string => typeof value === "string" && Boolean(value.trim()),
        );
        return text ? [{ text }] : [];
      });
      res.json(kind === "classical" ? safeEntries : safeEntries[0] ?? {});
    } catch (error) {
      logger.warn({ err: error, id, kind }, "Mizan explanation fetch failed");
      res.status(502).json({
        error_code: "MIZAN_FETCH_FAILED",
        error_message: "تعذر الاتصال بموقع ميزان العرب، حاول مرة أخرى",
      });
    }
  });
}

export default router;

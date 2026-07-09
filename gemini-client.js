import { GoogleGenAI } from '@google/genai';

const { GEMINI_API_KEY } = process.env;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const MODEL = 'gemini-2.5-flash';

// Simple sleep helper
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Extracts the first valid JSON object found in a text blob.
 * Models sometimes wrap JSON in ```json fences or add commentary —
 * this strips that and parses defensively.
 */
export function extractJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) return null;
    const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
    try {
        return JSON.parse(jsonSlice);
    } catch {
        return null;
    }
}

/**
 * Calls Gemini with Google Search grounding enabled, retrying on rate
 * limits (429) with exponential backoff. Returns { json, rawText } or
 * throws after exhausting retries.
 */
export async function groundedResearchCall(prompt, { maxRetries = 4 } = {}) {
    let attempt = 0;
    let lastErr = null;

    while (attempt <= maxRetries) {
        try {
            const response = await ai.models.generateContent({
                model: MODEL,
                contents: prompt,
                config: { tools: [{ googleSearch: {} }] },
            });
            const rawText = response.text ?? '';
            const json = extractJson(rawText);
            return { json, rawText };
        } catch (err) {
            lastErr = err;
            const isDailyQuota = /PerDay/i.test(err.message || '');
            if (isDailyQuota) {
                // Backing off won't help a daily cap — fail immediately with a clear signal.
                err.isDailyQuota = true;
                throw err;
            }
            const isRateLimit = /429|rate.?limit|resource.?exhausted/i.test(err.message || '');
            if (!isRateLimit || attempt === maxRetries) break;
            const backoffMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s, 16s
            console.log(`   ⏳ Rate limited, retrying in ${backoffMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
            await sleep(backoffMs);
            attempt += 1;
        }
    }
    throw lastErr;
}

export function extractJsonArray(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1] : text;
    const firstBracket = candidate.indexOf('[');
    const lastBracket = candidate.lastIndexOf(']');
    if (firstBracket === -1 || lastBracket === -1) return null;
    const jsonSlice = candidate.slice(firstBracket, lastBracket + 1);
    try {
        return JSON.parse(jsonSlice);
    } catch {
        return null;
    }
}

export { sleep };
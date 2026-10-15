/* =========================================================
   Schedule from Pic — Vision-LLM Provider Adapters
   Each adapter exports { name, needs, extract(imageDataUrl) }.
   `imageDataUrl` is a base64 data URL (data:image/...;base64,...).
   `extract` returns a raw JSON object (validated by prompt.js).
   ========================================================= */

import { SYSTEM_PROMPT, validateAndNormalize } from "./prompt.js";

/**
 * Helper: read a File/Blob and downscale it via a Canvas to keep
 * payload small (and free-tier-friendly). Max 1600px on longest edge,
 * JPEG quality 0.85. Returns a base64 data URL (no prefix).
 */
export async function downscaleImage(file, maxEdge = 1600, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Strip the `data:image/jpeg;base64,` prefix so providers that
 * expect raw base64 (or want it under a different mime key) can use it.
 */
export function splitDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(dataUrl);
  if (!m) throw new Error("Invalid data URL");
  return { mime: m[1], b64: m[2] };
}

/* ---------- Google Gemini 3.6 Flash ----------
   Docs: https://ai.google.dev/gemini-api/docs/vision
   Free tier: 15 RPM, 1,500 req/day.
   NOTE: gemini-2.0-flash was shut down by Google; we now use
   gemini-3.6-flash. The request/response shape is identical.
*/
export const gemini = {
  name: "Gemini 3.6 Flash",
  needs: { apiKey: true, envVar: null },
  async extract(dataUrl, { apiKey, onStatus }) {
    if (!apiKey) throw new Error("Missing Gemini API key");
    onStatus?.("Uploading to Gemini…");
    const { b64 } = splitDataUrl(dataUrl);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [{
        parts: [
          { text: SYSTEM_PROMPT + "\n\nNow extract the event from this image. Return only the JSON object, nothing else." },
          { inline_data: { mime_type: "image/jpeg", data: b64 } },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
    }
    onStatus?.("Reading response…");
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no content");
    return validateAndNormalize(text);
  },
};

/* ---------- Groq (Llama 3.2 Vision) ----------
   Docs: https://console.groq.com/docs/vision
   Free tier: 30 RPM, ~14,400 req/day.
*/
export const groq = {
  name: "Groq Llama 3.2 Vision",
  needs: { apiKey: true },
  async extract(dataUrl, { apiKey, onStatus }) {
    if (!apiKey) throw new Error("Missing Groq API key");
    onStatus?.("Uploading to Groq…");
    const { mime, b64 } = splitDataUrl(dataUrl);

    const url = "https://api.groq.com/openai/v1/chat/completions";
    const body = {
      model: "llama-3.2-11b-vision-preview",
      messages: [
        { role: "system", content: SYSTEM_PROMPT + "\n\nReturn ONLY a JSON object. No prose, no fences." },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the event from this image. Return only the JSON object." },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
      max_tokens: 1024,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Groq ${res.status}: ${errText.slice(0, 300)}`);
    }
    onStatus?.("Reading response…");
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Groq returned no content");
    return validateAndNormalize(text);
  },
};

/* ---------- HuggingFace Inference (Qwen2-VL-7B) ----------
   Docs: https://huggingface.co/docs/api-inference/
   Free tier: rate-limited but present. Used as last-resort failover.
*/
export const huggingface = {
  name: "HuggingFace Qwen2-VL",
  needs: { apiKey: true },
  async extract(dataUrl, { apiKey, onStatus }) {
    if (!apiKey) throw new Error("Missing HuggingFace token");
    onStatus?.("Uploading to HuggingFace…");
    const { b64 } = splitDataUrl(dataUrl);
    // Decode base64 -> binary, send as multipart (HF doesn't accept
    // data URLs in chat-style endpoints; we hit the image-to-text endpoint).
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const url = "https://api-inference.huggingface.co/models/Qwen/Qwen2-VL-7B-Instruct";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/octet-stream",
        "x-wait-for-model": "true",
      },
      body: bytes,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HuggingFace ${res.status}: ${errText.slice(0, 300)}`);
    }
    onStatus?.("Reading response…");
    const json = await res.json();
    // HF image-to-text returns { generated_text: "..." } or an array.
    const text = Array.isArray(json) ? json[0]?.generated_text : json?.generated_text;
    if (!text) throw new Error("HuggingFace returned no content");
    // We need to coerce its free-form answer into JSON. Wrap in system
    // prompt context and validate; if the model returned prose, validateAndNormalize
    // will still attempt to find a JSON block via its existing logic.
    return validateAndNormalize(extractJsonBlock(text, SYSTEM_PROMPT));
  },
};

/**
 * HuggingFace models often ignore strict JSON mode. Try to find a
 * JSON block in the output. If none is found, return the original
 * text — validateAndNormalize will raise a descriptive error.
 */
function extractJsonBlock(text, _hint) {
  if (!text) return text;
  // First try parsing as-is
  try { JSON.parse(text); return text; } catch { /* fall through */ }
  // Find a {...} block
  const m = /\{[\s\S]*\}/.exec(text);
  return m ? m[0] : text;
}

/* ---------- Provider registry + failover helper ---------- */
export const PROVIDERS = { gemini, groq, huggingface };

/**
 * Try providers in order, stopping at the first success.
 * Pass a `startingWith` to honor the user's default choice; the
 * remaining providers are tried in their registry order.
 *
 * @param {string} startingWith   'gemini' | 'groq' | 'huggingface'
 * @param {string} dataUrl
 * @param {object} keys            { gemini, groq, huggingface }
 * @param {object} [opts]          { onProviderTry, onStatus, signal }
 * @returns {Promise<{ event, provider }>}
 */
export async function extractWithFailover(startingWith, dataUrl, keys, opts = {}) {
  const order = orderProviders(startingWith);
  const tried = [];
  let lastErr = null;

  for (const id of order) {
    const provider = PROVIDERS[id];
    if (!provider) continue;
    const apiKey = (keys[id] || "").trim();
    if (!apiKey) {
      tried.push({ id, skipped: true, reason: "no API key" });
      continue;
    }
    opts.onProviderTry?.(provider.name, tried);
    try {
      const event = await provider.extract(dataUrl, { apiKey, onStatus: opts.onStatus, signal: opts.signal });
      return { event, provider: provider.name, id };
    } catch (e) {
      // Abort if caller asked us to stop
      if (opts.signal?.aborted) throw e;
      const isRateLimit = /429|rate.?limit/i.test(String(e.message));
      tried.push({ id, skipped: false, error: e.message, rateLimit: isRateLimit });
      lastErr = e;
    }
  }

  const err = new Error(
    `All providers failed. Last error: ${lastErr?.message || "no API keys configured"}`
  );
  err.tried = tried;
  throw err;
}

function orderProviders(start) {
  const all = ["gemini", "groq", "huggingface"];
  if (!start || !all.includes(start)) return all;
  return [start, ...all.filter((p) => p !== start)];
}

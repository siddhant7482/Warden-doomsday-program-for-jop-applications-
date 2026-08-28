import { z } from "zod";

/* ============================================================
   OpenRouter client.

   Deliberately thin — no SDK. OpenRouter speaks the OpenAI chat
   completions shape, so a fetch wrapper is the whole integration, and
   it keeps a dependency (and its install footprint) off a box with
   120GB of disk.

   Two call sites, two very different jobs:
     triage()   — read the emails the pattern parsers could not
     compose()  — write the daily message

   Both are optional. With no API key the app degrades to deterministic
   parsing and fallback copy rather than failing, because the
   enforcement engine has to keep working whether or not a third party
   is reachable.
   ============================================================ */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export class OpenRouterError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = "OpenRouterError";
  }
}

export function hasKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/** Model slugs live in env so swapping them never needs a code change.
 *  Verify current slugs at openrouter.ai/models — they do change. */
export const MODELS = {
  /** High volume, low stakes: which of these is even job-related. */
  triage: () => process.env.OPENROUTER_TRIAGE_MODEL || "anthropic/claude-haiku-4.5",
  /** Low volume, high stakes: extraction that feeds the count, and the
   *  daily message. Worth the better model — a hallucinated company
   *  invents an application, and a flat message gets ignored. */
  reason: () => process.env.OPENROUTER_EXTRACT_MODEL || "anthropic/claude-sonnet-4.5",
};

interface ChatOptions {
  model: string;
  system: string;
  user: string;
  /** Ask for JSON back. Validation is still done with zod — a model
   *  saying it returned JSON is not the same as it having done so. */
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

async function chat(opts: ChatOptions): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new OpenRouterError("OPENROUTER_API_KEY is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        // OpenRouter attributes usage to these; harmless if unset.
        "HTTP-Referer": "https://commandhq.local/warden",
        "X-Title": "Warden",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.4,
        ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      throw new OpenRouterError(
        `OpenRouter ${res.status}: ${body.slice(0, 300)}`,
        res.status,
        retryable,
      );
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new OpenRouterError("OpenRouter returned an empty completion");
    }
    return text;
  } catch (e) {
    if (e instanceof OpenRouterError) throw e;
    if ((e as Error).name === "AbortError") {
      throw new OpenRouterError("OpenRouter request timed out", undefined, true);
    }
    throw new OpenRouterError(`OpenRouter request failed: ${(e as Error).message}`, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Retries only what is worth retrying: rate limits and transient
 *  server errors. A 400 means the request is wrong and will stay wrong. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const retryable = e instanceof OpenRouterError && e.retryable;
      if (!retryable || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 600 * 2 ** i));
    }
  }
  throw last;
}

/** Models wrap JSON in prose or fences often enough to be worth
 *  handling rather than failing the whole ingest over. */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const braced = candidate.match(/\{[\s\S]*\}/);
    if (braced) return JSON.parse(braced[0]);
    throw new OpenRouterError(`Model did not return JSON: ${raw.slice(0, 200)}`);
  }
}

export async function chatJson<T>(
  opts: Omit<ChatOptions, "json">,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await withRetry(() => chat({ ...opts, json: true }));
  const json = extractJson(raw);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    /* Include what actually arrived. "Invalid option" without the
     * offending value is a dead end when the model is the black box. */
    const issues = parsed.error.issues
      .map((i) => {
        const path = i.path.join(".") || "(root)";
        const got = i.path.reduce<unknown>(
          (acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[String(k)] : undefined),
          json,
        );
        return `${path}: ${i.message} — got ${JSON.stringify(got)}`;
      })
      .join("; ");
    throw new OpenRouterError(
      `Model output failed validation: ${issues}\n      raw: ${raw.replace(/\s+/g, " ").slice(0, 300)}`,
    );
  }
  return parsed.data;
}

export async function chatText(opts: Omit<ChatOptions, "json">): Promise<string> {
  return (await withRetry(() => chat(opts))).trim();
}

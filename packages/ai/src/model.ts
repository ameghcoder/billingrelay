import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

// Chosen by trying both on the same requests: gpt-4.1-mini drafted correctly 4 of 4 and asked when a price was missing; gpt-4o-mini
// was right about half the time. OPENAI_MODEL overrides it.
export const DEFAULT_MODEL = "gpt-4.1-mini";

/** The configured model, or null when there's no key: the manual catalog editor keeps working without it. */
export function configuredModel(env: Record<string, string | undefined> = process.env): LanguageModel | null {
  if (!env.OPENAI_API_KEY) return null;
  return createOpenAI({ apiKey: env.OPENAI_API_KEY })(env.OPENAI_MODEL || DEFAULT_MODEL);
}

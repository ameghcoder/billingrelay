import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export const DEFAULT_MODEL = "gpt-4o-mini";

/** The configured model, or null when there's no key: the manual catalog editor keeps working without it. */
export function configuredModel(env: Record<string, string | undefined> = process.env): LanguageModel | null {
  if (!env.OPENAI_API_KEY) return null;
  return createOpenAI({ apiKey: env.OPENAI_API_KEY })(env.OPENAI_MODEL || DEFAULT_MODEL);
}

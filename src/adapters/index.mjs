import { ConfigError } from "../errors.mjs";
import { prepareAnthropic } from "./anthropic.mjs";
import { prepareGemini } from "./gemini.mjs";
import { prepareOpenAIChat } from "./openai-chat.mjs";
import { prepareOpenAIResponses } from "./openai-responses.mjs";

const PREPARERS = {
  "openai-chat": prepareOpenAIChat,
  "openai-responses": prepareOpenAIResponses,
  anthropic: prepareAnthropic,
  gemini: prepareGemini,
};

export async function prepareAdapter(candidate, request, context) {
  const prepare = PREPARERS[candidate.provider.type];
  if (!prepare) throw new ConfigError(`Unsupported provider type '${candidate.provider.type}'`);
  return prepare(candidate, request, context);
}

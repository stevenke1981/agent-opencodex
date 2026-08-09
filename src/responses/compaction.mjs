export const AOCX_COMPACTION_PREFIX = "aocx1:";
export const LEGACY_OCX_COMPACTION_PREFIX = "ocx1:";

export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done as clear next steps
- Critical data, examples, file paths, commands, or references needed to continue

Be concise, structured, factual, and focused on seamless continuation. Do not call tools.`;

export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
export const OPAQUE_COMPACTION_NOTE = "[Earlier context was compacted in an opaque format that this routed model cannot decode.]";
const RETAINED_CHAR_BUDGET = 80_000;

export function encodeCompactionSummary(summary) {
  return `${AOCX_COMPACTION_PREFIX}${Buffer.from(String(summary), "utf8").toString("base64")}`;
}

export function decodeCompactionSummary(value) {
  if (typeof value !== "string") return null;
  const prefix = [AOCX_COMPACTION_PREFIX, LEGACY_OCX_COMPACTION_PREFIX].find((candidate) => value.startsWith(candidate));
  if (!prefix) return null;
  try {
    const decoded = Buffer.from(value.slice(prefix.length), "base64").toString("utf8");
    return decoded || null;
  } catch {
    return null;
  }
}

export function compactionItemToText(value) {
  const decoded = decodeCompactionSummary(value);
  return decoded ? `${SUMMARY_PREFIX}\n\n${decoded}` : OPAQUE_COMPACTION_NOTE;
}

export function extractCompactUserMessages(input) {
  if (!Array.isArray(input)) return [];
  const output = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type !== undefined && item.type !== "message") continue;
    if (item.role !== "user") continue;
    const text = compactMessageText(item.content);
    if (text.trim()) output.push(text);
  }
  return output;
}

export function buildCompactV1Output(userMessages, summary) {
  const selected = [];
  let remaining = RETAINED_CHAR_BUDGET;
  for (let index = userMessages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = String(userMessages[index]);
    if (message.length <= remaining) {
      selected.push(message);
      remaining -= message.length;
      continue;
    }
    let start = message.length - remaining;
    if (start > 0 && start < message.length) {
      const first = message.charCodeAt(start);
      if (first >= 0xdc00 && first <= 0xdfff) start += 1;
    }
    selected.push(message.slice(start));
    break;
  }
  selected.reverse();
  const finalSummary = String(summary ?? "").trim();
  const summaryText = finalSummary ? `${SUMMARY_PREFIX}\n${finalSummary}` : "(no summary available)";
  return [...selected.map(messageItem), messageItem(summaryText)];
}

function messageItem(text) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function compactMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    if (["input_text", "text"].includes(part.type) && typeof part.text === "string") return part.text;
    return "";
  }).join("");
}

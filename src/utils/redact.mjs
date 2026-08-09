const SECRET_KEY_PATTERN = /(api[-_]?key|authorization|token|secret|password|credential|cookie)/i;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi;
const COMMON_KEY_PATTERN = /\b(sk|rk|pk|key)-[A-Za-z0-9_-]{8,}\b/g;

export function buildRedactor(secretValues = []) {
  const values = [...new Set(secretValues.filter((value) => typeof value === "string" && value.length >= 4))]
    .sort((a, b) => b.length - a.length);
  return (input) => {
    let text = String(input ?? "");
    for (const secret of values) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(BEARER_PATTERN, "$1[REDACTED]")
      .replace(COMMON_KEY_PATTERN, "[REDACTED_KEY]");
  };
}

export function redactObject(value, redactor = buildRedactor()) {
  if (Array.isArray(value)) return value.map((entry) => redactObject(entry, redactor));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactObject(entry, redactor);
    }
    return output;
  }
  return typeof value === "string" ? redactor(value) : value;
}

export function collectSecretsFromEnv(env = process.env) {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_KEY_PATTERN.test(key) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value);
}

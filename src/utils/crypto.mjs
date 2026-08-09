import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export function createId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

import { createHash, randomUUID } from "node:crypto";

/** Filesystem-safe slug. */
export function slug(input: string, max = 60): string {
  const s = input
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return s.length > 0 ? s : "untitled";
}

export function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export function pad(n: number, width = 3): string {
  return String(n).padStart(width, "0");
}

/** Compact, filesystem-safe UTC stamp: 2026-08-29T14-03-21 */
export function stamp(d = new Date()): string {
  return d.toISOString().replace(/:/g, "-").replace(/\..+$/, "");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function uuid(): string {
  return randomUUID();
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Human-readable one-line preview of a text blob. */
export function preview(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** Milliseconds elapsed since an hrtime.bigint() mark. */
export function since(start: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
}

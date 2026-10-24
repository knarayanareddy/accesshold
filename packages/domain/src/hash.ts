import { sha256 } from "@noble/hashes/sha2.js";

/** Runtime-neutral SHA-256 helper shared by Node services and browser fixtures. */
export function sha256Hex(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

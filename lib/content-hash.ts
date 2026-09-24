/**
 * Content hashing — SHA-256, the hash Stellar and Soroban actually speak.
 *
 * ── Why this replaces `keccak256(toBytes(x))` everywhere ─────────────────────
 *
 * The EVM-era code hashed with keccak256 because that is what Solidity's
 * `keccak256()` and EIP-191 message signing use, so an off-chain hash could be
 * recomputed on chain. On Soroban the on-chain primitive is
 * `env.crypto().sha256()` — there is no keccak in the host interface — so a
 * keccak digest can no longer be checked by a contract, and the client-side
 * equivalent of the host function is `hash()` from `@stellar/stellar-sdk`
 * (verified: `hash(Buffer.from("abc"))` → `ba7816bf…0015ad`, the SHA-256 of
 * "abc"). Both produce 32 bytes, so every `BytesN<32>` field — `evidence_hash`,
 * `context_hash` — takes the new digest unchanged.
 *
 * ── Hex form: no `0x` prefix ─────────────────────────────────────────────────
 *
 * `0x…` is an EVM convention. Stellar tooling (and `lib/contract.ts`'s own
 * `toHex`) writes bare lowercase hex, and `fromHex32` tolerates either, so this
 * emits bare hex and the values round-trip through the contract boundary.
 *
 * Digests here are NOT interchangeable with the keccak ones they replace. Any
 * hash persisted before the migration (an archived `evidence_hash`, a stored
 * `metadataHash`) will not match a freshly computed one — that is a data
 * migration question, not something this module can paper over.
 */
import { hash } from "@stellar/stellar-sdk";

/** Raw SHA-256 of a UTF-8 string or byte array. Always 32 bytes. */
export function sha256Bytes(data: string | Uint8Array): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return hash(bytes);
}

/** SHA-256 as 64 lowercase hex characters, unprefixed. */
export function sha256Hex(data: string | Uint8Array): string {
  return sha256Bytes(data).toString("hex");
}

/** 32 zero bytes in hex — the "no hash attached" sentinel the contract stores. */
export const ZERO_HASH_HEX = "0".repeat(64);

/** True when a string is a 32-byte hex digest (with or without an `0x` prefix). */
export function isHash32Hex(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(normalized);
}

/**
 * Minimal snapshot shape required by `evidenceHashFromSnapshot`.
 * Defined here rather than importing from evidence-fetcher to avoid a circular
 * dependency: content-hash is a leaf module.
 */
export interface EvidenceHashable {
  /** Raw HTTP response bytes, when available (direct / Jina / bot-paid paths). */
  rawBytes?: Buffer | undefined;
  /** Post-processed text (stripped HTML, truncated). Always present. */
  text: string;
}

/**
 * Canonical hash of an evidence snapshot, choosing the most verifiable input.
 *
 * When `featureEnabled` is true AND `rawBytes` are present the hash is
 * SHA-256(rawBytes) — i.e. the same bytes any third party would get by re-fetching
 * the URL and hashing the response body. This is the preferred binding because it
 * is fully independent of Mimir's text-processing pipeline.
 *
 * When the flag is off, or when raw bytes are unavailable (CoinGecko synthesised
 * text, or any path where `rawBytes` was not captured), the hash falls back to
 * SHA-256(text) — the legacy behaviour. Callers that need to know which path was
 * taken should inspect `snapshot.rawBytes !== undefined`.
 *
 * Council settlement mode appends an oracle-synthetic JSON tally to the commit
 * string. That tally has no corresponding raw bytes (it is assembled by the oracle,
 * not fetched from a URL), so the caller must pass the combined `text+council` blob
 * as `fallbackText` and leave `rawBytes` undefined — the resulting hash covers both
 * the evidence and the tally and is clearly documented as such.
 */
export function evidenceHashFromSnapshot(
  snapshot: EvidenceHashable,
  featureEnabled: boolean,
  /** Override the text fallback when the caller has concatenated additional data. */
  fallbackText?: string,
): string {
  if (featureEnabled && snapshot.rawBytes !== undefined && snapshot.rawBytes.byteLength > 0) {
    return sha256Hex(snapshot.rawBytes);
  }
  return sha256Hex(fallbackText ?? snapshot.text);
}

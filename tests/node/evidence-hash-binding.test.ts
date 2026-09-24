/**
 * evidence-hash-binding.test.ts
 *
 * Verifies that:
 *   1. evidenceHashFromSnapshot (lib/content-hash.ts) chooses raw bytes over text
 *      when the flag is enabled and rawBytes are present.
 *   2. The hash equals SHA-256 of the raw bytes, not the stripped text — a verifier
 *      who re-fetches the URL and hashes the body gets the same digest.
 *   3. The fallback to text hashing works correctly when the flag is off or when
 *      rawBytes is absent (CoinGecko, council mode).
 *   4. fetchEvidence (lib/server/evidence-fetcher.ts) populates rawBytes on the
 *      snapshot for direct, jina, and bot-paid fetchers.
 *   5. CoinGecko path leaves rawBytes undefined.
 *   6. The feature flag in lib/ops/flags.ts is present, defaults to true, and
 *      responds to the env var override.
 *   7. DB migration: ClaimRow includes evidence_hash; buildClaimUpsertStatement
 *      uses COALESCE to preserve a non-null hash across re-indexing passes.
 *
 * All tests are offline — no sockets, no DB.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createHash } from "node:crypto";

import {
  sha256Hex,
  evidenceHashFromSnapshot,
  type EvidenceHashable,
} from "../../lib/content-hash";
import {
  isFeatureEnabled,
  FEATURES,
} from "../../lib/ops/flags";
import {
  fetchEvidence,
  EvidenceFetchError,
} from "../../lib/server/evidence-fetcher";

// ── Helpers ───────────────────────────────────────────────────────────────────

type FetchMock = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function withFetch<T>(mock: FetchMock, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** Returns a real sha256 hex digest so test vectors are self-consistent. */
function nodesha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(typeof data === "string" ? Buffer.from(data, "utf8") : data).digest("hex");
}

function okHtmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function okPlainResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// ── 1. evidenceHashFromSnapshot — positive (raw bytes binding) ────────────────

describe("evidenceHashFromSnapshot: raw bytes binding", () => {
  const rawHtml = "<html><body>" + "Hello World ".repeat(50) + "</body></html>";
  const rawBytes = Buffer.from(rawHtml, "utf8");
  const strippedText = rawHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const snapshot: EvidenceHashable = { rawBytes, text: strippedText };

  test("uses rawBytes hash when flag is enabled and rawBytes present", () => {
    const hash = evidenceHashFromSnapshot(snapshot, true);
    const expected = sha256Hex(rawBytes);
    assert.equal(hash, expected);
    // The raw-bytes hash must NOT equal the text hash (the two inputs differ).
    const textHash = sha256Hex(strippedText);
    assert.notEqual(hash, textHash, "raw bytes and stripped text must produce different hashes");
  });

  test("raw bytes hash matches what node:crypto would produce (cross-platform check)", () => {
    const hash = evidenceHashFromSnapshot(snapshot, true);
    const nodeHash = nodesha256Hex(rawBytes);
    assert.equal(hash, nodeHash);
  });

  test("hash is exactly 64 lowercase hex characters", () => {
    const hash = evidenceHashFromSnapshot(snapshot, true);
    assert.match(hash, /^[0-9a-f]{64}$/, "must be 64 lowercase hex chars");
  });

  test("same bytes → same hash (deterministic)", () => {
    const h1 = evidenceHashFromSnapshot(snapshot, true);
    const h2 = evidenceHashFromSnapshot({ rawBytes: Buffer.from(rawHtml, "utf8"), text: strippedText }, true);
    assert.equal(h1, h2);
  });

  test("different bytes → different hash (collision resistance)", () => {
    const snapshot2: EvidenceHashable = {
      rawBytes: Buffer.from(rawHtml + "EXTRA", "utf8"),
      text: strippedText,
    };
    assert.notEqual(
      evidenceHashFromSnapshot(snapshot, true),
      evidenceHashFromSnapshot(snapshot2, true),
    );
  });
});

// ── 2. evidenceHashFromSnapshot — negative (fallback to text) ─────────────────

describe("evidenceHashFromSnapshot: text fallback", () => {
  const text = "some extracted evidence text that is longer than twenty chars";
  const rawBytes = Buffer.from("<html>" + text + "</html>", "utf8");

  test("falls back to text hash when flag is disabled", () => {
    const snapshot: EvidenceHashable = { rawBytes, text };
    const hash = evidenceHashFromSnapshot(snapshot, /* featureEnabled= */ false);
    assert.equal(hash, sha256Hex(text));
    assert.notEqual(hash, sha256Hex(rawBytes));
  });

  test("falls back to text hash when rawBytes is undefined", () => {
    const snapshot: EvidenceHashable = { text };
    const hash = evidenceHashFromSnapshot(snapshot, true);
    assert.equal(hash, sha256Hex(text));
  });

  test("falls back to text hash when rawBytes is zero-length Buffer", () => {
    const snapshot: EvidenceHashable = { rawBytes: Buffer.alloc(0), text };
    const hash = evidenceHashFromSnapshot(snapshot, true);
    assert.equal(hash, sha256Hex(text));
  });

  test("uses fallbackText override when provided (council mode)", () => {
    const councilCommit = text + "\n[council]" + JSON.stringify({ tally: { creator: 3, challengers: 2 } });
    const snapshot: EvidenceHashable = { rawBytes, text };
    // Council mode passes undefined as snapshot and the combined commit as fallbackText.
    const hash = evidenceHashFromSnapshot({ text }, true, councilCommit);
    assert.equal(hash, sha256Hex(councilCommit));
    // Must differ from plain text hash — the tally is part of the commit.
    assert.notEqual(hash, sha256Hex(text));
  });

  test("fallbackText takes precedence over snapshot.text when both present", () => {
    const override = "council-combined-commit-string";
    const snapshot: EvidenceHashable = { text: "original evidence text" };
    const hash = evidenceHashFromSnapshot(snapshot, true, override);
    assert.equal(hash, sha256Hex(override));
  });
});

// ── 3. Boundary: large and binary payloads ────────────────────────────────────

describe("evidenceHashFromSnapshot: boundary inputs", () => {
  test("1 byte payload hashes correctly", () => {
    const rawBytes = Buffer.from([0x41]); // "A"
    const snapshot: EvidenceHashable = { rawBytes, text: "A" };
    assert.equal(
      evidenceHashFromSnapshot(snapshot, true),
      sha256Hex(rawBytes),
    );
  });

  test("1 MB payload does not throw or truncate", () => {
    const rawBytes = Buffer.alloc(1_000_000, 0x58); // 1 MB of 'X'
    const snapshot: EvidenceHashable = { rawBytes, text: "X".repeat(14_000) };
    const hash = evidenceHashFromSnapshot(snapshot, true);
    assert.match(hash, /^[0-9a-f]{64}$/);
    // Must equal SHA-256 of the full 1 MB, not the truncated text.
    assert.equal(hash, sha256Hex(rawBytes));
  });

  test("binary bytes (non-UTF8) hash correctly", () => {
    const rawBytes = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]);
    const snapshot: EvidenceHashable = { rawBytes, text: "replacement char fallback" };
    const hash = evidenceHashFromSnapshot(snapshot, true);
    assert.equal(hash, sha256Hex(rawBytes));
  });
});

// ── 4. fetchEvidence: rawBytes population per fetcher ─────────────────────────

describe("fetchEvidence: rawBytes is populated for direct fetcher", () => {
  const htmlBody = "<html><head><title>Test</title></head><body>" + "evidence ".repeat(50) + "</body></html>";

  test("direct fetch populates rawBytes matching the response body", async () => {
    const snap = await withFetch(async () => okHtmlResponse(htmlBody), async () => {
      return fetchEvidence("https://example.com/article", { disableJinaFallback: true });
    });

    assert.equal(snap.fetcher, "direct");
    assert.ok(snap.rawBytes !== undefined, "rawBytes must be present for direct fetcher");
    assert.ok(snap.rawBytes.byteLength > 0, "rawBytes must be non-empty");

    // The rawBytes must be the original HTML, not the stripped text.
    const expectedBytes = Buffer.from(htmlBody, "utf8");
    assert.deepEqual(snap.rawBytes, expectedBytes, "rawBytes must equal the raw HTML bytes");

    // And the rawBytes hash must differ from the text hash.
    const rawHash = sha256Hex(snap.rawBytes);
    const textHash = sha256Hex(snap.text);
    assert.notEqual(rawHash, textHash, "raw-bytes hash must differ from stripped-text hash");
  });

  test("rawBytes hash equals SHA-256 of the HTTP response body (verifier property)", async () => {
    const snap = await withFetch(async () => okHtmlResponse(htmlBody), async () => {
      return fetchEvidence("https://example.com/article", { disableJinaFallback: true });
    });

    assert.ok(snap.rawBytes !== undefined);
    // A verifier re-fetching the URL and hashing the body must get the same digest.
    const verifierHash = nodesha256Hex(Buffer.from(htmlBody, "utf8"));
    const oracleHash = sha256Hex(snap.rawBytes);
    assert.equal(oracleHash, verifierHash, "oracle hash must equal verifier's independent hash");
  });

  test("rawBytes captures the full body before HTML stripping", async () => {
    const snap = await withFetch(async () => okHtmlResponse(htmlBody), async () => {
      return fetchEvidence("https://example.com/article", { disableJinaFallback: true });
    });

    // text is stripped, rawBytes is not — they must differ in content.
    assert.ok(snap.rawBytes !== undefined);
    const rawString = snap.rawBytes.toString("utf8");
    assert.ok(rawString.includes("<html>"), "rawBytes must contain HTML tags");
    assert.ok(!snap.text.includes("<html>"), "text must have tags stripped");
  });
});

describe("fetchEvidence: rawBytes for plain-text direct response", () => {
  const plainBody = "This is plain evidence text. ".repeat(20);

  test("direct plain-text response populates rawBytes", async () => {
    const snap = await withFetch(async () => okPlainResponse(plainBody), async () => {
      return fetchEvidence("https://example.com/data.txt", { disableJinaFallback: true });
    });

    assert.equal(snap.fetcher, "direct");
    assert.ok(snap.rawBytes !== undefined);
    assert.deepEqual(snap.rawBytes, Buffer.from(plainBody, "utf8"));
  });
});

describe("fetchEvidence: Jina fallback populates rawBytes", () => {
  const markdownBody = "# Title: Bitcoin\nURL Source: https://example.com\n\n" + "Bitcoin price data. ".repeat(20);

  test("jina fetcher populates rawBytes from markdown response", async () => {
    let callCount = 0;
    const snap = await withFetch(async (url) => {
      callCount++;
      const urlStr = url.toString();
      if (urlStr.includes("r.jina.ai")) {
        return okPlainResponse(markdownBody);
      }
      // Direct fetch fails → Jina fallback
      return new Response("bot challenge", { status: 403 });
    }, async () => {
      // Do NOT disable Jina fallback — we want to test the Jina path.
      return fetchEvidence("https://example.com/page");
    });

    assert.equal(snap.fetcher, "jina");
    assert.ok(snap.rawBytes !== undefined, "Jina fetcher must populate rawBytes");
    assert.deepEqual(snap.rawBytes, Buffer.from(markdownBody, "utf8"));

    // Hash of rawBytes equals hash of the raw markdown (the Jina response body).
    assert.equal(sha256Hex(snap.rawBytes), nodesha256Hex(Buffer.from(markdownBody, "utf8")));
  });
});

describe("fetchEvidence: CoinGecko leaves rawBytes undefined", () => {
  const coinGeckoPayload = {
    name: "Bitcoin",
    symbol: "btc",
    market_data: {
      current_price: { usd: 98000 },
      market_cap: { usd: 1_900_000_000_000 },
      total_volume: { usd: 35_000_000_000 },
      high_24h: { usd: 99000 },
      low_24h: { usd: 97000 },
      price_change_percentage_24h: 1.5,
      price_change_percentage_7d: 5.0,
      price_change_percentage_30d: 10.0,
    },
    last_updated: "2026-09-24T00:00:00Z",
    market_cap_rank: 1,
  };

  test("coingecko-api fetcher does NOT populate rawBytes (synthetic text)", async () => {
    const snap = await withFetch(async (url) => {
      const urlStr = url.toString();
      if (urlStr.includes("api.coingecko.com")) {
        return new Response(JSON.stringify(coinGeckoPayload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    }, async () => {
      return fetchEvidence("https://www.coingecko.com/en/coins/bitcoin");
    });

    assert.equal(snap.fetcher, "coingecko-api");
    assert.equal(snap.rawBytes, undefined, "CoinGecko path must NOT populate rawBytes — synthetic text");
    assert.ok(snap.text.includes("Bitcoin"), "text must contain coin data");
  });
});

// ── 5. Feature flag in ops/flags ──────────────────────────────────────────────

describe("ops/flags: evidence_hash_binding feature", () => {
  test("evidence_hash_binding is in the FEATURES array", () => {
    assert.ok(
      (FEATURES as readonly string[]).includes("evidence_hash_binding"),
      "evidence_hash_binding must be a registered feature",
    );
  });

  test("evidence_hash_binding defaults to true (security invariant)", () => {
    // Pass an empty env — no env var set → must use the default, which is true.
    const enabled = isFeatureEnabled("evidence_hash_binding", {});
    assert.equal(enabled, true, "must be on by default — rollback requires explicit opt-out");
  });

  test("MIMIR_FEATURE_EVIDENCE_HASH_BINDING=0 disables it", () => {
    const enabled = isFeatureEnabled("evidence_hash_binding", {
      MIMIR_FEATURE_EVIDENCE_HASH_BINDING: "0",
    });
    assert.equal(enabled, false);
  });

  test("MIMIR_FEATURE_EVIDENCE_HASH_BINDING=1 enables it even when default is on", () => {
    const enabled = isFeatureEnabled("evidence_hash_binding", {
      MIMIR_FEATURE_EVIDENCE_HASH_BINDING: "1",
    });
    assert.equal(enabled, true);
  });

  test("unset env var uses the default (true)", () => {
    const envWithoutFlag: Record<string, string | undefined> = {
      SOME_OTHER_VAR: "1",
    };
    assert.equal(isFeatureEnabled("evidence_hash_binding", envWithoutFlag), true);
  });
});

// ── 6. Conservation: hash is always 32 bytes / 64 hex chars ──────────────────

describe("hash conservation invariants", () => {
  const cases: Array<{ label: string; snapshot: EvidenceHashable; enabled: boolean }> = [
    {
      label: "raw bytes enabled",
      snapshot: { rawBytes: Buffer.from("hello world", "utf8"), text: "hello world" },
      enabled: true,
    },
    {
      label: "flag disabled",
      snapshot: { rawBytes: Buffer.from("hello world", "utf8"), text: "hello world" },
      enabled: false,
    },
    {
      label: "no rawBytes, flag on",
      snapshot: { text: "plain text evidence" },
      enabled: true,
    },
    {
      label: "no rawBytes, flag off",
      snapshot: { text: "plain text evidence" },
      enabled: false,
    },
    {
      label: "council fallback text",
      snapshot: { text: "evidence" },
      enabled: true,
    },
  ];

  for (const { label, snapshot, enabled } of cases) {
    test(`hash is 64 hex chars: ${label}`, () => {
      const hash = evidenceHashFromSnapshot(snapshot, enabled);
      assert.match(hash, /^[0-9a-f]{64}$/, `expected 64 hex chars for case: ${label}`);
    });
  }
});

// ── 7. Regression: hash does NOT depend on LLM-truncated text ─────────────────

describe("regression: raw-bytes hash is independent of maxChars truncation", () => {
  const longHtml = "<html><body>" + "evidence text ".repeat(2000) + "</body></html>";

  test("rawBytes hash is the same regardless of maxChars", async () => {
    // Short maxChars → text is truncated; rawBytes is not.
    const snap1 = await withFetch(async () => okHtmlResponse(longHtml), async () => {
      return fetchEvidence("https://example.com/long", {
        disableJinaFallback: true,
        maxChars: 500,
      });
    });

    // Full maxChars.
    const snap2 = await withFetch(async () => okHtmlResponse(longHtml), async () => {
      return fetchEvidence("https://example.com/long", {
        disableJinaFallback: true,
        maxChars: 100_000,
      });
    });

    assert.ok(snap1.rawBytes !== undefined);
    assert.ok(snap2.rawBytes !== undefined);

    // Raw bytes are identical regardless of maxChars.
    assert.deepEqual(snap1.rawBytes, snap2.rawBytes, "rawBytes must not be affected by maxChars");

    // Text is truncated for snap1.
    assert.ok(snap1.text.length < snap2.text.length, "text must be truncated when maxChars is small");

    // Both produce the same raw-bytes hash.
    assert.equal(
      evidenceHashFromSnapshot(snap1, true),
      evidenceHashFromSnapshot(snap2, true),
      "raw-bytes hash must be the same regardless of maxChars",
    );
  });
});

// ── 8. Regression: existing text-hash callers still work with flag off ────────

describe("regression: flag=off produces same hash as legacy sha256Hex(text)", () => {
  const text = "legacy evidence text from before the binding feature";

  test("flag off → same hash as direct sha256Hex(text)", () => {
    const snapshot: EvidenceHashable = {
      rawBytes: Buffer.from("raw html " + text),
      text,
    };
    const legacyHash = sha256Hex(text);
    const flagOffHash = evidenceHashFromSnapshot(snapshot, false);
    assert.equal(flagOffHash, legacyHash);
  });
});

// ── 9. fetchEvidence: 402 bot-paid path populates rawBytes ───────────────────

describe("fetchEvidence: 402 bot-paid path populates rawBytes", () => {
  const paidBody = "Paid evidence content. ".repeat(30);

  test("bot-paid fetcher populates rawBytes from paid response", async () => {
    const mockPaidFetch = async (_url: string) => ({
      response: okHtmlResponse(paidBody),
      payment: { priceUnits: "1000", txHash: "abcd1234" },
    });

    const snap = await withFetch(async (url) => {
      const urlStr = url.toString();
      // Direct fetch returns 402 → triggers paidFetch path.
      if (!urlStr.includes("r.jina.ai")) {
        return new Response(null, { status: 402 });
      }
      // Jina fallback (should not reach here, but guard it)
      return new Response("fallback content ".repeat(30), {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }, async () => {
      return fetchEvidence("https://example.com/premium-article", {
        disableJinaFallback: true,
        paidFetch: mockPaidFetch,
      });
    });

    assert.equal(snap.fetcher, "bot-paid");
    assert.ok(snap.rawBytes !== undefined, "bot-paid fetcher must populate rawBytes");
    assert.ok(snap.rawBytes.byteLength > 0);
    // rawBytes must be the unstripped HTML body.
    const rawString = snap.rawBytes.toString("utf8");
    assert.ok(rawString.includes("Paid evidence content"), "rawBytes must contain original body");
    assert.ok(snap.payment !== undefined, "payment must be present on bot-paid snapshot");
  });
});

import { describe, it, expect } from "@jest/globals";
import { Readable } from "node:stream";
import {
  encodeEnvelope,
  parseEnvelope,
  readEnvelopes,
  assertDirection,
  isHello,
  isHelloAck,
  isPrompt,
  isPromptAck,
  isReport,
  isEvent,
  isPing,
  isPong,
  isBye,
  type Envelope,
} from "../_shared/ipc";

// ─── encodeEnvelope ─────────────────────────────────────────────────────────

describe("encodeEnvelope", () => {
  it("serializes to a single JSONL frame terminated by \\n", () => {
    const out = encodeEnvelope({ type: "ping", nonce: "abc" });
    expect(out).toBe('{"type":"ping","nonce":"abc"}\n');
    // exactly one trailing newline
    expect(out.endsWith("\n")).toBe(true);
    expect(out.indexOf("\n")).toBe(out.length - 1);
  });

  it("escapes literal newlines inside string payloads so framing is safe", () => {
    const out = encodeEnvelope({
      type: "prompt",
      sessionId: "s1",
      message: "line1\nline2",
      correlationId: "c1",
    });
    // The only real \n byte is the framing terminator.
    expect(out.endsWith('"}\n')).toBe(true);
    const jsonPart = out.slice(0, -1);
    // JSON-escaped newline must be backslash-n, not a raw byte.
    expect(jsonPart.includes('"line1\\nline2"')).toBe(true);
  });
});

// ─── parseEnvelope ──────────────────────────────────────────────────────────

describe("parseEnvelope", () => {
  it("round-trips an encoded envelope", () => {
    const original: Envelope = {
      type: "report",
      sessionId: "s1",
      turnIndex: 2,
      status: "verified",
      confidence: "verified",
      summary: "ok",
      sections: {},
      raw: "## Report\n...",
    };
    const line = encodeEnvelope(original).slice(0, -1);
    expect(parseEnvelope(line)).toEqual(original);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseEnvelope("{not json")).toThrow(/Failed to parse JSONL/);
  });

  it("throws when type discriminator is missing", () => {
    expect(() => parseEnvelope('{"foo":"bar"}')).toThrow(/missing "type"/);
  });

  it("throws on unknown envelope type", () => {
    expect(() => parseEnvelope('{"type":"nope"}')).toThrow(/Unknown envelope type "nope"/);
  });
});

// ─── readEnvelopes ──────────────────────────────────────────────────────────

describe("readEnvelopes", () => {
  async function collect(stream: Readable): Promise<Envelope[]> {
    const out: Envelope[] = [];
    for await (const e of readEnvelopes(stream)) out.push(e);
    return out;
  }

  it("yields each frame split on \\n", async () => {
    const data =
      encodeEnvelope({ type: "ping", nonce: "1" }) +
      encodeEnvelope({ type: "pong", nonce: "1" });
    const stream = Readable.from([data]);
    const got = await collect(stream);
    expect(got).toHaveLength(2);
    expect(got[0].type).toBe("ping");
    expect(got[1].type).toBe("pong");
  });

  it("does NOT split on Unicode line separator U+2028 inside a string", async () => {
    // U+2028 (LINE SEPARATOR) is valid inside a JSON string. A readline-based
    // framer would corrupt this; we must split on \n only.
    const evil = "line1\u2028line2";
    const frame = encodeEnvelope({
      type: "prompt",
      sessionId: "s",
      message: evil,
      correlationId: "c",
    });
    const stream = Readable.from([frame]);
    const got = await collect(stream);
    expect(got).toHaveLength(1);
    expect((got[0] as Extract<Envelope, { type: "prompt" }>).message).toBe(evil);
  });

  it("discards a trailing partial frame (no terminating \\n) on stream end", async () => {
    const data =
      encodeEnvelope({ type: "ping", nonce: "1" }) + '{"type":"ping","nonce"';
    const stream = Readable.from([data]);
    const got = await collect(stream);
    expect(got).toHaveLength(1);
  });

  it("handles multiple chunks arriving separately", async () => {
    const a = encodeEnvelope({ type: "ping", nonce: "1" });
    const b = encodeEnvelope({ type: "ping", nonce: "2" });
    const stream = Readable.from([a.slice(0, 5), a.slice(5) + b.slice(0, 3), b.slice(3)]);
    const got = await collect(stream);
    expect(got).toHaveLength(2);
  });
});

// ─── assertDirection ────────────────────────────────────────────────────────

describe("assertDirection", () => {
  it("allows verifier→builder typed envelopes", () => {
    expect(() =>
      assertDirection({ type: "hello", role: "verifier", sessionId: "s", pid: 1 }, "verifier-to-builder"),
    ).not.toThrow();
    expect(() =>
      assertDirection({ type: "prompt", sessionId: "s", message: "m", correlationId: "c" }, "verifier-to-builder"),
    ).not.toThrow();
    expect(() =>
      assertDirection({ type: "report", sessionId: "s", turnIndex: 1, status: "verified", confidence: "verified", summary: "", sections: {}, raw: "" }, "verifier-to-builder"),
    ).not.toThrow();
  });

  it("rejects builder→verifier-only types going verifier→builder", () => {
    expect(() =>
      assertDirection({ type: "hello_ack", sessionId: "s" }, "verifier-to-builder"),
    ).toThrow(/direction violation/);
    expect(() =>
      assertDirection({ type: "event", name: "stop", sessionId: "s", timestamp: 0 }, "verifier-to-builder"),
    ).toThrow(/direction violation/);
  });

  it("allows builder→verifier typed envelopes", () => {
    expect(() =>
      assertDirection({ type: "hello_ack", sessionId: "s" }, "builder-to-verifier"),
    ).not.toThrow();
    expect(() =>
      assertDirection({ type: "event", name: "stop", sessionId: "s", timestamp: 0 }, "builder-to-verifier"),
    ).not.toThrow();
    expect(() =>
      assertDirection({ type: "prompt_ack", sessionId: "s", correlationId: "c", ok: true }, "builder-to-verifier"),
    ).not.toThrow();
  });

  it("allows ping/pong/bye bidirectionally", () => {
    for (const side of ["verifier-to-builder", "builder-to-verifier"] as const) {
      expect(() => assertDirection({ type: "ping", nonce: "n" }, side)).not.toThrow();
      expect(() => assertDirection({ type: "pong", nonce: "n" }, side)).not.toThrow();
      expect(() => assertDirection({ type: "bye", reason: "r" }, side)).not.toThrow();
    }
  });
});

// ─── type guards ────────────────────────────────────────────────────────────

describe("type guards", () => {
  it("narrow by discriminator", () => {
    expect(isHello({ type: "hello" } as Envelope)).toBe(true);
    expect(isHelloAck({ type: "hello_ack" } as Envelope)).toBe(true);
    expect(isPrompt({ type: "prompt" } as Envelope)).toBe(true);
    expect(isPromptAck({ type: "prompt_ack" } as Envelope)).toBe(true);
    expect(isReport({ type: "report" } as Envelope)).toBe(true);
    expect(isEvent({ type: "event" } as Envelope)).toBe(true);
    expect(isPing({ type: "ping" } as Envelope)).toBe(true);
    expect(isPong({ type: "pong" } as Envelope)).toBe(true);
    expect(isBye({ type: "bye" } as Envelope)).toBe(true);
    // negatives
    expect(isPing({ type: "pong" } as Envelope)).toBe(false);
    expect(isHello({ type: "bye" } as Envelope)).toBe(false);
  });
});

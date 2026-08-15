import { describe, expect, it } from "vitest";

import {
  FrameDecoder,
  FrameProtocolError,
  MAX_FRAME_BYTES,
  encodeFrame,
} from "../../src/transport/frame-codec";

describe("length-prefixed JSON frames", () => {
  it("decodes fragmented and coalesced socket chunks", () => {
    const first = encodeFrame({ type: "first", text: "grammar ✨" });
    const second = encodeFrame({ type: "second", count: 2 });
    const bytes = Buffer.concat([first, second]);
    const decoder = new FrameDecoder();

    expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(2, first.length + 3))).toEqual([
      { type: "first", text: "grammar ✨" },
    ]);
    expect(decoder.push(bytes.subarray(first.length + 3))).toEqual([
      { type: "second", count: 2 },
    ]);
  });

  it("encodes a valid JSON body larger than four MiB within the protocol limit", () => {
    const frame = encodeFrame({ text: "\u0001".repeat(700_000) });

    expect(frame.readUInt32BE(0)).toBeGreaterThan(4 * 1024 * 1024);
    expect(frame.readUInt32BE(0)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it("rejects a declared frame larger than eight MiB before buffering its body", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1);
    const decoder = new FrameDecoder();

    expect(() => decoder.push(header)).toThrow(FrameProtocolError);
  });

  it("rejects malformed JSON without accepting a following frame", () => {
    const invalidBody = Buffer.from("{", "utf8");
    const invalid = Buffer.alloc(4 + invalidBody.length);
    invalid.writeUInt32BE(invalidBody.length);
    invalidBody.copy(invalid, 4);
    const decoder = new FrameDecoder();

    expect(() => decoder.push(Buffer.concat([invalid, encodeFrame({ type: "ignored" })]))).toThrow(
      FrameProtocolError,
    );
  });

  it("rejects JSON containing invalid UTF-8", () => {
    const body = Buffer.from([0x22, 0xc3, 0x28, 0x22]);
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length);
    body.copy(frame, 4);

    expect(() => new FrameDecoder().push(frame)).toThrow(FrameProtocolError);
  });
});

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

  it("rejects an outbound frame whose JSON root is not an object", () => {
    expect(() => encodeFrame([])).toThrow(FrameProtocolError);
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

  it("preserves complete preceding frames when a coalesced later frame is invalid", () => {
    const valid = encodeFrame({ type: "welcome" });
    const invalid = rawFrame('{"type":"event","type":"event"}');

    try {
      new FrameDecoder().push(Buffer.concat([valid, invalid]));
      expect.unreachable("expected a frame protocol error");
    } catch (error) {
      expect(error).toBeInstanceOf(FrameProtocolError);
      expect((error as FrameProtocolError).decodedFrames).toEqual([
        { type: "welcome" },
      ]);
    }
  });

  it("rejects JSON containing invalid UTF-8", () => {
    const body = Buffer.from([0x22, 0xc3, 0x28, 0x22]);
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length);
    body.copy(frame, 4);

    expect(() => new FrameDecoder().push(frame)).toThrow(FrameProtocolError);
  });

  it("rejects duplicate object members at any depth", () => {
    const frame = rawFrame('{"type":"welcome","limits":{"maxSources":2,"maxSources":2}}');

    expect(() => new FrameDecoder().push(frame)).toThrow(FrameProtocolError);
  });

  it.each([
    '{"value":null}',
    '{"unknown":{"future":null}}',
    '{"unknown":[1,null]}',
  ])("rejects JSON null before semantic member handling: %s", (json) => {
    expect(() => new FrameDecoder().push(rawFrame(json))).toThrow(
      FrameProtocolError,
    );
  });

  it("rejects outbound JSON containing null", () => {
    expect(() => encodeFrame({ unknown: null })).toThrow(FrameProtocolError);
  });

  it.each([
    '{"unknown":-1}',
    '{"unknown":1.5}',
    '{"unknown":1e0}',
    '{"unknown":9007199254740992}',
  ])("rejects nonportable numeric tokens under unknown members: %s", (json) => {
    expect(() => new FrameDecoder().push(rawFrame(json))).toThrow(
      FrameProtocolError,
    );
  });

  it("rejects a non-object JSON root", () => {
    expect(() => new FrameDecoder().push(rawFrame("[]"))).toThrow(FrameProtocolError);
  });

  it("rejects an unpaired surrogate escape", () => {
    const frame = rawFrame('{"value":"\\uD800"}');

    expect(() => new FrameDecoder().push(frame)).toThrow(FrameProtocolError);
  });

  it("rejects an outbound string containing an unpaired surrogate", () => {
    expect(() => encodeFrame({ value: "\uD800" })).toThrow(FrameProtocolError);
  });

  it("decodes a paired surrogate escape as one Unicode scalar", () => {
    const frame = rawFrame('{"value":"\\uD83D\\uDE80"}');

    expect(new FrameDecoder().push(frame)).toEqual([{ value: "🚀" }]);
  });
});

function rawFrame(json: string): Buffer {
  const body = Buffer.from(json, "utf8");
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(body.length);
  body.copy(frame, 4);
  return frame;
}

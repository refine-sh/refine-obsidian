import { EngineConnectionError } from "./engine-connection-error";
import { parseJSONObject } from "./strict-json";

export const MAX_FRAME_BYTES = 8_388_608 as const;
const HEADER_BYTES = 4;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class FrameProtocolError extends EngineConnectionError {
  constructor(
    message: string,
    options?: ErrorOptions,
    readonly decodedFrames: readonly unknown[] = [],
  ) {
    super(message, "fatal", options);
    this.name = "FrameProtocolError";
  }
}

export function encodeFrame(value: unknown): Buffer {
  let body: Buffer;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) {
      throw new TypeError("JSON serialization returned no value");
    }
    parseJSONObject(json);
    body = Buffer.from(json, "utf8");
  } catch (error) {
    throw new FrameProtocolError("Frame value is not JSON serializable", { cause: error });
  }
  if (body[0] !== 0x7b) {
    throw new FrameProtocolError("Frame JSON root must be an object");
  }
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new FrameProtocolError(`Frame body must be between 1 and ${MAX_FRAME_BYTES} bytes`);
  }

  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  private buffered = Buffer.alloc(0);
  private failed = false;

  push(chunk: Uint8Array): unknown[] {
    if (this.failed) {
      throw new FrameProtocolError("Frame decoder cannot continue after a protocol error");
    }
    if (chunk.byteLength === 0) {
      return [];
    }

    this.buffered = Buffer.concat([
      this.buffered,
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    ]);
    const decoded: unknown[] = [];
    try {
      while (this.buffered.length >= HEADER_BYTES) {
        const length = this.buffered.readUInt32BE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) {
          throw new FrameProtocolError(
            `Declared frame length must be between 1 and ${MAX_FRAME_BYTES} bytes`,
          );
        }
        if (this.buffered.length < HEADER_BYTES + length) {
          break;
        }

        const body = this.buffered.subarray(HEADER_BYTES, HEADER_BYTES + length);
        let value: unknown;
        try {
          value = parseJSONObject(utf8Decoder.decode(body));
        } catch (error) {
          throw new FrameProtocolError("Frame body is not valid JSON", { cause: error });
        }
        decoded.push(value);
        this.buffered = this.buffered.subarray(HEADER_BYTES + length);
      }
      return decoded;
    } catch (error) {
      this.failed = true;
      this.buffered = Buffer.alloc(0);
      if (decoded.length > 0) {
        throw new FrameProtocolError(
          error instanceof Error ? error.message : "Invalid frame",
          { cause: error },
          decoded,
        );
      }
      throw error;
    }
  }

  finish(): void {
    if (this.buffered.length !== 0) {
      this.failed = true;
      this.buffered = Buffer.alloc(0);
      throw new FrameProtocolError("Socket ended in the middle of a frame");
    }
  }
}

import { createConnection, type Socket } from "node:net";

import { AsyncQueue } from "../shared/async-queue";
import { EngineConnectionError } from "./engine-connection-error";
import { FrameDecoder, FrameProtocolError, encodeFrame } from "./frame-codec";
import type { FrameConnection, FrameConnector } from "./refine-transport";

export class UnixFrameConnector implements FrameConnector {
  connect(path: string, signal: AbortSignal): Promise<FrameConnection> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }

    return new Promise<FrameConnection>((resolve, reject) => {
      const socket = createConnection({ path });
      const connection = new UnixFrameConnection(socket);
      const abort = (): void => {
        socket.destroy(signal.reason instanceof Error ? signal.reason : undefined);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const error = (cause: Error): void => {
        signal.removeEventListener("abort", abort);
        reject(new EngineConnectionError(
          "Unable to connect to the Refine socket",
          "recoverable",
          { cause },
        ));
      };
      signal.addEventListener("abort", abort, { once: true });
      socket.once("error", error);
      socket.once("connect", () => {
        socket.off("error", error);
        signal.removeEventListener("abort", abort);
        resolve(connection);
      });
      if (signal.aborted) {
        abort();
      }
    });
  }
}

class UnixFrameConnection implements FrameConnection {
  private readonly decoder = new FrameDecoder();
  private readonly frames = new AsyncQueue<unknown>(128);
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      try {
        for (const frame of this.decoder.push(chunk)) {
          this.frames.push(frame);
        }
      } catch (error) {
        if (error instanceof FrameProtocolError) {
          for (const frame of error.decodedFrames) {
            this.frames.push(frame);
          }
        }
        this.frames.fail(error);
        socket.destroy(error instanceof Error ? error : undefined);
      }
    });
    socket.on("end", () => {
      try {
        this.decoder.finish();
        this.frames.close();
      } catch (error) {
        this.frames.fail(error);
      }
    });
    socket.on("error", (error) => this.frames.fail(error));
    socket.on("close", () => this.frames.close());
  }

  send(value: unknown): Promise<void> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new Error("Refine socket is closed"));
    }
    const frame = encodeFrame(value);
    return new Promise<void>((resolve, reject) => {
      this.socket.write(frame, (error?: Error | null) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  async *receive(signal: AbortSignal): AsyncIterable<unknown> {
    if (signal.aborted) {
      return;
    }

    let stop: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const abort = (): void => stop?.();
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (!signal.aborted) {
        const next = await Promise.race([
          this.frames.next().then((result) => ({ type: "frame" as const, result })),
          aborted.then(() => ({ type: "aborted" as const })),
        ]);
        if (signal.aborted || next.type === "aborted" || next.result.done) {
          return;
        }
        yield next.result.value;
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.socket.destroy();
      this.frames.close();
    }
    return Promise.resolve();
  }
}

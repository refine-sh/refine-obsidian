import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { EngineConnectionError } from "../../src/transport/engine-connection-error";
import { FrameDecoder, encodeFrame } from "../../src/transport/frame-codec";
import { UnixFrameConnector } from "../../src/transport/unix-frame-connection";

describe("UnixFrameConnector", () => {
  it("classifies an unavailable socket as a recoverable connection failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "refine-obsidian-test-"));
    const socketPath = join(directory, "missing.sock");
    try {
      const error = await new UnixFrameConnector()
        .connect(socketPath, new AbortController().signal)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(EngineConnectionError);
      expect(error).toMatchObject({
        message: "Unable to connect to the Refine socket",
        recoverability: "recoverable",
      });
      expect(error).toHaveProperty("cause");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exchanges framed JSON over an AF_UNIX stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "refine-obsidian-test-"));
    const socketPath = join(directory, "integration.sock");
    const server = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        for (const message of decoder.push(chunk)) {
          socket.write(encodeFrame({ type: "reply", received: message }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const controller = new AbortController();
    const connection = await new UnixFrameConnector().connect(socketPath, controller.signal);
    const replies = connection.receive(controller.signal)[Symbol.asyncIterator]();
    try {
      await connection.send({ type: "hello", text: "Refine ✨" });
      await expect(replies.next()).resolves.toEqual({
        done: false,
        value: {
          type: "reply",
          received: { type: "hello", text: "Refine ✨" },
        },
      });
    } finally {
      controller.abort();
      await connection.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the socket writable after event reception is aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "refine-obsidian-test-"));
    const socketPath = join(directory, "integration.sock");
    const received: unknown[] = [];
    const server = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        received.push(...decoder.push(chunk));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const connectionController = new AbortController();
    const receiveController = new AbortController();
    const connection = await new UnixFrameConnector().connect(
      socketPath,
      connectionController.signal,
    );
    const events = connection.receive(receiveController.signal)[Symbol.asyncIterator]();
    try {
      const waiting = events.next();
      receiveController.abort();
      await expect(waiting).resolves.toEqual({ done: true, value: undefined });

      await connection.send({ type: "closeDocument" });
      await vi.waitFor(() => expect(received).toEqual([{ type: "closeDocument" }]));
    } finally {
      await connection.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import { expect, vi } from "vitest";

import {
  DEFAULT_PRESENTATION_APPEARANCE,
  DEFAULT_PRESENTATION_INTERACTION,
  type UTF16Range,
} from "../../src/integration/types";
import { AsyncQueue } from "../../src/shared/async-queue";
import type {
  CommandReceipt,
  RefineTransportSession,
} from "../../src/transport/refine-transport";
import type {
  ClientCommand,
  ServerEventEnvelope,
} from "../../src/transport/wire";

export const TEST_ATTRIBUTION = {
  languageDisplayName: "English (American)",
  textDirection: "ltr" as const,
  checkModelDisplayName: "On-Device (Gemma)",
};

export interface RecordedCommand<T extends ClientCommand["type"]> {
  readonly command: Extract<ClientCommand, { readonly type: T }>;
  readonly id: string;
}

/**
 * In-memory engine transport double shared by the integration-level suites.
 * Only the engine's side of the wire is faked; tests drive the real
 * integration, host, and editor against it. Commands are recorded across the
 * engine's lifetime, and each `connect` after the first hands out a fresh
 * event stream so a test that restarts its integration run (for example
 * through the session manager) can keep emitting events to the new session.
 */
export class FakeEngine {
  readonly commands: { readonly command: ClientCommand; readonly id: string }[] =
    [];
  eventsRead = 0;
  closes = 0;
  private commandSequence = 0;
  private eventSequence = 0;
  private queue = new AsyncQueue<ServerEventEnvelope>();
  private queueConnected = false;
  private blockedSend:
    | {
        readonly type: ClientCommand["type"];
        readonly promise: Promise<void>;
        readonly release: () => void;
      }
    | undefined;

  /** The event stream the currently connected session reads from. */
  get eventQueue(): AsyncQueue<ServerEventEnvelope> {
    return this.queue;
  }

  /**
   * Holds the receipt of the next command of `type` until the returned
   * release function is called, so tests can pin the integration inside a
   * send and observe what queues up behind it.
   */
  blockNextSend(type: ClientCommand["type"]): () => void {
    let release: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocked = {
      type,
      promise,
      release: () => release?.(),
    };
    this.blockedSend = blocked;
    return blocked.release;
  }

  connect(): Promise<RefineTransportSession> {
    if (this.queueConnected) {
      this.queue = new AsyncQueue<ServerEventEnvelope>();
    }
    this.queueConnected = true;
    const queue = this.queue;
    return Promise.resolve({
      serverEpoch: "epoch-1",
      runResumed: false,
      activatedCapabilities: [],
      send: async (command, commandId): Promise<CommandReceipt> => {
        this.commandSequence += 1;
        const id = commandId ?? `command-${this.commandSequence}`;
        this.commands.push({ command, id });
        if (this.blockedSend?.type === command.type) {
          const blocked = this.blockedSend;
          this.blockedSend = undefined;
          await blocked.promise;
        }
        return { sequence: this.commandSequence, id };
      },
      events: () => this.readEvents(queue),
      close: async () => {
        this.closes += 1;
        queue.close();
      },
    });
  }

  emit(
    event: ServerEventEnvelope["event"],
    causeCommandId?: string,
  ): void {
    this.eventSequence += 1;
    this.queue.push({
      type: "event",
      sequence: this.eventSequence,
      epoch: "epoch-1",
      ...(causeCommandId === undefined ? {} : { causeCommandId }),
      event,
    });
  }

  commandsOfType<T extends ClientCommand["type"]>(
    type: T,
  ): readonly RecordedCommand<T>[] {
    return this.commands.filter(
      (recorded): recorded is RecordedCommand<T> =>
        recorded.command.type === type,
    );
  }

  /**
   * Waits until at least `count` commands of `type` have been recorded and
   * returns the `count`th one (the first by default).
   */
  async waitForCommand<T extends ClientCommand["type"]>(
    type: T,
    count = 1,
  ): Promise<RecordedCommand<T>> {
    await vi.waitFor(() =>
      expect(this.commandsOfType(type).length).toBeGreaterThanOrEqual(count),
    );
    const command = this.commandsOfType(type)[count - 1];
    if (!command) {
      throw new Error(`expected ${type} command`);
    }
    return command;
  }

  private async *readEvents(
    queue: AsyncQueue<ServerEventEnvelope>,
  ): AsyncIterable<ServerEventEnvelope> {
    for await (const event of queue) {
      this.eventsRead += 1;
      yield event;
    }
  }
}

export function suggestionPresentation(
  checkId: string,
  suggestionId: string,
  options: {
    readonly revision?: string;
    readonly activationRange?: UTF16Range;
  } = {},
): Extract<
  ServerEventEnvelope["event"],
  { readonly type: "presentationContentReplaced" }
> {
  const activationRange = options.activationRange ?? { location: 7, length: 2 };
  return {
    type: "presentationContentReplaced",
    checkId,
    content: {
      documentRevision: options.revision ?? "doc:0",
      status: "complete",
      coverage: "full",
      appearance: DEFAULT_PRESENTATION_APPEARANCE,
      interaction: DEFAULT_PRESENTATION_INTERACTION,
      suggestions: [
        {
          id: suggestionId,
          sourceId: "document",
          kind: "grammar",
          attribution: TEST_ATTRIBUTION,
          activationRange,
          highlightRanges: [activationRange],
          diff: [],
          availableActions: ["apply"],
        },
      ],
    },
  };
}

import { describe, expect, it, vi } from "vitest";
import { GoogleLiveSessionError } from "./errors";
import { GoogleLiveSession } from "./google-live-session";
import { decodePcm16Base64, encodePcm16Base64 } from "./protocol";
import type {
  GoogleLiveHistoryMessage,
  GoogleLiveSessionEvent,
  GoogleLiveToolAdapter,
  GoogleLiveWebSocket,
} from "./types";

class FakeWebSocket implements GoogleLiveWebSocket {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  failNextSend?: Error;

  send(data: string): void {
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = undefined;
      throw error;
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 2;
    this.closeCalls.push({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  error(error: unknown): void {
    this.onerror?.(error);
  }

  serverClose(code = 1006, reason = "", wasClean = false): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean });
  }
}

function createSocketFactory() {
  const urls: string[] = [];
  const sockets: FakeWebSocket[] = [];
  return {
    urls,
    sockets,
    factory(url: string) {
      urls.push(url);
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    },
  };
}

function createScheduler() {
  const pending: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  return {
    pending,
    schedule(callback: () => void, delayMs: number) {
      const task = { callback, delayMs, cancelled: false };
      pending.push(task);
      return task;
    },
    cancelScheduled(handle: unknown) {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    runNext() {
      const task = pending.shift();
      if (!task) throw new Error("No scheduled retry.");
      if (!task.cancelled) task.callback();
      return task.delayMs;
    },
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}

function parseSent(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
}

describe("GoogleLiveSession", () => {
  it("gates realtime input on setupComplete, seeds history, and sends typed text/audio/end messages", async () => {
    const transport = createSocketFactory();
    const events: GoogleLiveSessionEvent[] = [];
    const session = new GoogleLiveSession({
      apiKey: "user-key",
      activityHandling: "NO_INTERRUPTION",
      history: [
        { role: "user", text: "Earlier question" },
        { role: "assistant", text: "Earlier answer" },
      ],
      emit: (event) => events.push(event),
    }, { webSocketFactory: transport.factory });

    const connected = session.connect();
    session.sendText("current question");
    session.sendAudio(new Int16Array([-1, 0, 1]));
    const socket = transport.sockets[0]!;
    expect(socket.sent).toEqual([]);

    socket.open();
    expect(parseSent(socket)).toHaveLength(1);
    expect(parseSent(socket)[0]).toMatchObject({
      setup: {
        generationConfig: { responseModalities: ["AUDIO"] },
        realtimeInputConfig: { activityHandling: "NO_INTERRUPTION" },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        historyConfig: { initialHistoryInClientContent: true },
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: {},
      },
    });

    socket.receive({ setupComplete: {} });
    await connected;
    const sent = parseSent(socket);
    expect(sent[1]).toEqual({
      clientContent: {
        turns: [
          { role: "user", parts: [{ text: "Earlier question" }] },
          { role: "model", parts: [{ text: "Earlier answer" }] },
        ],
        turnComplete: true,
      },
    });
    expect(sent[2]).toEqual({ realtimeInput: { text: "current question" } });
    expect(sent[3]).toMatchObject({
      realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000" } },
    });
    const audioData = (sent[3]!.realtimeInput as {
      audio: { data: string };
    }).audio.data;
    expect([...decodePcm16Base64(audioData)]).toEqual([-1, 0, 1]);

    session.endAudio();
    expect(parseSent(socket).at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(events).toContainEqual({ type: "setup-complete", resumed: false });
    expect(events).toContainEqual({ type: "status", status: "ready" });
    session.dispose();
  });

  it("emits every model part, independent transcripts, usage, and turn lifecycle", async () => {
    const transport = createSocketFactory();
    const events: GoogleLiveSessionEvent[] = [];
    const session = new GoogleLiveSession({
      apiKey: "key",
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      emit: (event) => events.push(event),
    }, { webSocketFactory: transport.factory });
    const connected = session.connect();
    const socket = transport.sockets[0]!;
    socket.open();
    socket.receive({ setupComplete: {} });
    await connected;

    socket.receive({
      serverContent: {
        modelTurn: { parts: [
          { inlineData: {
            data: encodePcm16Base64(new Int16Array([100, -100])),
            mimeType: "audio/pcm;rate=24000",
          } },
          { text: "caption" },
          { text: "reasoning", thought: true },
        ] },
        interimInputTranscription: { text: "hel", languageCode: "en" },
        inputTranscription: { text: "hello", languageCode: "en" },
        outputTranscription: { text: "hi", languageCode: "en" },
        interrupted: true,
        turnComplete: true,
      },
      usageMetadata: { totalTokenCount: 9 },
    });
    await drainMicrotasks();

    const audioEvent = events.find(
      (event): event is Extract<GoogleLiveSessionEvent, { type: "audio" }> => event.type === "audio",
    );
    expect(audioEvent?.sampleRate).toBe(24_000);
    expect([...(audioEvent?.pcm16 ?? [])]).toEqual([100, -100]);
    expect(events).toContainEqual({ type: "text", text: "caption", thought: undefined });
    expect(events).toContainEqual({ type: "text", text: "reasoning", thought: true });
    expect(events).toContainEqual({
      type: "input-transcript",
      text: "hel",
      interim: true,
      languageCode: "en",
    });
    expect(events).toContainEqual({
      type: "input-transcript",
      text: "hello",
      interim: false,
      languageCode: "en",
    });
    expect(events).toContainEqual({ type: "output-transcript", text: "hi", languageCode: "en" });
    expect(events).toContainEqual({ type: "interrupted" });
    expect(events).toContainEqual({ type: "turn-complete" });
    expect(events).toContainEqual({ type: "usage", metadata: { totalTokenCount: 9 } });
    session.dispose();
  });

  it("executes tool calls once, returns matching IDs, and honors cancellation", async () => {
    const transport = createSocketFactory();
    const events: GoogleLiveSessionEvent[] = [];
    const resolvers = new Map<string, (output: unknown) => void>();
    const execute = vi.fn((_id: string, name: string) => new Promise<unknown>((resolve) => {
      resolvers.set(name, resolve);
    }));
    const cancel = vi.fn();
    const toolAdapter: GoogleLiveToolAdapter = {
      declarations: [{ name: "setState", parameters: { type: "object" } }],
      execute,
      cancel,
    };
    const session = new GoogleLiveSession({
      apiKey: "key",
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      toolAdapter,
      emit: (event) => events.push(event),
    }, { webSocketFactory: transport.factory });
    const connected = session.connect();
    const socket = transport.sockets[0]!;
    socket.open();
    expect(parseSent(socket)[0]).toMatchObject({
      setup: { tools: [{ functionDeclarations: [{ name: "setState" }] }] },
    });
    socket.receive({ setupComplete: {} });
    await connected;

    const firstCall = {
      toolCall: { functionCalls: [{ id: "call-1", name: "setState", args: { state: "happy" } }] },
    };
    socket.receive(firstCall);
    socket.receive(firstCall);
    await drainMicrotasks();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("call-1", "setState", { state: "happy" });
    resolvers.get("setState")?.({ ok: true });
    await drainMicrotasks();

    let responses = parseSent(socket).filter((message) => "toolResponse" in message);
    expect(responses).toEqual([{
      toolResponse: {
        functionResponses: [{
          id: "call-1",
          name: "setState",
          response: { ok: true },
        }],
      },
    }]);
    socket.receive(firstCall);
    await drainMicrotasks();
    responses = parseSent(socket).filter((message) => "toolResponse" in message);
    expect(responses).toHaveLength(1);

    socket.receive({
      toolCall: { functionCalls: [{ id: "call-2", name: "slowTool", args: {} }] },
    });
    await drainMicrotasks();
    socket.receive({ toolCallCancellation: { ids: ["call-2"] } });
    await drainMicrotasks();
    resolvers.get("slowTool")?.({ shouldNotBeSent: true });
    await drainMicrotasks();
    responses = parseSent(socket).filter((message) => "toolResponse" in message);
    expect(responses).toHaveLength(1);
    expect(cancel).toHaveBeenCalledWith("call-2");
    expect(events).toContainEqual({ type: "tool-cancelled", ids: ["call-2"] });
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "tool-result",
      id: "call-2",
    }));
    session.dispose();
  });

  it("reconnects on goAway with the latest handle and queues input until resumed setup", async () => {
    const transport = createSocketFactory();
    const scheduler = createScheduler();
    const events: GoogleLiveSessionEvent[] = [];
    const session = new GoogleLiveSession({
      apiKey: "key",
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      history: [{ role: "user", text: "seed" }],
      emit: (event) => events.push(event),
    }, {
      webSocketFactory: transport.factory,
      schedule: scheduler.schedule,
      cancelScheduled: scheduler.cancelScheduled,
    });
    const connected = session.connect();
    const first = transport.sockets[0]!;
    first.open();
    first.receive({ setupComplete: {} });
    await connected;
    first.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "handle-2" } });
    first.receive({ goAway: { timeLeft: "60s" } });
    await vi.waitFor(() => expect(scheduler.pending).toHaveLength(1));
    expect(scheduler.pending.map((task) => task.delayMs)).toEqual([500]);
    expect(events).toContainEqual({ type: "go-away", timeLeft: "60s" });

    session.sendText("during reconnect");
    expect(scheduler.runNext()).toBe(500);
    const resumed = transport.sockets[1]!;
    resumed.open();
    const resumedSetup = parseSent(resumed)[0] as { setup: Record<string, unknown> };
    expect(resumedSetup.setup.sessionResumption).toEqual({ handle: "handle-2" });
    expect(resumedSetup.setup).not.toHaveProperty("historyConfig");
    resumed.receive({ setupComplete: {} });
    await drainMicrotasks();
    expect(parseSent(resumed)).toEqual([
      { setup: resumedSetup.setup },
      { realtimeInput: { text: "during reconnect" } },
    ]);
    expect(events).toContainEqual({ type: "setup-complete", resumed: true });
    session.dispose();
  });

  it("clears a stale handle and snapshots dynamic history once for each fresh retry", async () => {
    const transport = createSocketFactory();
    const scheduler = createScheduler();
    const events: GoogleLiveSessionEvent[] = [];
    let latestHistory: GoogleLiveHistoryMessage[] = [{ role: "user", text: "Initial seed" }];
    const historyProvider = vi.fn(() => latestHistory);
    const session = new GoogleLiveSession({
      apiKey: "key",
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      historyProvider,
      emit: (event) => events.push(event),
    }, {
      webSocketFactory: transport.factory,
      schedule: scheduler.schedule,
      cancelScheduled: scheduler.cancelScheduled,
    });
    const connected = session.connect();
    const first = transport.sockets[0]!;
    first.open();
    latestHistory = [{ role: "user", text: "Changed after first setup" }];
    first.receive({ setupComplete: {} });
    await connected;
    expect(parseSent(first)[1]).toEqual({
      clientContent: {
        turns: [{ role: "user", parts: [{ text: "Initial seed" }] }],
        turnComplete: true,
      },
    });

    first.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "stale-handle" } });
    first.receive({ sessionResumptionUpdate: { resumable: false } });
    latestHistory = [
      { role: "user", text: "Latest local user" },
      { role: "model", text: "Latest partial reply" },
    ];
    first.receive({ goAway: { timeLeft: "5s" } });
    await vi.waitFor(() => expect(scheduler.pending).toHaveLength(1));
    scheduler.runNext();

    const retry = transport.sockets[1]!;
    expect(historyProvider).toHaveBeenCalledTimes(2);
    retry.open();
    expect(parseSent(retry)[0]).toMatchObject({
      setup: {
        historyConfig: { initialHistoryInClientContent: true },
        sessionResumption: {},
      },
    });
    latestHistory = [{ role: "user", text: "Changed after retry setup" }];
    retry.receive({ setupComplete: {} });
    await drainMicrotasks();

    expect(parseSent(retry)[1]).toEqual({
      clientContent: {
        turns: [
          { role: "user", parts: [{ text: "Latest local user" }] },
          { role: "model", parts: [{ text: "Latest partial reply" }] },
        ],
        turnComplete: true,
      },
    });
    expect(events).toContainEqual({ type: "session-resumption", resumable: false, handle: undefined });
    expect(events.filter((event) =>
      event.type === "setup-complete" && !event.resumed)).toHaveLength(2);
    session.dispose();
  });

  it("retries at 0.5/1/2 seconds and redacts credentials from typed errors", async () => {
    const transport = createSocketFactory();
    const scheduler = createScheduler();
    const events: GoogleLiveSessionEvent[] = [];
    const apiKey = "super-secret-key";
    const session = new GoogleLiveSession({
      apiKey,
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      emit: (event) => events.push(event),
    }, {
      webSocketFactory: transport.factory,
      schedule: scheduler.schedule,
      cancelScheduled: scheduler.cancelScheduled,
    });
    const connected = session.connect();

    transport.sockets[0]!.error(new Error(`failed ${transport.urls[0]}`));
    expect(scheduler.runNext()).toBe(500);
    transport.sockets[1]!.error(new Error(`failed ${apiKey}`));
    expect(scheduler.runNext()).toBe(1_000);
    transport.sockets[2]!.error(new Error(`failed ?key=${apiKey}`));
    expect(scheduler.runNext()).toBe(2_000);
    const rejection = expect(connected).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
      retryable: false,
    });
    transport.sockets[3]!.error(new Error(`failed access_token=${apiKey}`));
    await rejection;

    const retryStatuses = events.filter(
      (event): event is Extract<GoogleLiveSessionEvent, { type: "status" }> =>
        event.type === "status" && event.status === "reconnecting",
    );
    expect(retryStatuses.map((event) => event.retryInMs)).toEqual([500, 1_000, 2_000]);
    const errors = events.filter(
      (event): event is Extract<GoogleLiveSessionEvent, { type: "error" }> => event.type === "error",
    );
    expect(errors).toHaveLength(4);
    for (const event of errors) {
      expect(event.error).toBeInstanceOf(GoogleLiveSessionError);
      expect(event.error.message).not.toContain(apiKey);
      expect(event.error.cause).toBeUndefined();
    }
  });

  it.each([
    ["API key not valid", "AUTHENTICATION_FAILED"],
    ["RESOURCE_EXHAUSTED: quota exceeded", "QUOTA_EXCEEDED"],
    ["Configured model is unavailable", "MODEL_UNAVAILABLE"],
  ] as const)("classifies terminal setup failures: %s", async (reason, code) => {
    const transport = createSocketFactory();
    const events: GoogleLiveSessionEvent[] = [];
    const session = new GoogleLiveSession({
      apiKey: "key",
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      emit: (event) => events.push(event),
    }, { webSocketFactory: transport.factory });
    const connected = session.connect();
    const socket = transport.sockets[0]!;
    socket.open();
    socket.serverClose(1008, reason, true);

    await expect(connected).rejects.toMatchObject({ code, retryable: false });
    expect(transport.sockets).toHaveLength(1);
    expect(events).toContainEqual({
      type: "error",
      error: expect.objectContaining({ code }),
    });
  });

  it("surfaces a protocol error after setup without killing the usable session", async () => {
    const transport = createSocketFactory();
    const events: GoogleLiveSessionEvent[] = [];
    const session = new GoogleLiveSession({
      apiKey: "key",
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      autoReconnect: false,
      emit: (event) => events.push(event),
    }, { webSocketFactory: transport.factory });
    const connected = session.connect();
    const socket = transport.sockets[0]!;
    socket.open();
    socket.receive({ setupComplete: {} });
    await connected;

    socket.receiveRaw("not-json");
    await drainMicrotasks();
    expect(events).toContainEqual({
      type: "error",
      error: expect.objectContaining({ code: "PROTOCOL_ERROR" }),
    });
    session.sendText("still usable");
    expect(parseSent(socket).at(-1)).toEqual({ realtimeInput: { text: "still usable" } });
    session.dispose();
  });

  it("lets callers cancel a connection test and permanently dispose the session", async () => {
    const transport = createSocketFactory();
    const session = new GoogleLiveSession({
      apiKey: "key",
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      emit: vi.fn(),
    }, { webSocketFactory: transport.factory });
    const connected = session.connect();
    const rejection = expect(connected).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
    session.cancel();
    await rejection;
    session.dispose();
    await expect(session.connect()).rejects.toMatchObject({ code: "DISPOSED" });
  });
});

import { describe, expect, it } from "vitest";
import { GoogleLiveProtocolError } from "./errors";
import {
  buildGoogleLiveHistorySeed,
  buildGoogleLiveSetupMessage,
  buildGoogleLiveWebSocketUrl,
  decodePcm16Base64,
  encodePcm16Base64,
  parseGoogleLiveServerMessage,
} from "./protocol";

describe("Google Live protocol", () => {
  it("builds the direct BYOK v1beta URL without placing the key in setup", () => {
    const url = buildGoogleLiveWebSocketUrl("secret/key+=");
    expect(url).toBe(
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
      "?key=secret%2Fkey%2B%3D",
    );
    const message = buildGoogleLiveSetupMessage({
      apiKey: "secret/key+=",
      modelId: "gemini-3.1-flash-live-preview",
      systemInstruction: "Be kind.",
      voiceName: "Kore",
      activityHandling: "NO_INTERRUPTION",
      initialHistory: true,
      functionDeclarations: [{
        name: "setState",
        description: "Set state",
        parametersJsonSchema: {
          type: "object",
          properties: { state: { type: "string", enum: ["happy"] } },
          required: ["state"],
          additionalProperties: false,
        },
      }],
    });
    expect(message).toEqual({
      setup: {
        model: "models/gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
          },
        },
        realtimeInputConfig: { activityHandling: "NO_INTERRUPTION" },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: {},
        systemInstruction: { parts: [{ text: "Be kind." }] },
        tools: [{ functionDeclarations: [{
          name: "setState",
          description: "Set state",
          parametersJsonSchema: {
            type: "object",
            properties: { state: { type: "string", enum: ["happy"] } },
            required: ["state"],
            additionalProperties: false,
          },
        }] }],
        historyConfig: { initialHistoryInClientContent: true },
      },
    });
    expect(JSON.stringify(message)).not.toContain("secret/key");
  });

  it("resumes with a handle and does not request a second history seed", () => {
    const message = buildGoogleLiveSetupMessage({
      apiKey: "key",
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      resumeHandle: "resume-1",
    });
    expect(message.setup).toMatchObject({
      sessionResumption: { handle: "resume-1" },
      realtimeInputConfig: { activityHandling: "START_OF_ACTIVITY_INTERRUPTS" },
    });
    expect(message.setup).not.toHaveProperty("historyConfig");
  });

  it("does not enable initial-history mode when there is no history to seed", () => {
    const message = buildGoogleLiveSetupMessage({
      apiKey: "key",
      activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
    });
    expect(message.setup).not.toHaveProperty("historyConfig");
  });

  it("maps assistant history to Gemini's model role and closes the seed", () => {
    expect(buildGoogleLiveHistorySeed([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi" },
    ])).toEqual({
      clientContent: {
        turns: [
          { role: "user", parts: [{ text: "Hello" }] },
          { role: "model", parts: [{ text: "Hi" }] },
        ],
        turnComplete: true,
      },
    });
    expect(buildGoogleLiveHistorySeed([])).toEqual({
      clientContent: { turns: [], turnComplete: true },
    });
  });

  it("round-trips signed little-endian PCM16", () => {
    const input = new Int16Array([-32_768, -1, 0, 1, 32_767]);
    expect([...decodePcm16Base64(encodePcm16Base64(input))]).toEqual([...input]);
  });

  it("parses every model part plus independently ordered transcript and lifecycle fields", async () => {
    const audio = encodePcm16Base64(new Int16Array([10, -10]));
    const message = await parseGoogleLiveServerMessage(JSON.stringify({
      serverContent: {
        modelTurn: {
          parts: [
            { inlineData: { data: audio, mimeType: "audio/pcm;rate=24000" } },
            { text: "visible" },
            { text: "thought", thought: true },
          ],
        },
        interimInputTranscription: { text: "hel", languageCode: "en" },
        inputTranscription: { text: "hello", languageCode: "en" },
        outputTranscription: { text: "hi", languageCode: "en" },
        generationComplete: true,
        turnComplete: true,
      },
      usageMetadata: { totalTokenCount: 12 },
    }));
    expect(message.serverContent?.modelTurnParts).toHaveLength(3);
    expect(message.serverContent?.interimInputTranscription).toEqual({
      text: "hel",
      languageCode: "en",
    });
    expect(message.serverContent?.generationComplete).toBe(true);
    expect(message.serverContent?.turnComplete).toBe(true);
    expect(message.usageMetadata).toEqual({ totalTokenCount: 12 });
  });

  it("rejects malformed and unknown protocol frames with a typed error", async () => {
    await expect(parseGoogleLiveServerMessage("not-json"))
      .rejects.toBeInstanceOf(GoogleLiveProtocolError);
    await expect(parseGoogleLiveServerMessage(JSON.stringify({ unexpected: {} })))
      .rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    await expect(parseGoogleLiveServerMessage(JSON.stringify({
      toolCall: { functionCalls: [{ id: "", name: "bad" }] },
    }))).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });
});

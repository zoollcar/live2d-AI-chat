import * as tts from "@diffusionstudio/vits-web";
import { downloadVitsVoice, isVitsVoiceDownloaded } from "./model-download";

onmessage = async (event: MessageEvent<{ id: string; text: string; voice: string }>) => {
  const { id, text, voice } = event.data;
  try {
    const voiceId = voice as Parameters<typeof tts.download>[0];
    if (!(await isVitsVoiceDownloaded(voiceId))) await downloadVitsVoice(voiceId);
    const blob = await tts.predict({ text, voiceId });
    postMessage({ id, blob });
  } catch (error) {
    postMessage({ id, error: error instanceof Error ? error.message : "VITS synthesis failed." });
  }
};

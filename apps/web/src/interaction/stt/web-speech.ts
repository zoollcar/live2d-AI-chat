import type { SttSettings } from "@live2d-chat/shared";
import type { RecognitionCallbacks, SpeechRecognitionProvider } from "./types";

export class WebSpeechRecognitionProvider implements SpeechRecognitionProvider {
  readonly id = "web-speech";
  private recognition?: SpeechRecognition;

  constructor(private readonly settings: SttSettings) {}

  isSupported() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  async start(callbacks: RecognitionCallbacks) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) throw new Error("This browser does not support Web Speech recognition.");
    this.abort();
    const recognition = new Recognition();
    recognition.lang = this.settings.language;
    recognition.continuous = this.settings.continuous;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript || "";
        if (result?.isFinal) callbacks.onFinal(text.trim());
        else interim += text;
      }
      callbacks.onInterim(interim.trim());
    };
    recognition.onerror = (event) => callbacks.onError(new Error(event.message || event.error));
    recognition.onend = () => callbacks.onStatus("idle");
    recognition.start();
    this.recognition = recognition;
    callbacks.onStatus("listening");
  }

  async stop() {
    this.recognition?.stop();
  }

  abort() {
    this.recognition?.abort();
    this.recognition = undefined;
  }
}

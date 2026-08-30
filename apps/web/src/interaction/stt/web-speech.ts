import type { SttSettings } from "@live2d-chat/shared";
import { createLogger } from "@/infrastructure/log";
import type { RecognitionCallbacks, SpeechRecognitionProvider } from "./types";

const log = createLogger("stt:web-speech");

export class WebSpeechRecognitionProvider implements SpeechRecognitionProvider {
  readonly id = "web-speech";
  private recognition?: SpeechRecognition;
  // Tracks the lifecycle of the *current* recognition object so we can tell a
  // graceful end (user clicked stop / final result flushed) apart from a
  // background end fired by the browser. Without this, `onend` from Chrome's
  // "no-speech" timeout can clobber the listening status that `onstart` just
  // set, making the button look completely unresponsive.
  private endSilently = false;

  constructor(private readonly settings: SttSettings) {}

  isSupported() {
    const supported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    log.debug("isSupported", { supported, lang: this.settings.language, continuous: this.settings.continuous });
    return supported;
  }

  async start(callbacks: RecognitionCallbacks) {
    log.debug("start() called", { lang: this.settings.language, continuous: this.settings.continuous, interimResults: true });
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      log.error("SpeechRecognition constructor not available on window");
      throw new Error("This browser does not support Web Speech recognition.");
    }
    // Tear down any previous instance synchronously so its onend/onerror
    // handlers can't fire after we swap in the new recognition object.
    this.abort();
    const recognition = new Recognition();
    recognition.lang = this.settings.language;
    recognition.continuous = this.settings.continuous;
    recognition.interimResults = true;

    // Stash the reference *before* wiring events or calling start(): Chrome can
    // fire `onstart` synchronously from start() in some implementations, and we
    // need abort() to be able to reach the object even mid-startup.
    this.recognition = recognition;
    this.endSilently = false;

    recognition.onstart = () => {
      log.debug("onstart fired", { lang: recognition.lang });
      callbacks.onStatus("listening");
    };
    recognition.onaudiostart = () => log.debug("onaudiostart fired — mic is now capturing");
    recognition.onaudioend = () => log.debug("onaudioend fired — mic capture stopped");
    recognition.onspeechstart = () => {
      log.debug("onspeechstart fired — detected speech");
      callbacks.onSpeechStart?.();
    };
    recognition.onspeechend = () => log.debug("onspeechend fired — speech paused");
    recognition.onnomatch = () => log.warn("onnomatch fired — no recognition match");
    recognition.onresult = (event) => {
      log.debug("onresult fired", {
        resultIndex: event.resultIndex,
        resultCount: event.results.length,
        firstIsFinal: event.results[event.resultIndex]?.isFinal,
        firstTranscript: event.results[event.resultIndex]?.[0]?.transcript,
      });
      let interim = "";
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript || "";
        if (result?.isFinal) {
          // Coalesce multiple finals in the same batch so the consumer only
          // sees one event per chunk; this also avoids racing the auto-restart
          // logic with itself when Chrome fires several finals back-to-back.
          finalText = finalText ? `${finalText} ${text}`.trim() : text.trim();
        } else {
          interim += text;
        }
      }
      // Emit interim FIRST so any subsequent final overwrites the subtitle
      // rather than getting clobbered by the interim accumulation.
      const interimText = interim.trim();
      if (interimText) callbacks.onInterim(interimText);
      if (finalText) callbacks.onFinal(finalText);
    };
    recognition.onerror = (event) => {
      const error = event.error || event.message;
      log.error("onerror fired", { error, message: event.message });
      // "no-speech" and "aborted" are normal lifecycle events, not failures;
      // surface them through the status channel instead of the error channel
      // so the UI doesn't flash a red error for an empty utterance.
      if (error === "no-speech" || error === "aborted") {
        callbacks.onStatus("idle");
        // Tell the host the session ended on its own so it can decide whether
        // to reopen the mic (continuous mode) or leave it idle (one-shot).
        callbacks.onAutoEnd?.();
        return;
      }
      callbacks.onError(new Error(error || "Speech recognition failed."));
    };
    recognition.onend = () => {
      log.debug("onend fired", { endSilently: this.endSilently, hasRecognition: !!this.recognition });
      // If we asked for the end (stop()/abort()) skip the idle flip so we don't
      // race with our own follow-up state changes.
      if (this.endSilently) return;
      callbacks.onStatus("idle");
      callbacks.onAutoEnd?.();
    };

    try {
      log.debug("calling recognition.start()");
      recognition.start();
      log.debug("recognition.start() returned");
    } catch (error) {
      log.warn("recognition.start() threw, aborting and retrying once", { error: String(error) });
      // start() throws InvalidStateError when called while another recognition
      // is already running. Abort the previous one and retry once so a stuck
      // mic permission prompt or page reload doesn't permanently lock STT.
      this.abort();
      recognition.start();
      log.debug("retry recognition.start() returned");
    }
  }

  async stop() {
    const recognition = this.recognition;
    log.debug("stop() called", { hasRecognition: !!recognition });
    if (!recognition) return;
    this.endSilently = true;
    try {
      recognition.stop();
    } catch (error) {
      log.warn("recognition.stop() threw, falling back to abort", { error: String(error) });
      // stop() can throw if the recognition hasn't actually started; fall back
      // to abort() so we always reach a clean idle state.
      this.abort();
    }
  }

  abort() {
    const recognition = this.recognition;
    log.debug("abort() called", { hasRecognition: !!recognition });
    if (!recognition) return;
    this.endSilently = true;
    // Detach the lifecycle handlers synchronously so a late-firing onend from
    // a Chrome internals never reaches the React layer after we tore it down.
    recognition.onend = null;
    recognition.onerror = null;
    recognition.onresult = null;
    recognition.onstart = null;
    recognition.onaudiostart = null;
    recognition.onaudioend = null;
    recognition.onspeechstart = null;
    recognition.onspeechend = null;
    recognition.onnomatch = null;
    try { recognition.abort(); log.debug("recognition.abort() returned"); }
    catch (error) { log.warn("recognition.abort() threw", { error: String(error) }); }
    this.recognition = undefined;
  }
}

import { useState, useEffect } from "react";
import { useSpeechRecognition } from "react-speech-recognition";

const Dictaphone = ({ commands, onSpeechRecognized, onUserSpeaking }) => {
  const [transcribing, setTranscribing] = useState(true);
  const [clearTranscriptOnListen, setClearTranscriptOnListen] = useState(true);
  const toggleTranscribing = () => setTranscribing(!transcribing);
  const toggleClearTranscriptOnListen = () =>
    setClearTranscriptOnListen(!clearTranscriptOnListen);
  const {
    transcript,
    interimTranscript,
    finalTranscript,
    resetTranscript,
    listening,
    browserSupportsSpeechRecognition,
    isMicrophoneAvailable,
  } = useSpeechRecognition({ transcribing, clearTranscriptOnListen, commands });

  useEffect(() => {
    if (interimTranscript !== "") {
      console.log("Got interim result:", interimTranscript);
      onUserSpeaking(interimTranscript);
    }
    if (finalTranscript !== "") {
      console.log("Got final result:", finalTranscript);
      onSpeechRecognized(finalTranscript);
      resetTranscript();
    }
  }, [interimTranscript, finalTranscript]);

  if (!browserSupportsSpeechRecognition) {
    return <span>No browser support</span>;
  }

  if (!isMicrophoneAvailable) {
    return <span>Please allow access to the microphone</span>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* <span>listening: {listening ? "on" : "off"}</span>
      <span>transcribing: {transcribing ? "on" : "off"}</span>
      <span>
        clearTranscriptOnListen: {clearTranscriptOnListen ? "on" : "off"}
      </span>
      <button onClick={resetTranscript}>Reset</button>
      <button onClick={toggleTranscribing}>Toggle transcribing</button>
      <button onClick={toggleClearTranscriptOnListen}>
        Toggle clearTranscriptOnListen
      </button> */}
      <span>{transcript}</span>
    </div>
  );
};

export default Dictaphone;

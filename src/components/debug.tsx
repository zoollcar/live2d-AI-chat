import { useRef } from "react";
import { Live2DModel, InternalModel } from "pixi-live2d-display-lipsyncpatch";
import { textToSpeechWeb, textToSpeechUseBackend } from "../models/tts/textToSpeech";

export default function Debug({
  model,
  handleSpeak,
}: {
  model: Live2DModel<InternalModel> | null;
  handleSpeak: (audio_link: string, model: Live2DModel) => Promise<void>;
}) {
  const expressionInput = useRef(null);

  return (
    <>
      {model && (
        <div className="flex place-content-between">
          <div id="test buttons" className="flex gap-2 flex-wrap">
            <button
              className="bg-gray-200 rounded-sm"
              onClick={async () => {
                const data = await textToSpeechWeb("hello word", "tts");
                handleSpeak(data, model);
              }}
            >
              test speaking(web)
            </button>
            <button
              className="bg-gray-200 rounded-sm"
              onClick={async () => {
                const data = await textToSpeechUseBackend("hello word", "tts");
                handleSpeak(data, model);
              }}
            >
              test speaking(backend)
            </button>
            <button
              className="bg-gray-200 rounded-sm"
              onClick={async () => {
                model.motion("Idle").catch((e) => console.error(e));
              }}
            >
              run motion-Idle
            </button>
            <button
              className="bg-gray-200 rounded-sm"
              onClick={async () => {
                model.motion("Speak").catch((e) => console.error(e));
              }}
            >
              run motion-Speak
            </button>
            <br />
            <input
              type="text"
              className="bg-gray-200 rounded-sm"
              id="input"
              placeholder="input expression name"
              ref={expressionInput}
            />
            <button
              className="bg-gray-200 rounded-sm"
              onClick={async () => {
                // use the data in input
                if (expressionInput.current) {
                  const expressionName = (expressionInput.current as HTMLInputElement).value;
                  model
                    .expression(Number(expressionName))
                    .catch((e) => console.error(e));
                }
              }}
            >
              run expression
            </button>
            <button
              className="bg-gray-200 rounded-sm"
              onClick={async () => {
                // use the data in input
                if (expressionInput.current) {
                  // const customMotion =
                  //   model.internalModel.motionManager.createMotion(
                  //     twoPointMove(),
                  //     "app",
                  //     "temp1"
                  //   );
                  // model.internalModel.motionManager._startMotion(customMotion);
                }
              }}
            >
              run CustomMotion
            </button>
          </div>
        </div>
      )}
    </>
  );
}

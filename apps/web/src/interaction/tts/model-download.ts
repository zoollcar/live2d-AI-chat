import { downloadToOpfs, getPartialDownloadProgress } from "@/infrastructure/download/resumable";

const baseUrl = "https://huggingface.co/diffusionstudio/piper-voices/resolve/main";
const voicePaths: Record<string, string> = {
  "en_US-hfc_female-medium": "en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx",
  "en_US-hfc_male-medium": "en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx",
  "zh_CN-huayan-medium": "zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx",
  "zh_CN-huayan-x_low": "zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx",
};

export async function downloadVitsVoice(
  voiceId: string,
  onProgress: (progress: number) => void = () => undefined,
  signal?: AbortSignal,
) {
  const path = voicePaths[voiceId];
  if (!path) throw new Error("这个声音暂不支持断点续传。");
  const modelUrl = `${baseUrl}/${path}`;
  const configUrl = `${modelUrl}.json`;
  const modelName = path.split("/").at(-1) || `${voiceId}.onnx`;
  await downloadToOpfs("piper", modelName, modelUrl, ({ loaded, total }) => {
    onProgress(total ? loaded / total : 0);
  }, signal);
  await downloadToOpfs("piper", `${modelName}.json`, configUrl, () => undefined, signal);
  await writeCompletionMarker(voiceId);
  onProgress(1);
}

export async function getVitsVoicePartialProgress(voiceId: string) {
  const path = voicePaths[voiceId];
  if (!path) return 0;
  const url = `${baseUrl}/${path}`;
  const name = path.split("/").at(-1) || `${voiceId}.onnx`;
  const { loaded, total } = await getPartialDownloadProgress("piper", name, url);
  return total ? Math.min(loaded / total, 1) : 0;
}

export async function isVitsVoiceDownloaded(voiceId: string) {
  if (await hasCompletionMarker(voiceId)) return true;
  const path = voicePaths[voiceId];
  if (!path) return false;
  const modelUrl = `${baseUrl}/${path}`;
  const modelName = path.split("/").at(-1) || `${voiceId}.onnx`;
  const [model, config] = await Promise.all([
    getPartialDownloadProgress("piper", modelName, modelUrl),
    getPartialDownloadProgress("piper", `${modelName}.json`, `${modelUrl}.json`),
  ]);
  const complete = model.total > 0 && model.loaded === model.total
    && config.total > 0 && config.loaded === config.total;
  if (complete) await writeCompletionMarker(voiceId);
  return complete;
}

async function hasCompletionMarker(voiceId: string) {
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("piper");
    await directory.getFileHandle(`.${voiceId}.complete`);
    return true;
  } catch {
    return false;
  }
}

async function writeCompletionMarker(voiceId: string) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("piper", { create: true });
  const handle = await directory.getFileHandle(`.${voiceId}.complete`, { create: true });
  const writable = await handle.createWritable();
  await writable.write("complete");
  await writable.close();
}

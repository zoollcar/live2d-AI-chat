import { getHFModelSource, ModelManager, ModelValidationStatus } from "@wllama/wllama";
import { downloadToOpfs, getPartialDownloadProgress } from "@/infrastructure/download/resumable";

export interface LocalModelPreset {
  id: string;
  label: string;
  repo: string;
  quant: string;
  size: string;
}

export const localModelPresets: LocalModelPreset[] = [
  {
    id: "unsloth/Qwen3.5-0.8B-GGUF",
    label: "Qwen 3.5 0.8B · 轻量推荐",
    repo: "unsloth/Qwen3.5-0.8B-GGUF",
    quant: "Q4_K_M",
    size: "约 533 MB",
  },
  {
    id: "unsloth/Qwen3-1.7B-GGUF",
    label: "Qwen 3 1.7B · 效果均衡",
    repo: "unsloth/Qwen3-1.7B-GGUF",
    quant: "Q4_K_M",
    size: "约 1.11 GB",
  },
  {
    id: "unsloth/Qwen3.5-2B-GGUF",
    label: "Qwen 3.5 2B · 更高质量",
    repo: "unsloth/Qwen3.5-2B-GGUF",
    quant: "Q4_K_M",
    size: "约 1.3 GB",
  },
];

const modelManager = new ModelManager({ allowOffline: true });

export function getLocalModelConfig(modelId: string) {
  const preset = localModelPresets.find((model) => model.id === modelId);
  if (preset) return { repo: preset.repo, quant: preset.quant };
  const [repo, quant = "Q4_K_M"] = modelId.split("#");
  if (!repo.includes("/")) {
    return { repo: localModelPresets[0].repo, quant: localModelPresets[0].quant };
  }
  return { repo: repo.trim(), quant: quant.trim() || "Q4_K_M" };
}

export async function isLocalModelDownloaded(modelId: string): Promise<boolean> {
  if (!modelId.trim()) return false;
  const source = await getHFModelSource(getLocalModelConfig(modelId));
  const models = await modelManager.getModels({ includeInvalid: true });
  return models.some((model) => model.url === source.url && model.validate() === ModelValidationStatus.VALID);
}

export async function downloadLocalModel(
  modelId: string,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
) {
  if (await isLocalModelDownloaded(modelId)) {
    onProgress(1);
    return;
  }
  const source = await getHFModelSource(getLocalModelConfig(modelId));
  const urls = ModelManager.parseModelUrl(source.url);
  const remoteSizes = await Promise.all(urls.map(async (url) => {
    const key = await modelManager.cacheManager.getNameFromURL(url);
    const progress = await getPartialDownloadProgress("cache", key, url);
    return { url, key, total: progress.total };
  }));
  const grandTotal = remoteSizes.reduce((sum, file) => sum + file.total, 0);
  let completed = 0;
  for (const file of remoteSizes) {
    const result = await downloadToOpfs("cache", file.key, file.url, ({ loaded }) => {
      onProgress(grandTotal ? (completed + loaded) / grandTotal : 0);
    }, signal);
    await modelManager.cacheManager.writeMetadata(file.key, {
      originalURL: file.url,
      originalSize: result.total,
      etag: result.etag.replace(/[^A-Za-z0-9]/g, ""),
    });
    completed += result.total;
  }
  onProgress(1);
}

export async function getLocalModelPartialProgress(modelId: string): Promise<number> {
  if (!modelId.trim()) return 0;
  const source = await getHFModelSource(getLocalModelConfig(modelId));
  const urls = ModelManager.parseModelUrl(source.url);
  const progress = await Promise.all(urls.map(async (url) => {
    const key = await modelManager.cacheManager.getNameFromURL(url);
    return getPartialDownloadProgress("cache", key, url);
  }));
  const loaded = progress.reduce((sum, file) => sum + file.loaded, 0);
  const total = progress.reduce((sum, file) => sum + file.total, 0);
  return total ? Math.min(loaded / total, 1) : 0;
}

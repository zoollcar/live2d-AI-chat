const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

interface GoogleModelResource {
  name?: string;
  baseModelId?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

interface GoogleModelListResponse {
  models?: GoogleModelResource[];
  nextPageToken?: string;
  error?: { message?: string };
}

export interface GoogleRealtimeModel {
  id: string;
  label: string;
}

function isRealtimeModel(model: GoogleModelResource): boolean {
  return model.supportedGenerationMethods?.some((method) =>
    method.toLowerCase() === "bidigeneratecontent") ?? false;
}

function modelId(model: GoogleModelResource): string {
  return (model.baseModelId || model.name?.replace(/^models\//, "") || "").trim();
}

/** Fetches every Gemini model visible to the supplied key and keeps only Live API models. */
export async function fetchGoogleRealtimeModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<GoogleRealtimeModel[]> {
  if (!apiKey.trim()) throw new Error("Enter a Google Gemini API key to load models.");

  const models = new Map<string, GoogleRealtimeModel>();
  let pageToken = "";
  do {
    const url = new URL(GOOGLE_MODELS_URL);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, {
      headers: { "x-goog-api-key": apiKey.trim() },
      signal,
    });
    const payload = await response.json().catch(() => ({})) as GoogleModelListResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message || `Google Gemini API returned HTTP ${response.status}.`);
    }
    for (const model of payload.models ?? []) {
      if (!isRealtimeModel(model)) continue;
      const id = modelId(model);
      if (!id) continue;
      models.set(id, { id, label: model.displayName?.trim() || id });
    }
    pageToken = payload.nextPageToken?.trim() || "";
  } while (pageToken);

  return [...models.values()].sort((left, right) => left.label.localeCompare(right.label));
}

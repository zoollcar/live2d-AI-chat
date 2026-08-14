export interface ResumableDownloadProgress {
  loaded: number;
  total: number;
}

export async function getPartialDownloadProgress(
  directory: string,
  fileName: string,
  url: string,
): Promise<ResumableDownloadProgress> {
  const existing = await getStoredSize(directory, fileName);
  if (!existing) return { loaded: 0, total: 0 };
  const remote = await getRemoteInfo(url).catch(() => ({ total: 0, etag: "" }));
  return { loaded: existing, total: remote.total };
}

export async function downloadToOpfs(
  directory: string,
  fileName: string,
  url: string,
  onProgress: (progress: ResumableDownloadProgress) => void,
  signal?: AbortSignal,
): Promise<{ total: number; etag: string }> {
  const directoryHandle = await getDirectory(directory);
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  let existing = (await fileHandle.getFile()).size;
  const remote = await getRemoteInfo(url, signal).catch(() => ({ total: 0, etag: "" }));

  if (remote.total > 0 && existing === remote.total) {
    onProgress({ loaded: existing, total: remote.total });
    return remote;
  }
  if (remote.total > 0 && existing > remote.total) existing = 0;

  const headers: Record<string, string> = {};
  if (existing > 0) {
    headers.Range = `bytes=${existing}-`;
    if (remote.etag) headers["If-Range"] = remote.etag;
  }
  const response = await fetch(url, { headers, signal });
  if (response.status === 416 && remote.total > 0 && existing === remote.total) return remote;
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);

  const resumed = existing > 0 && response.status === 206;
  if (!resumed) existing = 0;
  const total = parseTotal(response, existing, remote.total);
  const writable = await fileHandle.createWritable({ keepExistingData: resumed });
  if (resumed) await writable.seek(existing);
  else await writable.truncate(0);

  let loaded = existing;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      loaded += value.byteLength;
      onProgress({ loaded, total });
    }
  } finally {
    await writable.close();
  }

  if (total > 0 && loaded !== total) throw new Error(`Incomplete download (${loaded}/${total} bytes)`);
  return { total: total || loaded, etag: response.headers.get("etag") || remote.etag };
}

async function getDirectory(name: string) {
  if (!navigator.storage?.getDirectory) throw new Error("This browser does not support model file storage.");
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

async function getStoredSize(directory: string, fileName: string) {
  try {
    const handle = await getDirectory(directory);
    return (await (await handle.getFileHandle(fileName)).getFile()).size;
  } catch {
    return 0;
  }
}

async function getRemoteInfo(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { method: "HEAD", signal });
  if (!response.ok) throw new Error(`Unable to read model information: HTTP ${response.status}`);
  return {
    total: Number(response.headers.get("content-length") || 0),
    etag: response.headers.get("etag") || "",
  };
}

function parseTotal(response: Response, offset: number, fallback: number) {
  const contentRange = response.headers.get("content-range");
  const rangeTotal = contentRange?.match(/\/(\d+)$/)?.[1];
  if (rangeTotal) return Number(rangeTotal);
  const contentLength = Number(response.headers.get("content-length") || 0);
  return fallback || (contentLength ? offset + contentLength : 0);
}

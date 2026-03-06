const VIDEO_FILE_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mkv",
  "mov",
  "m4v",
  "flv",
  "avi",
  "wmv",
  "ts",
  "m2ts",
  "3gp",
  "ogv",
]);

const PLAYLIST_EXTENSIONS = new Set(["m3u8", "mpd"]);
const MAX_CANDIDATES_PER_TAB = 500;
const MAX_JOBS = 180;
const MAX_CONCURRENT_JOBS = 2;
const HLS_CACHE_TTL_MS = 8 * 60 * 1000;

const NETWORK_TYPES = ["media", "xmlhttprequest", "other"];
const tabCandidates = new Map();
const hlsAnalysisCache = new Map();
const jobs = new Map();
const queuedJobIds = [];
const downloadIdToJobId = new Map();

let nextJobId = 1;
let activeJobs = 0;
let queuePumpActive = false;

const KIND_PRIORITY = { file: 4, hls: 3, dash: 2, blob: 1, unknown: 0 };

function nowIso() {
  return new Date().toISOString();
}

function getTabMap(tabId) {
  if (!tabCandidates.has(tabId)) {
    tabCandidates.set(tabId, new Map());
  }
  return tabCandidates.get(tabId);
}

function normalizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return rawUrl || "";
  }
}

function resolveUrl(baseUrl, maybeRelative) {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return maybeRelative || "";
  }
}

function getExtension(rawUrl) {
  try {
    const { pathname } = new URL(rawUrl);
    const dot = pathname.lastIndexOf(".");
    if (dot === -1) {
      return "";
    }
    return pathname.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
}

function stripExtension(filename) {
  const clean = filename || "";
  const dot = clean.lastIndexOf(".");
  if (dot <= 0) {
    return clean;
  }
  return clean.slice(0, dot);
}

function ensureExtension(filename, extension) {
  const ext = (extension || "").replace(/^\./, "").toLowerCase();
  if (!ext) {
    return filename;
  }
  const current = getExtension(`https://placeholder.local/${filename}`);
  if (current === ext) {
    return filename;
  }
  const base = stripExtension(filename);
  return `${base}.${ext}`;
}

function getHeader(headers, name) {
  if (!Array.isArray(headers)) {
    return "";
  }
  const lower = name.toLowerCase();
  const found = headers.find(
    (header) => (header.name || "").toLowerCase() === lower,
  );
  return found?.value || "";
}

function isVideoMime(contentType) {
  const value = (contentType || "").toLowerCase();
  return (
    value.startsWith("video/") ||
    value.includes("application/vnd.apple.mpegurl") ||
    value.includes("application/x-mpegurl") ||
    value.includes("application/dash+xml") ||
    value.includes("application/octet-stream")
  );
}

function parseFilenameFromContentDisposition(contentDisposition) {
  if (!contentDisposition) {
    return "";
  }
  const utf8 = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].replaceAll('"', ""));
    } catch {
      return utf8[1].replaceAll('"', "");
    }
  }
  const ascii = contentDisposition.match(/filename="?([^"]+)"?/i);
  if (ascii?.[1]) {
    return ascii[1].trim();
  }
  return "";
}

function classifyCandidate(url, contentType = "") {
  if (!url) {
    return "unknown";
  }
  if (url.startsWith("blob:")) {
    return "blob";
  }
  const extension = getExtension(url);
  if (extension === "m3u8" || contentType.toLowerCase().includes("mpegurl")) {
    return "hls";
  }
  if (extension === "mpd" || contentType.toLowerCase().includes("dash+xml")) {
    return "dash";
  }
  if (
    VIDEO_FILE_EXTENSIONS.has(extension) ||
    contentType.toLowerCase().startsWith("video/")
  ) {
    return "file";
  }
  return "unknown";
}

function isLikelyMediaUrl(url) {
  if (!url || url.startsWith("data:")) {
    return false;
  }
  if (url.startsWith("blob:")) {
    return true;
  }
  const extension = getExtension(url);
  if (
    VIDEO_FILE_EXTENSIONS.has(extension) ||
    PLAYLIST_EXTENSIONS.has(extension)
  ) {
    return true;
  }
  const lower = url.toLowerCase();
  return (
    lower.includes("mime=video") ||
    lower.includes("type=video") ||
    lower.includes("format=mp4") ||
    lower.includes("manifest") ||
    lower.includes("playlist")
  );
}

function sanitizeFilename(filename) {
  const cleaned = (filename || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }
  return cleaned.length > 170 ? cleaned.slice(0, 170) : cleaned;
}

function buildFilename(candidate) {
  const explicit = sanitizeFilename(candidate.filename || "");
  if (explicit) {
    return explicit;
  }

  const extension = getExtension(candidate.url);
  const fallbackByKind = {
    hls: "m3u8",
    dash: "mpd",
    file: extension || "mp4",
    blob: "webm",
    unknown: extension || "mp4",
  };

  const safeTitle = sanitizeFilename(candidate.pageTitle || "");
  const name = safeTitle || "video";
  const ext = fallbackByKind[candidate.kind] || "mp4";
  return `${name}.${ext}`;
}

function selectKind(previousKind, nextKind) {
  const prev = previousKind || "unknown";
  const next = nextKind || "unknown";
  return (KIND_PRIORITY[next] || 0) >= (KIND_PRIORITY[prev] || 0) ? next : prev;
}

function mergeCandidate(existing, incoming) {
  return {
    ...existing,
    ...incoming,
    id: existing.id,
    kind: selectKind(existing.kind, incoming.kind),
    firstSeenAt: existing.firstSeenAt,
    lastSeenAt: nowIso(),
    hitCount: (existing.hitCount || 1) + 1,
  };
}

function pruneTabMap(tabMap) {
  if (tabMap.size <= MAX_CANDIDATES_PER_TAB) {
    return;
  }
  const sorted = [...tabMap.values()].sort((a, b) => {
    if (a.lastSeenAt < b.lastSeenAt) {
      return -1;
    }
    if (a.lastSeenAt > b.lastSeenAt) {
      return 1;
    }
    return 0;
  });
  const toRemove = tabMap.size - MAX_CANDIDATES_PER_TAB;
  for (let index = 0; index < toRemove; index += 1) {
    tabMap.delete(sorted[index].id);
  }
}

function upsertCandidate(tabId, rawCandidate) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return false;
  }
  const url = rawCandidate?.url || "";
  if (
    !url ||
    (!isLikelyMediaUrl(url) && !isVideoMime(rawCandidate.contentType || ""))
  ) {
    return false;
  }

  const kind =
    rawCandidate.kind || classifyCandidate(url, rawCandidate.contentType || "");
  // === SUPER FILTER ANTI-SEGMENTS 2026 ===
  // On jette tout ce qui ressemble à un segment individuel HLS/DASH
  const lower = url.toLowerCase();
  const path = new URL(url).pathname.toLowerCase();

  if (
    // Patterns classiques de segments
    path.endsWith(".ts") ||
    path.endsWith(".m4s") ||
    (path.endsWith(".mp4") && path.includes("/seg-")) ||
    path.match(/\/[0-9a-f]{8,}-[0-9]+\.(ts|m4s)$/) || // hash-seq.ts
    path.match(/\/\d{1,5}\.(ts|m4s)$/) || // 00001.ts, 123.ts
    path.match(/\/chunk-\d+\.ts/) ||
    lower.includes("segment=") ||
    lower.includes("part=") ||
    lower.includes("seq=") ||
    lower.includes("range=") ||
    // Trop court pour être un manifest complet
    (path.split("/").pop().length < 12 && path.endsWith(".ts"))
  ) {
    // On le jette sauf si c'est explicitement un manifest (rare)
    if (!lower.includes(".m3u8") && !lower.includes(".mpd")) {
      return false;
    }
  }
  const normalized = normalizeUrl(url);
  const id = normalized;
  const tabMap = getTabMap(tabId);
  const existing = tabMap.get(id);

  const baseCandidate = {
    id,
    url,
    normalizedUrl: normalized,
    kind,
    source: rawCandidate.source || "unknown",
    contentType: rawCandidate.contentType || "",
    filename: sanitizeFilename(rawCandidate.filename || ""),
    pageTitle: rawCandidate.pageTitle || "",
    pageUrl: rawCandidate.pageUrl || "",
    referrer: rawCandidate.referrer || "",
    firstSeenAt: nowIso(),
    lastSeenAt: nowIso(),
    hitCount: 1,
  };

  const merged = existing
    ? mergeCandidate(existing, baseCandidate)
    : baseCandidate;
  tabMap.set(id, merged);
  pruneTabMap(tabMap);
  return !existing;
}

function getCandidateScore(candidate) {
  let score = 0;
  score += (KIND_PRIORITY[candidate.kind] || 0) * 25;
  if (candidate.contentType?.toLowerCase().startsWith("video/")) {
    score += 18;
  }
  if ((candidate.source || "").startsWith("headers")) {
    score += 16;
  }
  if ((candidate.source || "").startsWith("network")) {
    score += 12;
  }
  if ((candidate.source || "").startsWith("dom:video")) {
    score += 8;
  }
  score += Math.min(10, candidate.hitCount || 0);
  return score;
}

function getHlsCacheSummary(url) {
  const key = normalizeUrl(url || "");
  if (!key) {
    return null;
  }
  const cached = hlsAnalysisCache.get(key);
  if (!cached) {
    return null;
  }
  return {
    analyzedAt: cached.analyzedAt,
    isMaster: cached.isMaster,
    encrypted: cached.encrypted,
    variantCount: cached.variants?.length || 0,
    segmentCount: cached.segmentCount || 0,
    bestVariant: cached.bestVariant || null,
  };
}

function listCandidates(tabId) {
  const tabMap = tabCandidates.get(tabId);
  if (!tabMap) {
    return [];
  }

  return [...tabMap.values()]
    .map((candidate) => ({
      ...candidate,
      score: getCandidateScore(candidate),
      hls: candidate.kind === "hls" ? getHlsCacheSummary(candidate.url) : null,
    }))
    .sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      if (a.lastSeenAt > b.lastSeenAt) {
        return -1;
      }
      if (a.lastSeenAt < b.lastSeenAt) {
        return 1;
      }
      return 0;
    });
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

function sendMessageToTab(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

function triggerDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

async function rescanTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return { ok: false, error: "Invalid tab id" };
  }
  try {
    await sendMessageToTab(tabId, { type: "scanNow" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function parseAttributeList(raw) {
  const attributes = {};
  const text = raw || "";
  let token = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      token += char;
      continue;
    }
    if (char === "," && !inQuotes) {
      const [key, ...valueParts] = token.split("=");
      if (key) {
        attributes[key.trim()] = valueParts
          .join("=")
          .replace(/^"|"$/g, "")
          .trim();
      }
      token = "";
      continue;
    }
    token += char;
  }

  if (token) {
    const [key, ...valueParts] = token.split("=");
    if (key) {
      attributes[key.trim()] = valueParts
        .join("=")
        .replace(/^"|"$/g, "")
        .trim();
    }
  }

  return attributes;
}

function parseResolution(rawResolution) {
  const text = rawResolution || "";
  const match = text.match(/(\d+)x(\d+)/i);
  if (!match) {
    return { width: 0, height: 0 };
  }
  return {
    width: Number.parseInt(match[1], 10) || 0,
    height: Number.parseInt(match[2], 10) || 0,
  };
}

function buildVariantLabel(variant) {
  const quality = variant.height ? `${variant.height}p` : "auto";
  const bitrate = variant.bandwidth
    ? `${Math.round(variant.bandwidth / 1000)} kbps`
    : "bitrate unknown";
  return `${quality} - ${bitrate}`;
}

function parseHlsManifest(manifestUrl, text) {
  const lines = (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const encrypted = lines.some(
    (line) => line.startsWith("#EXT-X-KEY") && !/METHOD=NONE/i.test(line),
  );
  const isMaster = lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"));

  if (isMaster) {
    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.startsWith("#EXT-X-STREAM-INF")) {
        continue;
      }
      const attributes = parseAttributeList(line.split(":").slice(1).join(":"));
      let variantLine = "";
      for (let next = index + 1; next < lines.length; next += 1) {
        if (!lines[next].startsWith("#")) {
          variantLine = lines[next];
          index = next;
          break;
        }
      }
      if (!variantLine) {
        continue;
      }
      const absoluteUrl = resolveUrl(manifestUrl, variantLine);
      const bandwidth =
        Number.parseInt(
          attributes.BANDWIDTH || attributes.AVERAGE_BANDWIDTH || "0",
          10,
        ) || 0;
      const resolution = parseResolution(attributes.RESOLUTION || "");
      const variant = {
        id: `v${variants.length + 1}`,
        url: absoluteUrl,
        bandwidth,
        resolution: attributes.RESOLUTION || "",
        width: resolution.width,
        height: resolution.height,
        codecs: attributes.CODECS || "",
      };
      variant.label = buildVariantLabel(variant);
      variants.push(variant);
    }

    const sortedVariants = variants.sort((a, b) => {
      if (a.height !== b.height) {
        return b.height - a.height;
      }
      return b.bandwidth - a.bandwidth;
    });

    return {
      isMaster: true,
      encrypted,
      variants: sortedVariants,
      segmentCount: 0,
      totalDurationSec: 0,
    };
  }

  const segments = [];
  let segmentCount = 0;
  let totalDurationSec = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.startsWith("#EXTINF")) {
      const durationText = line.split(":").slice(1).join(":").split(",")[0];
      const duration = Number.parseFloat(durationText);
      if (Number.isFinite(duration)) {
        totalDurationSec += duration;
      }
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    const absoluteUrl = resolveUrl(manifestUrl, line);
    if (!absoluteUrl) {
      continue;
    }
    segmentCount += 1;
    if (segments.length < 8) {
      segments.push(absoluteUrl);
    }
  }

  return {
    isMaster: false,
    encrypted,
    variants: [],
    segmentCount,
    sampleSegments: segments,
    totalDurationSec: Number(totalDurationSec.toFixed(2)),
  };
}

async function fetchTextFromExtension(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchTextForHls(url, tabId) {
  try {
    return await fetchTextFromExtension(url);
  } catch (extensionError) {
    if (!Number.isInteger(tabId) || tabId < 0) {
      throw extensionError;
    }

    const pageResponse = await sendMessageToTab(tabId, {
      type: "fetchTextFromPage",
      url,
    });
    if (!pageResponse?.ok) {
      throw new Error(
        pageResponse?.error ||
          extensionError.message ||
          "Cannot fetch playlist",
      );
    }
    return pageResponse.text || "";
  }
}

function getCachedHls(url, forceRefresh) {
  const key = normalizeUrl(url || "");
  if (!key) {
    return null;
  }
  if (forceRefresh) {
    return null;
  }
  const cached = hlsAnalysisCache.get(key);
  if (!cached) {
    return null;
  }
  const age = Date.now() - cached.createdAtMs;
  if (age > HLS_CACHE_TTL_MS) {
    return null;
  }
  return cached;
}

function chooseBestVariant(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null;
  }
  return [...variants].sort((a, b) => {
    if (a.height !== b.height) {
      return b.height - a.height;
    }
    return b.bandwidth - a.bandwidth;
  })[0];
}

async function analyzeHlsUrl(url, tabId, forceRefresh = false) {
  const normalized = normalizeUrl(url || "");
  if (!normalized) {
    return { ok: false, error: "Missing URL" };
  }

  const cached = getCachedHls(normalized, forceRefresh);
  if (cached) {
    return {
      ok: true,
      cached: true,
      analysis: {
        ...cached,
        createdAtMs: undefined,
      },
    };
  }

  try {
    const text = await fetchTextForHls(normalized, tabId);
    const parsed = parseHlsManifest(normalized, text);
    const bestVariant = chooseBestVariant(parsed.variants || []);

    const analysis = {
      manifestUrl: normalized,
      analyzedAt: nowIso(),
      isMaster: parsed.isMaster,
      encrypted: parsed.encrypted,
      variants: parsed.variants || [],
      bestVariant,
      segmentCount: parsed.segmentCount || 0,
      totalDurationSec: parsed.totalDurationSec || 0,
      sampleSegments: parsed.sampleSegments || [],
    };

    hlsAnalysisCache.set(normalized, {
      ...analysis,
      createdAtMs: Date.now(),
    });

    return { ok: true, cached: false, analysis };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function notifyRuntime(payload) {
  try {
    chrome.runtime.sendMessage(payload);
  } catch {
    // Ignore runtime messaging failures when popup is closed.
  }
}

function snapshotJob(job) {
  return {
    id: job.id,
    tabId: job.tabId,
    candidate: job.candidate,
    mode: job.mode,
    selectedVariantUrl: job.selectedVariantUrl,
    saveAs: job.saveAs,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    progressPercent: job.progressPercent,
    progressLabel: job.progressLabel,
    filename: job.filename,
    downloadId: job.downloadId,
    error: job.error,
  };
}

function emitJob(job) {
  notifyRuntime({
    type: "jobUpdated",
    job: snapshotJob(job),
    activeJobs,
    queuedJobs: queuedJobIds.length,
  });
}

function patchJob(job, patch) {
  Object.assign(job, patch);
  jobs.set(job.id, job);
  emitJob(job);
}

function trimJobs() {
  if (jobs.size <= MAX_JOBS) {
    return;
  }
  const removable = [...jobs.values()]
    .filter((job) => job.status === "completed" || job.status === "failed")
    .sort((a, b) => {
      if (a.endedAt < b.endedAt) {
        return -1;
      }
      if (a.endedAt > b.endedAt) {
        return 1;
      }
      return a.id - b.id;
    });

  const toDelete = Math.min(removable.length, jobs.size - MAX_JOBS);
  for (let index = 0; index < toDelete; index += 1) {
    jobs.delete(removable[index].id);
  }
}

function createJob(message) {
  const candidate = message.candidate || {};
  const kind =
    candidate.kind ||
    classifyCandidate(candidate.url || "", candidate.contentType || "");
  const mode = message.mode || (kind === "hls" ? "assemble" : "direct");

  const job = {
    id: nextJobId,
    tabId: message.tabId,
    candidate: {
      url: candidate.url,
      kind,
      pageTitle: candidate.pageTitle || "",
      filename: candidate.filename || "",
      contentType: candidate.contentType || "",
    },
    mode,
    selectedVariantUrl: message.selectedVariantUrl || "",
    saveAs: Boolean(message.saveAs),
    status: "queued",
    createdAt: nowIso(),
    startedAt: "",
    endedAt: "",
    progressPercent: 0,
    progressLabel: "Queued",
    filename: "",
    downloadId: null,
    error: "",
  };

  nextJobId += 1;
  jobs.set(job.id, job);
  trimJobs();
  emitJob(job);
  return job;
}

function enqueueJob(job) {
  if (!job) {
    return;
  }
  if (!queuedJobIds.includes(job.id)) {
    queuedJobIds.push(job.id);
  }
  patchJob(job, {
    status: "queued",
    progressPercent: 0,
    progressLabel: "Queued",
  });
  processJobQueue();
}

function getDownloadFilename(job, downloadUrl) {
  const candidate = {
    ...job.candidate,
    url: downloadUrl || job.candidate.url,
    kind: classifyCandidate(
      downloadUrl || job.candidate.url || "",
      job.candidate.contentType || "",
    ),
  };
  const initial = buildFilename(candidate);

  if (job.candidate.kind === "hls" && job.mode === "manifest") {
    return ensureExtension(stripExtension(initial), "m3u8");
  }
  if (job.candidate.kind === "hls" && job.mode === "assemble") {
    return ensureExtension(stripExtension(initial), "ts");
  }
  if (job.candidate.kind === "dash") {
    return ensureExtension(stripExtension(initial), "mpd");
  }
  return initial;
}

async function runDirectDownloadJob(job) {
  const url = job.selectedVariantUrl || job.candidate.url;
  const filename = getDownloadFilename(job, url);

  const downloadId = await triggerDownload({
    url,
    filename,
    conflictAction: "uniquify",
    saveAs: job.saveAs,
  });

  downloadIdToJobId.set(downloadId, job.id);
  patchJob(job, {
    downloadId,
    filename,
    progressPercent: 2,
    progressLabel: "Browser download started",
  });
}

async function runBlobJob(job) {
  const filename = getDownloadFilename(job, job.candidate.url);
  patchJob(job, {
    filename,
    progressPercent: 15,
    progressLabel: "Fetching blob from page",
  });

  const response = await sendMessageToTab(job.tabId, {
    type: "downloadBlobFromPage",
    url: job.candidate.url,
    filename,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Blob download failed");
  }

  patchJob(job, {
    status: "completed",
    endedAt: nowIso(),
    progressPercent: 100,
    progressLabel: "Completed",
  });
}

async function runHlsAssemblyJob(job) {
  const filename = getDownloadFilename(job, job.candidate.url);
  patchJob(job, {
    filename,
    progressPercent: 5,
    progressLabel: "Preparing HLS assembly",
  });

  const response = await sendMessageToTab(job.tabId, {
    type: "downloadHlsFromPage",
    jobId: job.id,
    manifestUrl: job.candidate.url,
    selectedVariantUrl: job.selectedVariantUrl || "",
    filename,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "HLS assembly failed");
  }

  patchJob(job, {
    status: "completed",
    endedAt: nowIso(),
    progressPercent: 100,
    progressLabel: "Completed",
  });
}

async function runJob(job) {
  patchJob(job, {
    status: "running",
    startedAt: nowIso(),
    progressPercent: 0,
    progressLabel: "Starting",
  });

  const kind = job.candidate.kind;

  if (kind === "blob") {
    await runBlobJob(job);
    return;
  }

  if (kind === "hls" && job.mode === "assemble") {
    await runHlsAssemblyJob(job);
    return;
  }

  await runDirectDownloadJob(job);
}

async function processJobQueue() {
  if (queuePumpActive) {
    return;
  }
  queuePumpActive = true;

  while (activeJobs < MAX_CONCURRENT_JOBS && queuedJobIds.length > 0) {
    const jobId = queuedJobIds.shift();
    const job = jobs.get(jobId);
    if (!job || job.status !== "queued") {
      continue;
    }

    activeJobs += 1;
    runJob(job)
      .catch((error) => {
        patchJob(job, {
          status: "failed",
          endedAt: nowIso(),
          progressLabel: "Failed",
          error: error.message || "Unknown error",
        });
      })
      .finally(() => {
        activeJobs -= 1;
        notifyRuntime({
          type: "jobsMeta",
          activeJobs,
          queuedJobs: queuedJobIds.length,
        });
        processJobQueue();
      });
  }

  queuePumpActive = false;
}

function listJobs(tabId) {
  const values = [...jobs.values()];
  const filtered = Number.isInteger(tabId)
    ? values.filter(
        (job) => !Number.isInteger(job.tabId) || job.tabId === tabId,
      )
    : values;

  return filtered
    .sort((a, b) => {
      if (a.id !== b.id) {
        return b.id - a.id;
      }
      return 0;
    })
    .map((job) => snapshotJob(job));
}

function clearFinishedJobs() {
  let removed = 0;
  [...jobs.values()].forEach((job) => {
    if (job.status === "completed" || job.status === "failed") {
      jobs.delete(job.id);
      removed += 1;
    }
  });
  return removed;
}

async function startDownloadJob(message) {
  if (!Number.isInteger(message.tabId) || message.tabId < 0) {
    return { ok: false, error: "Invalid tab id" };
  }
  if (!message.candidate?.url) {
    return { ok: false, error: "Missing candidate URL" };
  }

  const job = createJob(message);
  enqueueJob(job);
  return { ok: true, job: snapshotJob(job) };
}

async function legacyDownloadCandidate(message) {
  const mode =
    message.mode || (message.candidate?.kind === "hls" ? "assemble" : "direct");
  const response = await startDownloadJob({
    ...message,
    mode,
  });
  if (!response.ok) {
    return response;
  }
  return {
    ok: true,
    queued: true,
    jobId: response.job.id,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "upsertCandidates") {
    const tabId = Number.isInteger(message.tabId)
      ? message.tabId
      : sender?.tab?.id;
    const candidates = Array.isArray(message.candidates)
      ? message.candidates
      : [];
    let added = 0;
    candidates.forEach((candidate) => {
      if (upsertCandidate(tabId, candidate)) {
        added += 1;
      }
    });
    sendResponse({ ok: true, added });
    return true;
  }

  if (message.type === "getCandidates") {
    const tabId = Number.isInteger(message.tabId)
      ? message.tabId
      : sender?.tab?.id;
    sendResponse({ ok: true, candidates: listCandidates(tabId || -1) });
    return true;
  }

  if (message.type === "rescanTab") {
    const tabId = Number.isInteger(message.tabId)
      ? message.tabId
      : sender?.tab?.id;
    rescanTab(tabId).then(sendResponse);
    return true;
  }

  if (message.type === "getActiveTab") {
    queryActiveTab().then((tab) => {
      sendResponse({ ok: true, tab });
    });
    return true;
  }

  if (message.type === "analyzeHls") {
    analyzeHlsUrl(
      message.url,
      message.tabId,
      Boolean(message.forceRefresh),
    ).then(sendResponse);
    return true;
  }

  if (message.type === "startDownloadJob") {
    startDownloadJob(message).then(sendResponse);
    return true;
  }

  if (message.type === "downloadCandidate") {
    legacyDownloadCandidate(message).then(sendResponse);
    return true;
  }

  if (message.type === "getJobs") {
    sendResponse({
      ok: true,
      jobs: listJobs(message.tabId),
      activeJobs,
      queuedJobs: queuedJobIds.length,
    });
    return true;
  }

  if (message.type === "clearFinishedJobs") {
    const removed = clearFinishedJobs();
    sendResponse({ ok: true, removed });
    return true;
  }

  if (message.type === "hlsProgress") {
    const jobId = Number.parseInt(message.jobId, 10);
    const job = jobs.get(jobId);
    if (job) {
      const progressPercent = Math.max(
        0,
        Math.min(100, Number(message.progressPercent) || 0),
      );
      const progressLabel = message.progressLabel || job.progressLabel;
      patchJob(job, {
        progressPercent,
        progressLabel,
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.id) {
    return;
  }
  const jobId = downloadIdToJobId.get(delta.id);
  if (!jobId) {
    return;
  }
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  if (delta.bytesReceived || delta.totalBytes) {
    const bytesReceived = delta.bytesReceived?.current;
    const totalBytes = delta.totalBytes?.current;
    if (
      Number.isFinite(bytesReceived) &&
      Number.isFinite(totalBytes) &&
      totalBytes > 0
    ) {
      const ratio = bytesReceived / totalBytes;
      const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
      patchJob(job, {
        progressPercent: percent,
        progressLabel: `${percent}%`,
      });
    }
  }

  if (delta.state?.current === "complete") {
    patchJob(job, {
      status: "completed",
      endedAt: nowIso(),
      progressPercent: 100,
      progressLabel: "Completed",
    });
    downloadIdToJobId.delete(delta.id);
    trimJobs();
    return;
  }

  if (delta.state?.current === "interrupted") {
    patchJob(job, {
      status: "failed",
      endedAt: nowIso(),
      progressLabel: "Interrupted",
      error: delta.error?.current || "Interrupted",
    });
    downloadIdToJobId.delete(delta.id);
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) {
      return;
    }
    const kind = classifyCandidate(details.url);
    const likely = kind !== "unknown" || isLikelyMediaUrl(details.url);
    if (!likely) {
      return;
    }
    upsertCandidate(details.tabId, {
      url: details.url,
      kind,
      source: `network:${details.type}`,
      referrer: details.initiator || details.documentUrl || "",
    });
  },
  { urls: ["<all_urls>"], types: NETWORK_TYPES },
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) {
      return;
    }
    const contentType = getHeader(details.responseHeaders, "content-type");
    const contentDisposition = getHeader(
      details.responseHeaders,
      "content-disposition",
    );
    const likely =
      isVideoMime(contentType) ||
      Boolean(parseFilenameFromContentDisposition(contentDisposition));
    if (!likely) {
      return;
    }
    upsertCandidate(details.tabId, {
      url: details.url,
      kind: classifyCandidate(details.url, contentType),
      source: `headers:${details.type}`,
      contentType,
      filename: parseFilenameFromContentDisposition(contentDisposition),
      referrer: details.initiator || details.documentUrl || "",
    });
  },
  { urls: ["<all_urls>"], types: NETWORK_TYPES },
  ["responseHeaders", "extraHeaders"],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabCandidates.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabCandidates.delete(tabId);
  }
});

// ... ton code background existant ...

// Nouveau : gestion des messages du hijacker et injection
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "widevine-keys-found") {
    console.log("[Background] Clés Widevine capturées !", message.keys);

    // Stocke en chrome.storage pour le popup
    chrome.storage.local.get({ widevineKeys: [] }, (data) => {
      const keys = data.widevineKeys || [];
      keys.push({
        timestamp: new Date().toISOString(),
        url: message.url,
        pssh: message.pssh,
        keys: message.keys,
      });
      chrome.storage.local.set({ widevineKeys: keys.slice(-50) }); // garde les 50 derniers
    });

    // Optionnel : notifie le popup s'il est ouvert
    chrome.runtime.sendMessage({
      type: "keys-updated",
      keys: message.keys,
      url: message.url,
    });

    sendResponse({ ok: true });
    return true;
  }

  // Détection EME basique depuis content.js
  if (message.type === "drm-detected") {
    const tabId = sender.tab?.id;
    if (!tabId) return;

    // Injecte le hijacker sur cet onglet
    chrome.scripting
      .executeScript({
        target: { tabId },
        files: ["widevine_hijacker.js"],
        world: "MAIN", // important : exécute dans le monde principal, pas isolé
      })
      .then(() => {
        console.log("[Background] widevine_hijacker.js injecté sur tab", tabId);
      })
      .catch((err) => {
        console.error("[Background] Échec injection hijacker", err);
      });

    sendResponse({ ok: true });
    return true;
  }
});

// Optionnel : commande manuelle depuis popup
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "activate-drm-god") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;

      chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          files: ["widevine_hijacker.js"],
          world: "MAIN",
        })
        .catch((err) => console.error("Injection manuelle échouée", err));
    });
  }
});

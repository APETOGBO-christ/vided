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

// content.js - suite

let ffmpeg = null;

async function loadFFmpeg() {
  if (ffmpeg) return ffmpeg;

  const { FFmpeg } = await import(chrome.runtime.getURL("ffmpeg-core.js"));
  ffmpeg = new FFmpeg();

  await ffmpeg.load({
    coreURL: chrome.runtime.getURL("ffmpeg-core.js"),
    wasmURL: chrome.runtime.getURL("ffmpeg-core.wasm"),
    workerURL: chrome.runtime.getURL("ffmpeg-core.worker.js"),
  });

  console.log("[FFmpeg.wasm] Loaded");
  return ffmpeg;
}

// Fonction unifiée : assemble HLS → MP4 (avec ou sans décryptage)
async function assembleHlsToMp4(payload) {
  const {
    jobId,
    manifestUrl,
    selectedVariantUrl = "",
    keyInfo = null, // optionnel : {kid, key}
    filename = "video_complet.mp4",
  } = payload;

  emitHlsProgress(jobId, 3, "Analyse playlist m3u8...");

  // Charger manifest
  const manifestText = await fetchTextFromPage(manifestUrl);
  const manifest = parseHlsManifest(manifestUrl, manifestText);

  let mediaUrl =
    selectedVariantUrl ||
    (manifest.isMaster ? manifest.variants?.[0]?.url : manifestUrl);

  if (!mediaUrl) throw new Error("Aucune playlist média trouvée");

  const mediaText = manifest.isMaster
    ? await fetchTextFromPage(mediaUrl)
    : manifestText;
  const mediaManifest = manifest.isMaster
    ? parseHlsManifest(mediaUrl, mediaText)
    : manifest;

  if (mediaManifest.encrypted && !keyInfo) {
    throw new Error("Stream chiffré mais aucune clé fournie");
  }

  const segments = [
    ...(mediaManifest.initSegmentUrl ? [mediaManifest.initSegmentUrl] : []),
    ...mediaManifest.segments,
  ];

  if (segments.length === 0) throw new Error("Aucun segment");
  if (segments.length > 1200)
    throw new Error("Trop de segments – risque RAM overflow");

  emitHlsProgress(jobId, 8, `Téléchargement ${segments.length} segments...`);

  const files = [];
  let totalBytes = 0;

  // Fetch tous les segments (manuel pour éviter CORS sur -i manifestUrl)
  for (let i = 0; i < segments.length; i++) {
    const url = segments[i];
    try {
      const ab = await fetchArrayBufferWithRetry(url, 3);
      const name = `seg_${i}.ts`;
      await ffmpeg.writeFile(name, new Uint8Array(ab));
      files.push(name);
      totalBytes += ab.byteLength;

      if (i % 15 === 0 || i === segments.length - 1) {
        emitHlsProgress(
          jobId,
          10 + Math.round((70 * i) / segments.length),
          `${i + 1}/${segments.length} (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)`,
        );
      }
    } catch (err) {
      throw new Error(`Échec segment ${i + 1}: ${err.message}`);
    }
  }

  emitHlsProgress(jobId, 85, "Remuxage en MP4...");

  const ffmpeg = await loadFFmpeg();

  // Args de base
  let execArgs = [
    "-i",
    `concat:${files.map((f) => `file '${f}'`).join("|")}`,
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    "-movflags",
    "+faststart",
    filename,
  ];

  // Si clé de décryptage fournie → on ajoute le décryptage
  if (keyInfo?.key) {
    let keyHex = keyInfo.key.replace(/[^0-9a-fA-F]/g, "");
    if (keyHex.length !== 32)
      throw new Error(`Clé invalide (32 hex chars attendus)`);

    execArgs.splice(2, 0, "-decryption_key", keyHex);
    emitHlsProgress(jobId, 88, "Décryptage Widevine clearkey en cours...");
  }

  // Exécution ffmpeg
  await ffmpeg.exec(execArgs);

  const mp4Data = await ffmpeg.readFile(filename);
  const blob = new Blob([mp4Data.buffer], { type: "video/mp4" });

  triggerBlobDownload(blob, filename);
  emitHlsProgress(
    jobId,
    100,
    `MP4 complet – ${(blob.size / 1024 / 1024).toFixed(2)} MiB`,
  );

  // Nettoyage FS
  files.forEach((f) => ffmpeg.unlink(f));
  ffmpeg.unlink(filename);

  return { ok: true, size: blob.size, encrypted: !!keyInfo };
}

// Nouvelle fonction : decrypt HLS avec clearkey (appelée depuis popup ou background)
async function decryptAndDownloadHLS(payload) {
  const {
    jobId,
    manifestUrl,
    selectedVariantUrl = "",
    keyInfo,
    filename = "decrypted.mp4",
  } = payload;

  // keyInfo = { kid: "...", key: "..." } (hex)

  if (!keyInfo?.kid || !keyInfo?.key) {
    throw new Error("Missing clearkey KID:KEY");
  }

  const ffmpeg = await loadFFmpeg();

  // 1. Fetch manifest & parse (tu as déjà parseHlsManifest)
  emitHlsProgress(jobId, 5, "Lecture manifest...");
  const text = await fetchTextFromPage(manifestUrl);
  const manifest = parseHlsManifest(manifestUrl, text);

  let mediaUrl =
    selectedVariantUrl ||
    (manifest.isMaster ? manifest.variants?.[0]?.url : manifestUrl);
  if (!mediaUrl) throw new Error("No media playlist");

  const mediaText = manifest.isMaster
    ? await fetchTextFromPage(mediaUrl)
    : text;
  const media = manifest.isMaster
    ? parseHlsManifest(mediaUrl, mediaText)
    : manifest;

  const segments = [
    ...(media.initSegmentUrl ? [media.initSegmentUrl] : []),
    ...media.segments,
  ];

  if (segments.length > 800)
    throw new Error("Trop de segments pour wasm decrypt");

  emitHlsProgress(jobId, 10, `Fetch & decrypt ${segments.length} segments...`);

  // 2. Mount files in FS & decrypt avec clé
  const keyHex = keyInfo.key.replace(/^0x/, ""); // clean hex
  const kidHex = keyInfo.kid.replace(/^0x/, "");

  // ffmpeg decrypt HLS avec clé (CENC Widevine -> clearkey format)
  const decryptArgs = [
    "-decryption_key",
    keyHex,
    "-i",
    manifestUrl, // ffmpeg peut fetch direct si CORS ok
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    filename,
  ];

  // Mais pour full control (et éviter CORS sur segments) on fetch manuellement
  // Version manuelle : fetch chaque segment, write to FS, puis ffmpeg decrypt

  const files = [];
  for (let i = 0; i < segments.length; i++) {
    const url = segments[i];
    const resp = await fetchArrayBufferWithRetry(url, 3);
    const segName = `seg_${i}.ts`;
    await ffmpeg.writeFile(segName, new Uint8Array(resp));
    files.push(segName);
  }

  emitHlsProgress(jobId, 60, "Décryptage en cours...");

  // ffmpeg decrypt CENC (widevine clearkey mode)
  await ffmpeg.exec([
    "-i",
    `concat:${files.map((f) => `file '${f}'`).join("|")}`,
    "-c",
    "copy",
    "-encryption_scheme",
    "none", // ou spécifique si besoin
    "-decryption_key",
    keyHex, // clé hex sans 0x
    filename,
  ]);

  const data = await ffmpeg.readFile(filename);
  const blob = new Blob([data.buffer], { type: "video/mp4" });

  triggerBlobDownload(blob, filename);
  emitHlsProgress(jobId, 100, "MP4 décrypté & sauvegardé");

  // Cleanup
  files.forEach((f) => ffmpeg.unlink(f));
  ffmpeg.unlink(filename);

  return { ok: true, size: blob.size };
}

// Ajoute au listener onMessage
if (message.type === "decrypt-hls-with-key") {
  decryptAndDownloadHLS(message)
    .then((r) => sendResponse({ ok: true, result: r }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
}

function absoluteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") {
    return "";
  }
  if (rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")) {
    return rawUrl;
  }
  try {
    return new URL(rawUrl, window.location.href).toString();
  } catch {
    return "";
  }
}

function resolveUrl(base, rawUrl) {
  try {
    return new URL(rawUrl, base).toString();
  } catch {
    return rawUrl || "";
  }
}

function getExtension(rawUrl) {
  try {
    const parsed = new URL(rawUrl, window.location.href);
    const index = parsed.pathname.lastIndexOf(".");
    if (index < 0) {
      return "";
    }
    return parsed.pathname.slice(index + 1).toLowerCase();
  } catch {
    return "";
  }
}

function classifyCandidate(url) {
  if (!url) {
    return "unknown";
  }
  if (url.startsWith("blob:")) {
    return "blob";
  }
  const ext = getExtension(url);
  if (ext === "m3u8") {
    return "hls";
  }
  if (ext === "mpd") {
    return "dash";
  }
  if (VIDEO_FILE_EXTENSIONS.has(ext)) {
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
  const ext = getExtension(url);
  if (VIDEO_FILE_EXTENSIONS.has(ext) || ext === "m3u8" || ext === "mpd") {
    return true;
  }
  const lower = url.toLowerCase();
  return (
    lower.includes("mime=video") ||
    lower.includes("type=video") ||
    lower.includes("format=mp4") ||
    lower.includes(".m3u8") ||
    lower.includes(".mpd")
  );
}

function makeCandidate(url, source, extra = {}) {
  return {
    url,
    kind: classifyCandidate(url),
    source,
    pageUrl: window.location.href,
    pageTitle: document.title || "",
    ...extra,
  };
}

function collectFromVideoElements(result) {
  const videos = document.querySelectorAll("video");
  videos.forEach((video, index) => {
    const urls = new Set();
    if (video.currentSrc) {
      urls.add(video.currentSrc);
    }
    if (video.src) {
      urls.add(video.src);
    }

    video.querySelectorAll("source").forEach((source) => {
      if (source.src) {
        urls.add(source.src);
      }
      const attrSrc = source.getAttribute("src");
      if (attrSrc) {
        urls.add(attrSrc);
      }
    });

    const attrSrc = video.getAttribute("src");
    if (attrSrc) {
      urls.add(attrSrc);
    }

    urls.forEach((rawUrl) => {
      const url = absoluteUrl(rawUrl);
      if (!url || !isLikelyMediaUrl(url)) {
        return;
      }
      result.set(url, makeCandidate(url, "dom:video", { elementIndex: index }));
    });
  });
}

function collectFromCommonNodes(result) {
  const selectors = [
    "a[href]",
    "link[href]",
    "meta[property='og:video']",
    "meta[property='og:video:url']",
    "meta[property='twitter:player:stream']",
    "[data-video-url]",
    "[data-src]",
  ];

  document.querySelectorAll(selectors.join(",")).forEach((node) => {
    const values = [];
    const href = node.getAttribute("href");
    const content = node.getAttribute("content");
    const dataVideoUrl = node.getAttribute("data-video-url");
    const dataSrc = node.getAttribute("data-src");
    if (href) {
      values.push(href);
    }
    if (content) {
      values.push(content);
    }
    if (dataVideoUrl) {
      values.push(dataVideoUrl);
    }
    if (dataSrc) {
      values.push(dataSrc);
    }

    values.forEach((rawUrl) => {
      const url = absoluteUrl(rawUrl);
      if (!url || !isLikelyMediaUrl(url)) {
        return;
      }
      result.set(url, makeCandidate(url, "dom:meta"));
    });
  });
}

function collectFromJsonLd(result) {
  document
    .querySelectorAll("script[type='application/ld+json']")
    .forEach((scriptTag) => {
      const raw = scriptTag.textContent || "";
      if (!raw.includes("contentUrl") && !raw.includes("embedUrl")) {
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const stack = [parsed];
        while (stack.length > 0) {
          const item = stack.pop();
          if (!item) {
            continue;
          }
          if (Array.isArray(item)) {
            stack.push(...item);
            continue;
          }
          if (typeof item !== "object") {
            continue;
          }
          ["contentUrl", "embedUrl", "url"].forEach((field) => {
            const rawUrl = item[field];
            if (typeof rawUrl !== "string") {
              return;
            }
            const url = absoluteUrl(rawUrl);
            if (!url || !isLikelyMediaUrl(url)) {
              return;
            }
            result.set(url, makeCandidate(url, "dom:jsonld"));
          });
          Object.values(item).forEach((child) => stack.push(child));
        }
      } catch {
        // Ignore malformed json-ld payloads.
      }
    });
}

function collectFromPerformance(result) {
  try {
    const entries = performance.getEntriesByType("resource");
    entries.forEach((entry) => {
      if (!entry?.name) {
        return;
      }
      const kind = entry.initiatorType || "";
      if (
        !["video", "audio", "xmlhttprequest", "fetch", "other"].includes(
          kind,
        ) &&
        !isLikelyMediaUrl(entry.name)
      ) {
        return;
      }
      const url = absoluteUrl(entry.name);
      if (!url || !isLikelyMediaUrl(url)) {
        return;
      }
      result.set(url, makeCandidate(url, `perf:${kind || "resource"}`));
    });
  } catch {
    // Some pages block resource timing access.
  }
}

function syncCandidates(candidates) {
  if (!candidates.length) {
    return;
  }
  chrome.runtime.sendMessage({
    type: "upsertCandidates",
    candidates,
  });
}

function scanAndSync() {
  const map = new Map();
  collectFromVideoElements(map);
  collectFromCommonNodes(map);
  collectFromJsonLd(map);
  collectFromPerformance(map);
  syncCandidates([...map.values()]);
}

let scanTimer = null;
function scheduleScan(delay = 450) {
  if (scanTimer) {
    clearTimeout(scanTimer);
  }
  scanTimer = setTimeout(() => {
    scanAndSync();
  }, delay);
}

async function downloadBlobFromPage(url, filename) {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename || "video.webm";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
    return { ok: true };
  } catch (error) {
    try {
      const fallback = document.createElement("a");
      fallback.href = url;
      fallback.download = filename || "video";
      fallback.style.display = "none";
      document.body.append(fallback);
      fallback.click();
      fallback.remove();
      return { ok: true };
    } catch {
      return { ok: false, error: error.message };
    }
  }
}

async function fetchTextFromPage(url) {
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
  const match = (rawResolution || "").match(/(\d+)x(\d+)/i);
  if (!match) {
    return { width: 0, height: 0 };
  }
  return {
    width: Number.parseInt(match[1], 10) || 0,
    height: Number.parseInt(match[2], 10) || 0,
  };
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
      const attrs = parseAttributeList(line.split(":").slice(1).join(":"));
      let variantPath = "";
      for (let next = index + 1; next < lines.length; next += 1) {
        if (!lines[next].startsWith("#")) {
          variantPath = lines[next];
          index = next;
          break;
        }
      }
      if (!variantPath) {
        continue;
      }
      const resolution = parseResolution(attrs.RESOLUTION || "");
      const bandwidth =
        Number.parseInt(
          attrs.BANDWIDTH || attrs.AVERAGE_BANDWIDTH || "0",
          10,
        ) || 0;
      variants.push({
        url: resolveUrl(manifestUrl, variantPath),
        bandwidth,
        width: resolution.width,
        height: resolution.height,
      });
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
      segments: [],
      initSegmentUrl: "",
    };
  }

  const segments = [];
  let initSegmentUrl = "";

  lines.forEach((line) => {
    if (line.startsWith("#EXT-X-MAP")) {
      const attrs = parseAttributeList(line.split(":").slice(1).join(":"));
      if (attrs.URI) {
        initSegmentUrl = resolveUrl(manifestUrl, attrs.URI);
      }
      return;
    }

    if (line.startsWith("#")) {
      return;
    }

    const segmentUrl = resolveUrl(manifestUrl, line);
    if (segmentUrl) {
      segments.push(segmentUrl);
    }
  });

  return {
    isMaster: false,
    encrypted,
    variants: [],
    initSegmentUrl,
    segments,
  };
}

async function fetchArrayBufferWithRetry(url, attempts = 2) {
  let lastError = null;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.arrayBuffer();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        // wait before retry
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) =>
          setTimeout(resolve, 200 * (attempt + 1)),
        );
      }
    }
  }
  throw lastError || new Error("Failed to fetch segment");
}

function emitHlsProgress(jobId, progressPercent, progressLabel) {
  chrome.runtime.sendMessage({
    type: "hlsProgress",
    jobId,
    progressPercent,
    progressLabel,
  });
}

function triggerBlobDownload(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename || "video.ts";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 20_000);
}

/*async function downloadHlsFromPage(payload) {
  const jobId = payload.jobId;
  const manifestUrl = payload.manifestUrl;
  const selectedVariantUrl = payload.selectedVariantUrl || "";
  const filename =
    (payload.filename || "video_complet").replace(/\.[^/.]+$/, "") + ".mp4"; // force .mp4

  emitHlsProgress(jobId, 2, "Lecture playlist m3u8...");

  // Charger manifests
  const manifestText = await fetchTextFromPage(manifestUrl);
  const manifest = parseHlsManifest(manifestUrl, manifestText);

  if (manifest.encrypted) {
    throw new Error("Stream chiffré – active God Mode pour la clé");
  }

  let mediaPlaylistUrl = manifestUrl;
  let mediaPlaylist = manifest;

  if (manifest.isMaster) {
    if (!manifest.variants.length)
      throw new Error("Aucune variante dans master");
    mediaPlaylistUrl = selectedVariantUrl || manifest.variants[0].url;
    emitHlsProgress(jobId, 5, "Chargement qualité...");
    const mediaText = await fetchTextFromPage(mediaPlaylistUrl);
    mediaPlaylist = parseHlsManifest(mediaPlaylistUrl, mediaText);
    if (mediaPlaylist.encrypted) throw new Error("Variante chiffrée");
  }

  const segmentUrls = [];
  if (mediaPlaylist.initSegmentUrl)
    segmentUrls.push(mediaPlaylist.initSegmentUrl);
  segmentUrls.push(...mediaPlaylist.segments);

  if (!segmentUrls.length) throw new Error("Aucun segment");
  if (segmentUrls.length > 1200)
    throw new Error("Trop de segments – limite RAM");

  emitHlsProgress(
    jobId,
    10,
    `Téléchargement ${segmentUrls.length} segments...`,
  );

  const ffmpeg = await loadFFmpeg();

  let totalBytes = 0;
  const files = [];

  // Fetch & write chaque segment dans FS virtuel
  for (let i = 0; i < segmentUrls.length; i++) {
    const url = segmentUrls[i];
    try {
      const ab = await fetchArrayBufferWithRetry(url, 3);
      const name = `seg_${i}.ts`;
      await ffmpeg.writeFile(name, new Uint8Array(ab));
      files.push(name);
      totalBytes += ab.byteLength;

      if (i % 10 === 0 || i === segmentUrls.length - 1) {
        emitHlsProgress(
          jobId,
          10 + Math.round((80 * i) / segmentUrls.length),
          `${i + 1}/${segmentUrls.length} (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)`,
        );
      }
    } catch (err) {
      throw new Error(`Segment ${i + 1} fail: ${err.message}`);
    }
  }

  emitHlsProgress(jobId, 92, "Conversion en MP4 (remux sans ré-encodage)...");

  // Remux en MP4
  await ffmpeg.exec([
    "-i",
    `concat:${files.map((f) => `file '${f}'`).join("|")}`,
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-bsf:a",
    "aac_adtstoasc", // fixe audio AAC si besoin
    "-movflags",
    "+faststart", // metadata au début → seek instantané
    filename,
  ]);

  const mp4Data = await ffmpeg.readFile(filename);
  const blob = new Blob([mp4Data.buffer], { type: "video/mp4" });

  triggerBlobDownload(blob, filename);
  emitHlsProgress(
    jobId,
    100,
    `MP4 téléchargé – ${(blob.size / 1024 / 1024).toFixed(2)} MiB`,
  );

  // Nettoyage FS pour éviter fuite mémoire
  files.forEach((f) => ffmpeg.unlink(f));
  ffmpeg.unlink(filename);

  return {
    ok: true,
    segmentCount: segmentUrls.length,
    bytes: blob.size,
    format: "mp4",
  };
}*/

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "scanNow") {
    scanAndSync();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "downloadBlobFromPage") {
    downloadBlobFromPage(message.url, message.filename).then(sendResponse);
    return true;
  }

  if (message.type === "fetchTextFromPage") {
    fetchTextFromPage(message.url)
      .then((text) => {
        sendResponse({ ok: true, text });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "downloadHlsFromPage") {
    // On force TOUJOURS le remux MP4 avec la fonction unifiée
    assembleHlsToMp4({
      jobId: message.jobId,
      manifestUrl: message.manifestUrl,
      selectedVariantUrl: message.selectedVariantUrl || "",
      keyInfo: message.keyInfo || null, // si tu as une clé depuis God Mode
      filename:
        (message.filename || "video_complet").replace(/\.[^/.]+$/, "") + ".mp4",
    })
      .then((r) => sendResponse({ ok: true, result: r }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return undefined;
});

function handleInjectedMessage(event) {
  if (
    event.source !== window ||
    !event.data ||
    event.data.source !== "vided-injected"
  ) {
    return;
  }
  const url = absoluteUrl(event.data.url || "");
  if (!url || !isLikelyMediaUrl(url)) {
    return;
  }
  syncCandidates([
    makeCandidate(url, `inject:${event.data.channel || "unknown"}`),
  ]);
}

function injectPageProbe() {
  const id = "vided-injected-probe";
  if (document.getElementById(id)) {
    return;
  }
  const script = document.createElement("script");
  script.id = id;
  script.src = chrome.runtime.getURL("injected.js");
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

window.addEventListener("message", handleInjectedMessage, false);

const observer = new MutationObserver(() => scheduleScan(300));
observer.observe(document.documentElement || document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "href", "content", "data-video-url", "data-src"],
});

injectPageProbe();
scheduleScan(150);
window.addEventListener("load", () => scheduleScan(300));

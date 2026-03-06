const statusEl = document.getElementById("status");
const listEl = document.getElementById("candidateList");
const jobListEl = document.getElementById("jobList");
const pageLabelEl = document.getElementById("pageLabel");
const jobsMetaEl = document.getElementById("jobsMeta");
const saveAsToggleEl = document.getElementById("saveAsToggle");
const hlsModeSelectEl = document.getElementById("hlsModeSelect");
const rescanBtn = document.getElementById("rescanBtn");
const downloadAllBtn = document.getElementById("downloadAllBtn");
const refreshJobsBtn = document.getElementById("refreshJobsBtn");
const clearJobsBtn = document.getElementById("clearJobsBtn");
const itemTemplate = document.getElementById("itemTemplate");
const jobTemplate = document.getElementById("jobTemplate");

const SETTINGS_KEY = "videdPopupSettings";

let activeTab = null;
let candidates = [];
let jobs = [];
let jobsMeta = { activeJobs: 0, queuedJobs: 0 };
let jobsPollTimer = null;
let jobsRefreshScheduled = false;
const hlsAnalysisByUrl = new Map();

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#b12f2f" : "#39415a";
}

function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    const path =
      parsed.pathname.length > 45
        ? `...${parsed.pathname.slice(-45)}`
        : parsed.pathname;
    return `${parsed.host}${path}${parsed.search ? "?" : ""}`;
  } catch {
    return url.length > 72 ? `${url.slice(0, 72)}...` : url;
  }
}

function sanitizeFilename(title) {
  return (title || "video")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 100);
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url || "";
  }
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function sendToActiveTab(message) {
  if (!activeTab?.id) {
    return { ok: false, error: "Onglet actif introuvable." };
  }
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch (error) {
    return {
      ok: false,
      error:
        error?.message ||
        "Impossible de contacter le script de la page. Recharge la page et réessaie.",
    };
  }
}

function saveSettings() {
  const payload = {
    saveAs: Boolean(saveAsToggleEl.checked),
    hlsMode: hlsModeSelectEl.value || "assemble",
  };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    saveAsToggleEl.checked = Boolean(parsed.saveAs);
    if (parsed.hlsMode === "manifest" || parsed.hlsMode === "assemble") {
      hlsModeSelectEl.value = parsed.hlsMode;
    }
  } catch {
    // Ignore malformed local settings.
  }
}

async function getActiveTab() {
  const response = await send({ type: "getActiveTab" });
  return response?.tab || null;
}

function getDefaultVariantUrl(candidate) {
  if (candidate.kind !== "hls") {
    return "";
  }
  const cached = hlsAnalysisByUrl.get(normalizeUrl(candidate.url));
  if (cached?.bestVariant?.url) {
    return cached.bestVariant.url;
  }
  return "";
}

function getModeForCandidate(candidate) {
  if (candidate.kind === "hls") {
    return hlsModeSelectEl.value || "assemble";
  }
  return "direct";
}

async function startDownloadJob(candidate, selectedVariantUrl = "") {
  if (!activeTab?.id) {
    setStatus("Onglet actif introuvable.", true);
    return false;
  }

  if (candidate.kind === "hls") {
    const response = await sendToActiveTab({
      type: "downloadHlsFromPage",
      jobId: Date.now(),
      manifestUrl: candidate.url,
      selectedVariantUrl: selectedVariantUrl,
      keyInfo: selectedKey
        ? { kid: selectedKey.kid, key: selectedKey.key }
        : null,
      filename: `${sanitizeFilename(candidate.pageTitle || "video")}.mp4`,
    });

    if (!response?.ok) {
      const errMsg = response?.error || "Erreur inconnue (vérifie console)";
      console.error("=== ERREUR MP4 ===", errMsg);
      const hint = errMsg.includes("FFmpeg asset")
        ? " Vérifie que ffmpeg-core.js/.wasm/.worker.js ne sont pas vides puis recharge l'extension."
        : "";
      setStatus("Échec MP4 : " + errMsg + hint, true);
      return false;
    }

    if (response?.result?.format === "ts") {
      setStatus("FFmpeg indisponible: export TS de secours lancé.", true);
    } else {
      setStatus(`MP4 en création... (vérifie les téléchargements)`);
    }
    scheduleJobsRefresh();
    return true;
  }

  // Pour les autres types (mp4 direct, etc.)
  const mode = getModeForCandidate(candidate);
  const response = await send({
    type: "startDownloadJob",
    tabId: activeTab.id,
    candidate,
    mode,
    selectedVariantUrl,
    saveAs: saveAsToggleEl.checked,
  });

  if (!response?.ok) {
    setStatus(response?.error || "Échec du job.", true);
    return false;
  }
  setStatus(`Job #${response.job.id} ajouté.`);
  scheduleJobsRefresh();
  return true;
}

async function analyzeHls(candidate, forceRefresh = false) {
  if (!activeTab?.id) {
    setStatus("Onglet actif introuvable.", true);
    return null;
  }
  setStatus("Analyse HLS en cours...");
  const response = await send({
    type: "analyzeHls",
    tabId: activeTab.id,
    url: candidate.url,
    forceRefresh,
  });
  if (!response?.ok) {
    setStatus(response?.error || "Analyse HLS impossible.", true);
    return null;
  }
  const analysis = response.analysis;
  hlsAnalysisByUrl.set(normalizeUrl(candidate.url), analysis);
  if (analysis.encrypted) {
    setStatus("Playlist HLS chiffree detectee: telechargement bloque.");
  } else if (analysis.isMaster) {
    setStatus(`Analyse HLS terminee: ${analysis.variants.length} qualites.`);
  } else {
    setStatus(`Analyse HLS terminee: ${analysis.segmentCount} segments.`);
  }
  return analysis;
}

async function loadCandidates() {
  if (!activeTab?.id) {
    candidates = [];
    renderCandidates();
    return;
  }
  const response = await send({ type: "getCandidates", tabId: activeTab.id });
  candidates = response?.candidates || [];
  candidates.forEach((candidate) => {
    if (candidate.kind === "hls" && candidate.hls?.analyzedAt) {
      hlsAnalysisByUrl.set(normalizeUrl(candidate.url), {
        analyzedAt: candidate.hls.analyzedAt,
        isMaster: candidate.hls.isMaster,
        encrypted: candidate.hls.encrypted,
        variants: [],
        bestVariant: candidate.hls.bestVariant || null,
        segmentCount: candidate.hls.segmentCount || 0,
      });
    }
  });
  renderCandidates();
}

function buildCandidateMeta(candidate) {
  const parts = [];
  parts.push(`Score ${candidate.score || 0}`);
  parts.push(`Hits ${candidate.hitCount || 1}`);
  if (candidate.kind === "hls" && candidate.hls) {
    if (candidate.hls.isMaster) {
      parts.push(`${candidate.hls.variantCount || 0} qualites`);
    } else if (candidate.hls.segmentCount) {
      parts.push(`${candidate.hls.segmentCount} segments`);
    }
    if (candidate.hls.encrypted) {
      parts.push("encrypted");
    }
  }
  return parts.join(" | ");
}

function renderVariantList(container, candidate, analysis) {
  container.innerHTML = "";
  if (!analysis) {
    return;
  }

  if (analysis.encrypted) {
    const row = document.createElement("li");
    row.className = "variantItem";
    row.textContent = "Playlist chiffree (non supportee)";
    container.appendChild(row);
    return;
  }

  if (
    analysis.isMaster &&
    Array.isArray(analysis.variants) &&
    analysis.variants.length > 0
  ) {
    analysis.variants.forEach((variant) => {
      const item = document.createElement("li");
      item.className = "variantItem";

      const label = document.createElement("span");
      label.className = "variantLabel";
      const quality = variant.height ? `${variant.height}p` : "auto";
      const bitrate = variant.bandwidth
        ? `${Math.round(variant.bandwidth / 1000)} kbps`
        : "bitrate ?";
      label.textContent = `${quality} - ${bitrate}`;

      const btn = document.createElement("button");
      btn.className = "btn tiny secondary";
      btn.textContent = "Telecharger";
      btn.addEventListener("click", () =>
        startDownloadJob(candidate, variant.url),
      );

      item.append(label, btn);
      container.appendChild(item);
    });
    return;
  }

  const single = document.createElement("li");
  single.className = "variantItem";
  const label = document.createElement("span");
  label.className = "variantLabel";
  label.textContent = `${analysis.segmentCount || 0} segments detectes`;
  const btn = document.createElement("button");
  btn.className = "btn tiny secondary";
  btn.textContent = "Telecharger";
  btn.addEventListener("click", () => startDownloadJob(candidate, ""));
  single.append(label, btn);
  container.appendChild(single);
}

function renderCandidates() {
  listEl.innerHTML = "";
  if (!candidates.length) {
    const empty = document.createElement("li");
    empty.className = "item";
    empty.textContent =
      "Aucune video detectee. Lance la lecture puis clique sur Rescanner.";
    listEl.appendChild(empty);
    return;
  }

  candidates.forEach((candidate) => {
    const node = itemTemplate.content.firstElementChild.cloneNode(true);
    const kindEl = node.querySelector(".kind");
    const sourceEl = node.querySelector(".source");
    const urlEl = node.querySelector(".url");
    const metaEl = node.querySelector(".meta");
    const downloadBtn = node.querySelector(".downloadBtn");
    const analyzeBtn = node.querySelector(".analyzeBtn");
    const copyBtn = node.querySelector(".copyBtn");
    const variantList = node.querySelector(".variantList");

    kindEl.textContent = candidate.kind || "unknown";
    sourceEl.textContent = candidate.source || "source inconnue";
    urlEl.textContent = shortenUrl(candidate.url || "");
    metaEl.textContent = buildCandidateMeta(candidate);

    downloadBtn.addEventListener("click", () => {
      const selectedVariantUrl = getDefaultVariantUrl(candidate);
      startDownloadJob(candidate, selectedVariantUrl);
    });

    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(candidate.url);
        setStatus("URL copiee dans le presse-papiers.");
      } catch {
        setStatus("Impossible de copier l URL.", true);
      }
    });

    if (candidate.kind === "hls") {
      analyzeBtn.style.display = "";
      analyzeBtn.addEventListener("click", async () => {
        const analysis = await analyzeHls(candidate, true);
        if (analysis) {
          renderVariantList(variantList, candidate, analysis);
        }
      });
      const cachedAnalysis = hlsAnalysisByUrl.get(normalizeUrl(candidate.url));
      if (
        cachedAnalysis &&
        (!cachedAnalysis.isMaster || (cachedAnalysis.variants || []).length > 0)
      ) {
        renderVariantList(variantList, candidate, cachedAnalysis);
      }
    } else {
      analyzeBtn.style.display = "none";
    }

    listEl.appendChild(node);
  });
}

function formatJobStatus(job) {
  if (job.status === "completed") {
    return "completed";
  }
  if (job.status === "failed") {
    return "failed";
  }
  if (job.status === "running") {
    return "running";
  }
  return "queued";
}

function renderJobs() {
  jobsMetaEl.textContent = `${jobsMeta.activeJobs || 0} actif(s), ${jobsMeta.queuedJobs || 0} en file`;
  jobListEl.innerHTML = "";

  if (!jobs.length) {
    const empty = document.createElement("li");
    empty.className = "jobItem";
    empty.textContent = "Aucun job pour le moment.";
    jobListEl.appendChild(empty);
    return;
  }

  jobs.slice(0, 40).forEach((job) => {
    const node = jobTemplate.content.firstElementChild.cloneNode(true);
    const statusElLocal = node.querySelector(".jobStatus");
    const modeEl = node.querySelector(".jobMode");
    const titleEl = node.querySelector(".jobTitle");
    const infoEl = node.querySelector(".jobInfo");
    const barEl = node.querySelector(".progressFill");

    const status = formatJobStatus(job);
    statusElLocal.textContent = status;
    statusElLocal.style.color =
      status === "completed"
        ? "#1c8f43"
        : status === "failed"
          ? "#b12f2f"
          : status === "running"
            ? "#0c63ff"
            : "#56607f";
    modeEl.textContent = job.mode || "direct";

    const titleSource = job.filename || job.candidate?.url || "";
    titleEl.textContent = shortenUrl(titleSource);

    const infoParts = [];
    if (job.progressLabel) {
      infoParts.push(job.progressLabel);
    }
    if (job.error) {
      infoParts.push(job.error);
    }
    infoEl.textContent = infoParts.join(" | ") || "Waiting";

    const progress = Math.max(
      0,
      Math.min(100, Number(job.progressPercent) || 0),
    );
    barEl.style.width = `${progress}%`;

    jobListEl.appendChild(node);
  });
}

async function loadJobs() {
  if (!activeTab?.id) {
    jobs = [];
    jobsMeta = { activeJobs: 0, queuedJobs: 0 };
    renderJobs();
    return;
  }
  const response = await send({ type: "getJobs", tabId: activeTab.id });
  jobs = response?.jobs || [];
  jobsMeta = {
    activeJobs: response?.activeJobs || 0,
    queuedJobs: response?.queuedJobs || 0,
  };
  renderJobs();
}

function scheduleJobsRefresh() {
  if (jobsRefreshScheduled) {
    return;
  }
  jobsRefreshScheduled = true;
  setTimeout(() => {
    jobsRefreshScheduled = false;
    loadJobs().catch((error) => {
      setStatus(`Erreur jobs: ${error.message}`, true);
    });
  }, 140);
}

async function rescan() {
  if (!activeTab?.id) {
    setStatus("Onglet actif introuvable.", true);
    return;
  }
  setStatus("Rescan en cours...");
  const response = await send({ type: "rescanTab", tabId: activeTab.id });
  if (!response?.ok) {
    setStatus(response?.error || "Impossible de rescanner cet onglet.", true);
    return;
  }
  await loadCandidates();
  setStatus(`${candidates.length} video(s) detectee(s).`);
}

async function downloadAll() {
  if (!activeTab?.id) {
    setStatus("Onglet actif introuvable.", true);
    return;
  }
  if (!candidates.length) {
    setStatus("Aucune URL telechargeable.");
    return;
  }

  let queued = 0;
  for (const candidate of candidates) {
    const selectedVariantUrl = getDefaultVariantUrl(candidate);
    // eslint-disable-next-line no-await-in-loop
    const ok = await startDownloadJob(candidate, selectedVariantUrl);
    if (ok) {
      queued += 1;
    }
  }
  setStatus(`${queued} job(s) ajoute(s).`);
}

async function clearFinishedJobs() {
  const response = await send({ type: "clearFinishedJobs" });
  if (!response?.ok) {
    setStatus("Impossible de nettoyer les jobs.", true);
    return;
  }
  setStatus(`${response.removed || 0} job(s) nettoye(s).`);
  await loadJobs();
}

function bindRuntimeListeners() {
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "jobUpdated" || message.type === "jobsMeta") {
      scheduleJobsRefresh();
    }
  });
}

function startPolling() {
  if (jobsPollTimer) {
    clearInterval(jobsPollTimer);
  }
  jobsPollTimer = setInterval(() => {
    loadJobs().catch(() => {});
  }, 1700);
}
const activateDrmBtn = document.getElementById("activateDrmBtn");
const drmStatus = document.getElementById("drmStatus");
const keysList = document.getElementById("keysList");
// Exemple dans le listener du bouton Télécharger HLS
// Charge les clés stockées au démarrage
async function loadStoredKeys() {
  const { widevineKeys = [] } = await chrome.storage.local.get("widevineKeys");
  renderKeys(widevineKeys);
}

function renderKeys(keysArray) {
  keysList.innerHTML = "";
  if (!keysArray.length) {
    drmStatus.textContent = "Aucune clé capturée. Lance une vidéo DRM.";
    return;
  }

  drmStatus.textContent = `${keysArray.length} clé(s) trouvée(s)`;

  keysArray.forEach((entry) => {
    const li = document.createElement("li");
    li.style.padding = "8px";
    li.style.background = "#2c3e50";
    li.style.borderRadius = "6px";
    li.style.marginBottom = "6px";
    li.style.fontSize = "11px";

    li.innerHTML = `
      <strong>${new Date(entry.timestamp).toLocaleTimeString()}</strong> – ${shortenUrl(entry.url)}<br>
      PSSH: ${entry.pssh.slice(0, 32)}...<br>
      <strong>Clés :</strong>
    `;

    entry.keys.forEach((k) => {
      const keySpan = document.createElement("div");
      keySpan.textContent = `KID: ${k.kid} → KEY: ${k.key}`;
      keySpan.style.wordBreak = "break-all";
      keySpan.style.cursor = "pointer";
      keySpan.title = "Clique pour copier KID:KEY";
      keySpan.addEventListener("click", () => {
        navigator.clipboard.writeText(`${k.kid}:${k.key}`);
        setStatus("Clé copiée : " + k.kid + ":" + k.key);
      });
      li.appendChild(keySpan);
    });

    keysList.appendChild(li);
  });
}

// Bouton activation manuelle
activateDrmBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "activate-drm-god" });
  drmStatus.textContent = "Hijacker activé manuellement – relance la vidéo";
});

// Écoute les updates live
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "keys-updated") {
    loadStoredKeys(); // refresh
    setStatus("Nouvelle(s) clé(s) capturée(s) !");
  }
});

async function init() {
  loadSettings();
  bindRuntimeListeners();

  activeTab = await getActiveTab();
  if (!activeTab?.id) {
    pageLabelEl.textContent = "Aucun onglet actif.";
    setStatus("Ouvre un site avec une video pour commencer.");
    renderCandidates();
    renderJobs();
    return;
  }

  pageLabelEl.textContent = activeTab.url || activeTab.title || "Onglet";
  await Promise.all([loadCandidates(), loadJobs()]);
  setStatus(`${candidates.length} video(s) detectee(s).`);
  startPolling();
  await loadStoredKeys();
}

window.addEventListener("beforeunload", () => {
  if (jobsPollTimer) {
    clearInterval(jobsPollTimer);
  }
});

saveAsToggleEl.addEventListener("change", saveSettings);
hlsModeSelectEl.addEventListener("change", saveSettings);
rescanBtn.addEventListener("click", rescan);
downloadAllBtn.addEventListener("click", downloadAll);
refreshJobsBtn.addEventListener("click", () => loadJobs());
clearJobsBtn.addEventListener("click", clearFinishedJobs);

init().catch((error) => {
  setStatus(`Erreur: ${error.message}`, true);
});

const decryptBtn = document.getElementById("decryptBtn");
let selectedKey = null; // {kid, key} sélectionnée

// Quand une clé est cliquée dans la liste, active le bouton
keysList.addEventListener("click", (e) => {
  if (e.target.tagName === "DIV" && e.target.textContent.includes("KID:")) {
    const text = e.target.textContent;
    const [kidPart, keyPart] = text.split(" → ");
    selectedKey = {
      kid: kidPart.replace("KID: ", ""),
      key: keyPart.replace("KEY: ", ""),
    };
    decryptBtn.style.display = "block";
    decryptBtn.textContent = `Décrypter avec ${selectedKey.kid.slice(0, 8)}...`;
  }
});
decryptBtn.addEventListener("click", async () => {
  if (!selectedKey || !candidates.length) return;

  const hlsCandidate = candidates.find((c) => c.kind === "hls");
  if (!hlsCandidate) {
    setStatus("Aucun HLS trouvé", true);
    return;
  }

  setStatus("Décryptage + MP4 en cours...");

  const response = await sendToActiveTab({
    type: "downloadHlsFromPage", // ← même flux que le téléchargement normal
    jobId: Date.now(),
    manifestUrl: hlsCandidate.url,
    keyInfo: selectedKey,
    filename: `decrypted_${Date.now()}.mp4`,
  });

  if (response?.ok) {
    if (response?.result?.format === "ts") {
      setStatus("Décryptage impossible en MP4: export TS de secours effectué.", true);
    } else {
      setStatus(`Décrypté et converti en MP4 !`);
    }
  } else {
    setStatus("Erreur : " + (response.error || "inconnue"), true);
  }
});

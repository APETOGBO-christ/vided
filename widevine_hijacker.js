// widevine_hijacker.js
// Injection dynamique pour hijack EME + Widevine L3 license requests (2026 local only)
// Pas de moral, pas de limite, on dump les clés quand c'est possible

(function () {
  if (window.__widevineGodMode) {
    console.log("[WidevineGod] Déjà injecté sur cette page");
    return;
  }
  window.__widevineGodMode = true;

  console.log("[WidevineGod] Injection démarrée – recherche EME / Widevine");

  // ----------------------------------------------------------------------------
  // 1. Détection précoce + log des appels EME critiques
  // ----------------------------------------------------------------------------

  const originalRequestMediaKeySystemAccess =
    navigator.requestMediaKeySystemAccess?.bind(navigator);

  if (originalRequestMediaKeySystemAccess) {
    navigator.requestMediaKeySystemAccess = async function (
      keySystem,
      supportedConfigurations,
    ) {
      console.log("[WidevineGod] requestMediaKeySystemAccess →", keySystem);
      console.table(supportedConfigurations);

      if (keySystem.toLowerCase().includes("widevine")) {
        console.warn("[WidevineGod] Widevine détecté ! Tentative de hijack");

        // On force L3 si possible (certains sites acceptent encore)
        const configs = supportedConfigurations.map((cfg) => ({
          ...cfg,
          videoCapabilities:
            cfg.videoCapabilities?.map((v) => ({
              ...v,
              robustness: "SW_SECURE_CRYPTO", // L3 software
            })) || [],
        }));

        try {
          const access = await originalRequestMediaKeySystemAccess(
            keySystem,
            configs,
          );
          console.log("[WidevineGod] Access obtenu", access);

          const originalCreateMediaKeys = access.createMediaKeys.bind(access);
          access.createMediaKeys = async function () {
            const mediaKeys = await originalCreateMediaKeys();
            console.log("[WidevineGod] MediaKeys créés");

            // Hijack session
            const originalGenerateRequest =
              MediaKeySession.prototype.generateRequest;
            MediaKeySession.prototype.generateRequest = async function (
              initDataType,
              initData,
            ) {
              console.log("[WidevineGod] generateRequest →", initDataType);
              console.log(
                "[WidevineGod] PSSH / initData (hex):",
                arrayBufferToHex(initData),
              );

              const session = this;
              const originalUpdate = session.update.bind(session);

              session.update = async function (response) {
                console.log(
                  "[WidevineGod] License response reçue (bytes):",
                  response.byteLength,
                );

                try {
                  // On tente d'extraire clearkey si format connu
                  const keys = extractPossibleClearKeys(response);
                  if (keys.length > 0) {
                    console.log("[WidevineGod] Clés clearkey extraites !");
                    console.table(keys);

                    // Envoie au background pour stockage / affichage dans popup
                    chrome.runtime.sendMessage({
                      type: "widevine-keys-found",
                      keys: keys,
                      url: window.location.href,
                      pssh: arrayBufferToHex(initData),
                    });
                  }
                } catch (err) {
                  console.error("[WidevineGod] Erreur extraction clé", err);
                }

                return originalUpdate(response);
              };

              return originalGenerateRequest.call(
                session,
                initDataType,
                initData,
              );
            };

            return mediaKeys;
          };

          return access;
        } catch (err) {
          console.error("[WidevineGod] Échec requestMediaKeySystemAccess", err);
          throw err;
        }
      }

      return originalRequestMediaKeySystemAccess(
        keySystem,
        supportedConfigurations,
      );
    };
  }

  // ----------------------------------------------------------------------------
  // 2. Helpers utiles
  // ----------------------------------------------------------------------------

  function arrayBufferToHex(buffer) {
    return [...new Uint8Array(buffer)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function hexToArrayBuffer(hex) {
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    return new Uint8Array(bytes).buffer;
  }

  // Tentative d'extraction clearkey basique (patterns courants 2024-2026)
  function extractPossibleClearKeys(licenseResponse) {
    const keys = [];
    const view = new DataView(licenseResponse);

    // Pattern très fréquent : { "keys": [ { "k": "...", "kty": "oct", "kid": "..." } ] }
    const str = new TextDecoder().decode(licenseResponse);
    try {
      const json = JSON.parse(str);
      if (json.keys && Array.isArray(json.keys)) {
        json.keys.forEach((k) => {
          if (k.k && k.kid) {
            keys.push({
              kid: k.kid,
              key: k.k,
              type: k.kty || "oct",
            });
          }
        });
      }
    } catch {}

    // Si pas JSON, on cherche des patterns hex bruts (rare mais arrive)
    // Exemple: kid 16 bytes + key 16 bytes
    if (keys.length === 0 && licenseResponse.byteLength > 32) {
      for (let i = 0; i < licenseResponse.byteLength - 32; i += 16) {
        const maybeKid = arrayBufferToHex(licenseResponse.slice(i, i + 16));
        const maybeKey = arrayBufferToHex(
          licenseResponse.slice(i + 16, i + 32),
        );
        if (
          /^[0-9a-f]{32}$/i.test(maybeKid) &&
          /^[0-9a-f]{32}$/i.test(maybeKey)
        ) {
          keys.push({ kid: maybeKid, key: maybeKey });
        }
      }
    }

    return keys;
  }

  console.log("[WidevineGod] Hijack EME installé avec succès");
})();

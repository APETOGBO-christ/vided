(function injectVidedProbe() {
  if (window.__videdProbeInstalled) {
    return;
  }
  window.__videdProbeInstalled = true;

  const VIDEO_EXTENSIONS = [".mp4", ".webm", ".m3u8", ".mpd", ".mov", ".mkv", ".m4v", ".ts"];

  function looksLikeMedia(url) {
    if (!url || typeof url !== "string") {
      return false;
    }
    if (url.startsWith("blob:")) {
      return true;
    }
    const lower = url.toLowerCase();
    if (VIDEO_EXTENSIONS.some((ext) => lower.includes(ext))) {
      return true;
    }
    return (
      lower.includes("mime=video") ||
      lower.includes("type=video") ||
      lower.includes("format=mp4") ||
      lower.includes("playlist") ||
      lower.includes("manifest")
    );
  }

  function emit(url, channel) {
    if (!looksLikeMedia(url)) {
      return;
    }
    window.postMessage(
      {
        source: "vided-injected",
        url,
        channel
      },
      "*"
    );
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(...args) {
      try {
        const request = args[0];
        if (typeof request === "string") {
          emit(request, "fetch");
        } else if (request && typeof request.url === "string") {
          emit(request.url, "fetch");
        }
      } catch {
        // Keep probe silent on fetch argument edge cases.
      }

      const responsePromise = originalFetch.apply(this, args);
      responsePromise
        .then((response) => {
          try {
            const contentType = response.headers?.get("content-type") || "";
            if (contentType.toLowerCase().startsWith("video/") || contentType.toLowerCase().includes("mpegurl")) {
              emit(response.url, "fetch-response");
            }
          } catch {
            // Ignore response parsing errors.
          }
        })
        .catch(() => {});
      return responsePromise;
    };
  }

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedXhrOpen(method, url, ...rest) {
    try {
      if (typeof url === "string") {
        emit(url, "xhr");
      }
    } catch {
      // Ignore probe errors to avoid page breakages.
    }
    return originalXhrOpen.call(this, method, url, ...rest);
  };

  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  if (srcDescriptor?.set && srcDescriptor?.get) {
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      configurable: true,
      enumerable: srcDescriptor.enumerable,
      get() {
        return srcDescriptor.get.call(this);
      },
      set(value) {
        try {
          emit(value, "media-src");
        } catch {
          // Keep silent.
        }
        return srcDescriptor.set.call(this, value);
      }
    });
  }

  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function patchedSetAttribute(name, value) {
    try {
      const tag = this.tagName;
      if ((tag === "VIDEO" || tag === "SOURCE") && name === "src") {
        emit(value, "set-attribute");
      }
      if (tag === "A" && name === "href") {
        emit(value, "set-attribute");
      }
    } catch {
      // Keep silent.
    }
    return originalSetAttribute.call(this, name, value);
  };
})();

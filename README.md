# Vided - Video Downloader (Non-DRM)

Extension Chrome/Edge (Manifest V3) pour detecter et telecharger des videos non protegees depuis des pages web.

## Ce que fait l'extension

- Detecte les URLs video via:
  - requetes reseau (`webRequest`)
  - scan DOM (`video`, `source`, `meta`, `json-ld`, liens)
  - script injecte (hook `fetch` / `XMLHttpRequest` / `src` media)
- Affiche les candidats dans un popup avec:
  - type (`file`, `hls`, `dash`, `blob`)
  - source de detection
  - score de fiabilite
  - actions `Telecharger`, `Analyser HLS` et `Copier URL`
- Analyse HLS a la demande:
  - detection `master` vs `media` playlist
  - extraction des variantes qualite/bitrate
  - selection d'une variante dans le popup
- Telechargement avec gestion de jobs:
  - file d'attente
  - progression
  - suivi des erreurs
- Mode HLS configurable:
  - `Assembler segments`: telecharge les segments non chiffres et genere un fichier local
  - `Telecharger manifest`: telecharge uniquement la playlist
- Lance les telechargements directs via API navigateur (`chrome.downloads`)
- Gere les URLs `blob:` via telechargement cote page (fallback utile sur certains lecteurs)

## Limites importantes

- Pas de contournement DRM (Widevine/FairPlay/PlayReady).
- HLS chiffre (`#EXT-X-KEY` avec methode differente de `NONE`) est explicitement bloque.
- L'assemblage HLS est en memoire (peut etre limite sur playlists tres longues).
- Le mode `Assembler segments` remuxe les segments HLS en MP4 via ffmpeg.wasm (selon compatibilite des codecs).
- DASH est detecte mais telecharge comme manifeste (`.mpd`) en mode direct.
- Certains sites peuvent bloquer ou expirer rapidement les URLs signees.

## Installation locale (mode dev)

1. Ouvre `chrome://extensions` (ou `edge://extensions`).
2. Active `Developer mode`.
3. Clique `Load unpacked`.
4. Selectionne ce dossier:

   `c:\\Users\\APETOGBO Ayao Christ\\OneDrive\\Bureau\\Projets\\Vided`

## Utilisation

1. Ouvre une page avec video.
2. Lance la lecture quelques secondes.
3. Ouvre le popup `Vided`.
4. Clique `Rescanner`.
5. Pour les liens HLS:
   - clique `Analyser HLS` pour afficher les qualites
   - choisis le mode `Assembler segments` ou `Telecharger manifest`
6. Clique `Telecharger` sur la ligne voulue, ou `Telecharger tout`.
7. Suis la progression dans la section `Jobs`.

## Structure

- `manifest.json`
- `background.js`
- `content.js`
- `injected.js`
- `popup.html`
- `popup.css`
- `popup.js`

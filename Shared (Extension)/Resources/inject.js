// Page world: keeps the preferred YouTube audio track active using the
// player's internal APIs (MSE playback). During AirPlay, YT switches the
// video element to a server-generated HLS master; we rewrite that master
// (preferred language only) and hand it back as a data URI.

(() => {
    "use strict";

    if (window.__airtubeLoaded) return;
    window.__airtubeLoaded = true;

    const DEBUG = false; // flip to true for verbose console diagnostics
    const log = DEBUG ? (...args) => console.log("[AirTube]", ...args) : () => {};
    const warn = (...args) => console.warn("[AirTube]", ...args);

    const DEFAULT_PREF = { lang: "original", hideDubbed: true };
    const POLL_INTERVAL = 500;
    const SWITCH_GRACE = 4000;
    const MIRROR_YT_STYLES = true; // sample YT's popup surface styling

    const NON_LANG_MARKERS = new Set([
        "account", "lang", "dubbed", "dubbed-auto", "auto", "original", "asc", "track",
    ]);

    let pref = { ...DEFAULT_PREF };
    let lastSwitch = null;
    let fullTracks = null; // { videoId, tracks } — last known list while APIs are live
    let lastSwappedLang = null;

    let btn = null;
    let menu = null;
    let menuTitle = null;
    let menuItems = null;
    let menuList = [];
    let uiRoot = null;

    const post = (type, payload) =>
        window.postMessage({ airtube: "page", type, payload }, window.location.origin);

    const getVideoElement = () =>
        document.querySelector("video.html5-main-video") || document.querySelector("video");

    log("loaded");

    const style = document.createElement("style");
    style.textContent = `
        .airtube-button {
            background-size: 24px 24px !important;
            background-repeat: no-repeat !important;
            background-position: center !important;
        }
        .airtube-menu {
            position: absolute;
            z-index: 2147483647;
            min-width: 220px;
            max-height: 55%;
            overflow-y: auto;
            padding: 8px 0;
            background: rgba(28, 28, 28, 0.65);
            -webkit-backdrop-filter: blur(32px) saturate(180%);
            backdrop-filter: blur(32px) saturate(180%);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
            font-family: "Roboto", Arial, sans-serif;
            text-align: left;
        }
        .airtube-title {
            padding: 4px 16px 8px;
            color: #aaa;
            font-size: 11px;
            letter-spacing: 0.5px;
            text-transform: uppercase;
        }
        .airtube-item {
            display: block;
            width: 100%;
            padding: 0 16px;
            border: 0;
            background: none;
            color: #eee;
            font-size: 13px;
            line-height: 36px;
            text-align: left;
            cursor: pointer;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .airtube-item:hover {
            background: rgba(255, 255, 255, 0.1);
        }
        .airtube-item.airtube-active {
            color: #fff;
            font-weight: 500;
        }
        .airtube-item::before {
            content: "";
            display: inline-block;
            width: 18px;
        }
        .airtube-item.airtube-active::before {
            content: "✓";
            font-weight: 400;
        }
        .ytp-autohide.airtube-menu-open .ytp-chrome-bottom,
        .ytp-autohide.airtube-menu-open .ytp-gradient-bottom {
            opacity: 1 !important;
        }
    `;
    (document.head || document.documentElement).appendChild(style);

    // --- HLS master filtering (AirPlay) ---
    // YT's AirPlay rebuild assigns a server-generated hls_variant master. Its
    // muxed variants carry YT-EXT-AUDIO-CONTENT-ID tags; the dub default wins
    // when unfiltered. We fetch the exact assigned URL (fresh signature), keep
    // only the preferred language's variants, and re-assign as a data URI.

    const isHlsMasterUrl = (url) =>
        /manifest\.googlevideo\.com\/api\/manifest\/hls_variant|\.m3u8/i.test(url);

    const attrValue = (line, name) => {
        const match = line.match(new RegExp(name + '="?([^",]+)'));
        return match ? match[1] : "";
    };

    const decodeB64Strings = (part) => {
        try {
            const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
            const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
            const binary = atob(padded);
            return binary.match(/[\x20-\x7e]{2,}/g) || [];
        } catch {
            return [];
        }
    };

    const variantInfo = (line) => {
        const contentId = attrValue(line, "YT-EXT-AUDIO-CONTENT-ID").toLowerCase();
        const xtags = attrValue(line, "YT-EXT-XTAGS");
        const strings = xtags ? decodeB64Strings(xtags) : [];
        const langKey = strings.indexOf("lang");
        const lang = (langKey >= 0 ? strings[langKey + 1] : contentId.split(".")[0]) || "";
        return {
            contentId,
            lang: lang.toLowerCase(),
            original: strings.includes("original"),
        };
    };

    const variantMatchesPref = (info) => {
        if (pref.lang === "original") return info.original;
        const wanted = pref.lang.toLowerCase();
        return (
            info.contentId === wanted ||
            info.lang.split("-")[0] === wanted.split(".")[0].split("-")[0]
        );
    };

    const filterMasterText = (text) => {
        if (!/^#EXTM3U/m.test(text)) return null;

        const lines = text.split("\n");
        if (lines.some((l) => l.startsWith("#EXT-X-MEDIA") && /TYPE=AUDIO/.test(l))) {
            return null; // audio-group master — leave untouched
        }

        const pairs = [];
        lines.forEach((line, index) => {
            if (line.startsWith("#EXT-X-STREAM-INF")) pairs.push({ start: index });
        });
        if (!pairs.length) return null;

        pairs.forEach((pair, idx) => {
            const end = idx + 1 < pairs.length ? pairs[idx + 1].start : lines.length;
            pair.body = [];
            for (let j = pair.start + 1; j < end; j++) {
                if (lines[j].startsWith("#")) break;
                pair.body.push(j);
            }
        });

        const infos = pairs.map((pair) => ({ pair, info: variantInfo(lines[pair.start]) }));
        const kept = new Set();
        const keep = ({ pair }) => {
            kept.add(pair.start);
            pair.body.forEach((j) => kept.add(j));
        };

        infos.filter(({ info }) => variantMatchesPref(info)).forEach(keep);
        const keptCount = infos.filter(({ pair }) => kept.has(pair.start)).length;

        if (!keptCount) {
            warn("no variants match preference — leaving master untouched");
            return null;
        }

        const out = [];
        let pairAt = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith("#EXT-X-STREAM-INF")) {
                pairAt = infos.find((x) => x.pair.start === i);
                if (kept.has(i)) out.push(line);
                continue;
            }
            if (pairAt) {
                if (line.startsWith("#")) {
                    pairAt = null;
                    out.push(line);
                } else if (kept.has(i)) {
                    out.push(line);
                }
                continue;
            }
            out.push(line);
        }

        log(`master filtered: kept ${keptCount} of ${infos.length} variants (pref: ${pref.lang})`);
        return out.join("\n");
    };

    const toDataUri = (text) => {
        const bytes = new TextEncoder().encode(text);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return "data:application/vnd.apple.mpegurl;base64," + btoa(binary);
    };

    const masterTexts = new Map(); // url → manifest text
    const filteredCache = new Map(); // `${url}|${lang}` → data URI (or null)

    const filteredDataUri = async (url) => {
        const cacheKey = `${url}|${pref.lang}`;
        if (filteredCache.has(cacheKey)) return filteredCache.get(cacheKey);

        let text = masterTexts.get(url);
        if (!text) {
            const response = await fetch(url);
            if (!response.ok) throw new Error("HTTP " + response.status);
            text = await response.text();
            masterTexts.set(url, text);
        }

        const filtered = filterMasterText(text);
        const dataUri = filtered ? toDataUri(filtered) : null;
        filteredCache.set(cacheKey, dataUri);
        return dataUri;
    };

    let lastMasterUrl = null;
    let activeMasterUrl = null;

    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");

    const swapToFilteredMaster = (element, url) => {
        // The src setter bumps __airtubeSeq on every assignment too, so a
        // pending swap is discarded if YT replaces the source with something
        // else before our fetch completes.
        const seq = (element.__airtubeSeq = (element.__airtubeSeq || 0) + 1);

        let wasPlaying = false;
        let startAt = 0;
        try {
            wasPlaying = !element.paused;
        } catch {}
        try {
            startAt = element.currentTime || 0;
        } catch {}
        try {
            const player = getPlayer();
            if (player) {
                if (typeof player.getPlayerState === "function") {
                    wasPlaying = wasPlaying || player.getPlayerState() === 1;
                }
                if (typeof player.getCurrentTime === "function") {
                    startAt = player.getCurrentTime() || startAt;
                }
            }
        } catch {}

        filteredDataUri(url)
            .then((dataUri) => {
                if (!dataUri || element.__airtubeSeq !== seq) return;
                activeMasterUrl = url;
                lastSwappedLang = pref.lang;
                srcDescriptor.set.call(element, dataUri);
                log("src → filtered data-URI manifest");
                if (DEBUG) {
                    element.addEventListener(
                        "error",
                        () => log("video error after swap:", element.error && element.error.code),
                        { once: true }
                    );
                }
                element.addEventListener(
                    "loadedmetadata",
                    () => {
                        if (startAt > 0) {
                            try {
                                element.currentTime = startAt;
                            } catch {}
                        }
                        if (wasPlaying) {
                            element.play().catch(() => {
                                try {
                                    const player = getPlayer();
                                    if (player && typeof player.playVideo === "function") {
                                        player.playVideo();
                                    }
                                } catch {}
                            });
                        }
                    },
                    { once: true }
                );
            })
            .catch((error) => {
                warn("master filter failed:", error && error.message, "— leaving YT stream as-is");
            });
    };

    if (srcDescriptor && srcDescriptor.set) {
        Object.defineProperty(HTMLMediaElement.prototype, "src", {
            configurable: true,
            enumerable: srcDescriptor.enumerable,
            get: srcDescriptor.get,
            set: function (value) {
                const url = String(value);
                this.__airtubeSeq = (this.__airtubeSeq || 0) + 1;
                const result = srcDescriptor.set.call(this, value);
                if (isHlsMasterUrl(url)) {
                    lastMasterUrl = url;
                    log("HLS master assigned:", url.slice(0, 120));
                    swapToFilteredMaster(this, url);
                }
                return result;
            },
        });
    }

    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
        if (
            /^src$/i.test(String(name)) &&
            typeof HTMLMediaElement !== "undefined" &&
            this instanceof HTMLMediaElement
        ) {
            const url = String(value);
            this.__airtubeSeq = (this.__airtubeSeq || 0) + 1;
            const result = origSetAttribute.call(this, name, value);
            if (isHlsMasterUrl(url)) {
                lastMasterUrl = url;
                log("HLS master assigned (attribute):", url.slice(0, 120));
                swapToFilteredMaster(this, url);
            }
            return result;
        }
        return origSetAttribute.call(this, name, value);
    };

    const getPlayer = () => {
        for (const el of document.querySelectorAll("#movie_player, #shorts-player")) {
            if (typeof el.getAvailableAudioTracks === "function") return el;
        }
        return null;
    };

    const trackRawId = (track) => (track && track.id != null ? String(track.id) : "");

    // Track objects are wrappers: { id: "itag;base64protobuf", <minifiedKey>:
    // { name, id: "ar.10", isDefault, isAutoDubbed } }. The descriptor key is
    // obfuscated and varies between YT builds, so find it by shape.
    const descriptor = (track) => {
        if (!track || typeof track !== "object") return null;
        if (descriptor._key && track[descriptor._key]) return track[descriptor._key];
        for (const key of Object.getOwnPropertyNames(track)) {
            const value = track[key];
            if (
                value &&
                typeof value === "object" &&
                !Array.isArray(value) &&
                (typeof value.name === "string" || value.isAutoDubbed !== undefined)
            ) {
                descriptor._key = key;
                return value;
            }
        }
        return null;
    };

    const idStrings = (track) => {
        const raw = trackRawId(track);
        if (!raw) return [];
        const [, b64] = raw.split(";");
        if (b64) {
            const strings = decodeB64Strings(b64);
            if (strings.length) return strings;
        }
        return raw.split(/[.;]/);
    };

    const trackLang = (track) => {
        const desc = descriptor(track);
        const descId = desc && typeof desc.id === "string" ? desc.id : null;
        if (descId && /^[a-z]{2,3}(-[a-zA-Z0-9]+)?(\.\w+)?$/i.test(descId)) {
            return descId.split(".")[0];
        }
        const strings = idStrings(track);
        const langKey = strings.indexOf("lang");
        if (langKey >= 0 && strings[langKey + 1]) return strings[langKey + 1];
        return (
            strings.find(
                (s) => /^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(s) && !NON_LANG_MARKERS.has(s)
            ) || null
        );
    };

    const isDubbed = (track) => {
        const desc = descriptor(track);
        if (desc && desc.isAutoDubbed !== undefined) return !!desc.isAutoDubbed;
        return idStrings(track).some((s) => s.includes("dubbed"));
    };

    const isDefaultTrack = (track) => {
        const desc = descriptor(track);
        return !!(desc && desc.isDefault) || !!(track && track.isDefault);
    };

    const trackKey = (track) => {
        const desc = descriptor(track);
        return (desc && desc.id) || trackRawId(track);
    };

    const langLabel = (lang) => {
        if (!lang) return null;
        try {
            return new Intl.DisplayNames(["en"], { type: "language" }).of(lang) || lang;
        } catch {
            return lang;
        }
    };

    const readableName = (track) => {
        const rawId = trackRawId(track);
        const candidates = [];
        const push = (value) => {
            if (typeof value === "string" && value.trim()) candidates.push(value.trim());
        };

        const name = track && track.name;
        if (name) {
            if (typeof name === "string") push(name);
            if (typeof name === "object" && !Array.isArray(name)) {
                for (const key of ["simpleText", "text", "content", "label", "title"]) {
                    push(name[key]);
                }
                if (Array.isArray(name.runs)) {
                    push(name.runs.map((run) => run && run.text).join(""));
                }
                for (const method of ["getSimpleText", "getText", "getContent"]) {
                    if (typeof name[method] === "function") {
                        try {
                            push(name[method]());
                        } catch {}
                    }
                }
            }
        }

        return candidates.find(
            (c) => c !== rawId && !/^[A-Za-z0-9+/=;_-]{16,}$/.test(c)
        );
    };

    const trackLabel = (track) => {
        const desc = descriptor(track);
        const name = (desc && desc.name) || readableName(track);
        if (name) return name + (isDubbed(track) ? " (auto-dubbed)" : "");
        const lang = trackLang(track);
        if (lang) return (langLabel(lang) || lang) + (isDubbed(track) ? " (auto-dubbed)" : "");
        return trackRawId(track) || "?";
    };

    const originalTrackOf = (tracks) => {
        const byName = tracks.find((t) => /original/i.test(trackLabel(t)));
        if (byName) return byName;
        const originals = tracks.filter((t) => !isDubbed(t));
        const pool = originals.length ? originals : tracks;
        return pool.find(isDefaultTrack) || pool[0] || null;
    };

    // Real choice = more than one entry after the hideDubbed filter (the same
    // list the menu renders). Uses cached tracks during AirPlay.
    const audioChoicesAvailable = () => {
        const player = getPlayer();
        const live = player ? player.getAvailableAudioTracks() || [] : [];
        const videoId = player ? getVideoId(player) : null;
        const cached = fullTracks && fullTracks.videoId === videoId ? fullTracks.tracks : [];
        const tracks = live.length ? live : cached;
        if (!tracks.length) return false;
        const visible = tracks.filter(
            (t) => !pref.hideDubbed || !isDubbed(t) || trackKey(t) === pref.lang
        );
        return visible.length > 1;
    };

    const syncButtonVisibility = () => {
        if (!btn) return;
        const show = audioChoicesAvailable();
        const display = show ? "" : "none";
        if (btn.style.display !== display) {
            btn.style.display = display;
            if (!show) hideMenu();
        }
    };

    const pickTrack = (tracks, lang) => {
        if (!tracks || !tracks.length) return null;
        if (lang === "original") return originalTrackOf(tracks);
        return (
            tracks.find((t) => trackKey(t) === lang) ||
            tracks.find((t) => trackLang(t) === lang) ||
            tracks.find((t) => (trackLang(t) || "").split("-")[0] === lang.split("-")[0]) ||
            null
        );
    };

    const getCurrentTrack = (player) => {
        try {
            return player.getAudioTrack();
        } catch {
            return null;
        }
    };

    const maybeReswapForNewPref = () => {
        const video = getVideoElement();
        if (!video) return;

        const src = video.currentSrc || "";
        const inHls = src.startsWith("data:") || isHlsMasterUrl(src);
        if (!inHls) return;

        const url = activeMasterUrl || lastMasterUrl;
        if (!url) return;

        if (src.startsWith("data:") && lastSwappedLang === pref.lang) return; // already applied

        log("re-filtering stream for preference:", pref.lang);
        swapToFilteredMaster(video, url);
    };

    const getVideoId = (player) => {
        try {
            return player.getVideoData().video_id || null;
        } catch {
            return null;
        }
    };

    const switchTrack = (player, track) => {
        try {
            player.setAudioTrack(track);
            log(`switched to "${trackLabel(track)}"`);
            lastSwitch = { at: Date.now() };
        } catch (error) {
            warn("setAudioTrack failed:", error);
        }
    };

    const enforcePref = () => {
        const player = getPlayer();
        if (!player) return;

        const videoId = getVideoId(player);
        if (!videoId) return;

        const tracks = player.getAvailableAudioTracks() || [];
        if (!tracks.length) return;

        const want = pickTrack(tracks, pref.lang);
        if (!want) return;

        const current = getCurrentTrack(player);
        if (current && trackKey(current) === trackKey(want)) return;

        if (lastSwitch && Date.now() - lastSwitch.at < SWITCH_GRACE) {
            return; // stream reloading; re-check next tick
        }

        switchTrack(player, want);
    };

    let lastTracksKey = null;

    const syncTracks = () => {
        const player = getPlayer();
        if (!player) return;

        const tracks = player.getAvailableAudioTracks() || [];
        const current = getCurrentTrack(player);
        if (!tracks.length) return; // HLS/AirPlay mode has no track APIs — keep last known list

        const videoId = getVideoId(player);
        if (videoId) fullTracks = { videoId, tracks };

        const key = JSON.stringify({
            t: tracks.map((t) => [trackKey(t), trackLabel(t), isDubbed(t)]),
            c: current ? trackKey(current) : null,
        });
        if (key === lastTracksKey) return;

        if (lastTracksKey === null) log("player API ready,", tracks.length, "track(s)");
        lastTracksKey = key;
        post("tracks", {
            tracks: tracks.map((t) => ({
                id: trackKey(t),
                name: trackLabel(t),
                isDefault: isDefaultTrack(t),
            })),
            current: current ? trackKey(current) : null,
        });
    };

    const GLOBE =
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round">' +
        '<circle cx="12" cy="12" r="9"/>' +
        '<path d="M3 12h18"/>' +
        '<path d="M12 3c2.8 2.4 4.4 5.5 4.4 9s-1.6 6.6-4.4 9c-2.8-2.4-4.4-5.5-4.4-9s1.6-6.6 4.4-9z"/>' +
        "</svg>";

    const hideMenu = () => {
        if (menu) menu.hidden = true;
        if (uiRoot) uiRoot.classList.remove("airtube-menu-open");
    };

    // Mirror YT's popup surface at open time. Typography and item metrics stay
    // ours for consistency; our CSS is the fallback when YT elements are absent.
    const sampleYtStyles = () => {
        const menuSource =
            document.querySelector(".ytp-settings-menu") ||
            document.querySelector(".ytp-popup");
        if (!menuSource || !menu) return;

        const cs = getComputedStyle(menuSource);
        const badValues = new Set(["none", "normal", "auto", "rgba(0, 0, 0, 0)", "transparent"]);
        const set = (prop, value) => {
            if (typeof value === "string" && value && !badValues.has(value)) {
                menu.style[prop] = value;
            }
        };

        set("backgroundColor", cs.backgroundColor);
        if (cs.backgroundImage !== "none") {
            menu.style.backgroundImage = cs.backgroundImage;
        }
        const backdrop = cs.backdropFilter || cs.webkitBackdropFilter;
        if (backdrop && backdrop !== "none") {
            menu.style.backdropFilter = backdrop;
            menu.style.webkitBackdropFilter = backdrop;
        }
        set("borderRadius", cs.borderRadius);
        if (cs.borderTopWidth && cs.borderTopWidth !== "0px" && cs.borderTopStyle !== "none") {
            set("border", `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`);
        }
        set("boxShadow", cs.boxShadow);
    };

    const pickLanguage = (lang) => {
        pref = { ...pref, lang };
        log("menu pick:", lang);
        enforcePref();
        maybeReswapForNewPref();
        post("set-pref", { pref });
    };

    const renderMenu = () => {
        const player = getPlayer();
        const live = player ? player.getAvailableAudioTracks() || [] : [];
        const videoId = player ? getVideoId(player) : null;
        const cached = fullTracks && fullTracks.videoId === videoId ? fullTracks.tracks : [];
        const tracks = live.length ? live : cached;

        const originalTrack = originalTrackOf(tracks);
        const resolved = pickTrack(tracks, pref.lang);
        const activeKey = resolved
            ? originalTrack && trackKey(resolved) === trackKey(originalTrack)
                ? "original"
                : trackKey(resolved)
            : tracks.length
              ? "original" // pref unavailable here — playback falls back to original
              : null;

        const visibleTracks = tracks.filter(
            (t) => !pref.hideDubbed || !isDubbed(t) || trackKey(t) === pref.lang
        );
        const entries = visibleTracks.map((track) => ({
            key:
                originalTrack && trackKey(track) === trackKey(originalTrack)
                    ? "original"
                    : trackKey(track),
            label: trackLabel(track),
        }));
        menuList = entries;

        menuTitle.textContent = tracks.length
            ? `Audio track${live.length ? "" : " (AirPlay)"}`
            : "Audio track (Original)";
        menuItems.replaceChildren();

        entries.forEach((entry, index) => {
            const item = document.createElement("button");
            item.className = "airtube-item" + (entry.key === activeKey ? " airtube-active" : "");
            item.textContent = entry.label;
            item.dataset.index = String(index);
            menuItems.appendChild(item);
        });
    };

    const showMenu = () => {
        if (MIRROR_YT_STYLES) sampleYtStyles();
        renderMenu();
        if (btn && uiRoot) {
            uiRoot.classList.add("airtube-menu-open");
            uiRoot.classList.remove("ytp-autohide");
            const playerRect = uiRoot.getBoundingClientRect();
            const btnRect = btn.getBoundingClientRect();
            menu.style.right = Math.max(8, playerRect.right - btnRect.right) + "px";
            menu.style.bottom = playerRect.bottom - btnRect.top + 8 + "px";
        }
        menu.hidden = false;
    };

    const setupUi = () => {
        if (btn && btn.isConnected) return;

        const controls = [...document.querySelectorAll(".ytp-right-controls")].find(
            (c) => !c.querySelector(".airtube-button")
        );
        const playerRoot = controls && controls.closest("#movie_player, #shorts-player");
        if (!controls || !playerRoot) return;

        log("adding audio menu button");

        btn = document.createElement("button");
        btn.className = "ytp-button airtube-button";
        btn.title = "Audio track (AirTube)";
        btn.style.backgroundImage = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(GLOBE)}")`;
        btn.addEventListener("click", (event) => {
            event.stopPropagation();
            if (menu.hidden) showMenu();
            else hideMenu();
        });

        menu = document.createElement("div");
        menu.className = "airtube-menu";
        menu.hidden = true;
        menuTitle = document.createElement("div");
        menuTitle.className = "airtube-title";
        menuItems = document.createElement("div");
        menu.append(menuTitle, menuItems);

        controls.appendChild(btn);
        playerRoot.appendChild(menu);
        uiRoot = playerRoot;
    };

    setInterval(() => {
        enforcePref();
        syncTracks();
        setupUi();
        syncButtonVisibility();
    }, POLL_INTERVAL);

    // Capture-phase delegation: runs before YT's player handlers can swallow
    // clicks on our menu items.
    document.addEventListener(
        "click",
        (event) => {
            const target = event.target;
            if (!target || !target.closest) return;

            const item = target.closest(".airtube-item");
            if (item && menu && menu.contains(item)) {
                event.preventDefault();
                event.stopPropagation();
                const entry = menuList[Number(item.dataset.index)];
                if (entry) pickLanguage(entry.key);
                hideMenu();
                return;
            }

            const onButton = btn && (target === btn || btn.contains(target));
            if (menu && !menu.hidden && !menu.contains(target) && !onButton) hideMenu();
        },
        true
    );

    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key === "Escape" && menu && !menu.hidden) {
                event.stopPropagation();
                hideMenu();
            }
        },
        true
    );

    window.addEventListener("message", (event) => {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.airtube !== "bridge") return;

        if (data.type === "pref") {
            pref = { ...DEFAULT_PREF, ...(data.payload || {}) };
            log("pref:", JSON.stringify(pref));
            enforcePref();
            maybeReswapForNewPref();
        }
    });

    window.addEventListener("yt-navigate-finite", () => {
        lastMasterUrl = null;
        activeMasterUrl = null;
        lastSwappedLang = null;
        hideMenu();
        enforcePref();
    });

    post("ready");
})();

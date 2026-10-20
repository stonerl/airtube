// Isolated-world bridge: relays preferences and track lists between the
// MAIN-world inject.js and extension storage.

let cachedTracks = null;
let mainWorldReady = false;

const DEFAULT_PREF = { lang: "original", hideDubbed: true };

const postToPage = (type, payload) =>
    window.postMessage({ airtube: "bridge", type, payload }, window.location.origin);

const injectMainScript = () => {
    const script = document.createElement("script");
    script.src = browser.runtime.getURL("inject.js");
    (document.head || document.documentElement).appendChild(script);
};

const sendPref = () =>
    browser.storage.local
        .get("airtubePref")
        .then((result) => postToPage("pref", result.airtubePref || DEFAULT_PREF));

window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.airtube !== "page") return;

    if (data.type === "ready") {
        mainWorldReady = true;
        sendPref();
    } else if (data.type === "tracks") {
        cachedTracks = data.payload;
        browser.storage.local
            .set({ airtubeTracks: data.payload, airtubeTracksTs: Date.now() })
            .catch(() => {});
    } else if (data.type === "set-pref") {
        const incoming = (data.payload && data.payload.pref) || DEFAULT_PREF;
        browser.storage.local
            .set({ airtubePref: { ...DEFAULT_PREF, ...incoming } })
            .catch(() => {});
    }
});

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "getTracks") {
        sendResponse({ tracks: cachedTracks });
    }
});

browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.airtubePref) sendPref();
});

// Fallback in case the MAIN-world content script registration was not honored.
setTimeout(() => {
    if (!mainWorldReady) {
        console.warn("[AirTube] MAIN-world script silent, using script tag fallback");
        injectMainScript();
    }
}, 3000);

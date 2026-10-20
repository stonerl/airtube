const DEFAULT_PREF = { lang: "original", hideDubbed: true };

let pref = { ...DEFAULT_PREF };
let tracks = null;

const langSelect = document.getElementById("lang-select");
const hideDubbedToggle = document.getElementById("hide-dubbed-toggle");
const current = document.getElementById("current");

const addOption = (value, label) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    langSelect.appendChild(option);
};

const buildOptions = () => {
    langSelect.replaceChildren();

    const allTracks = tracks?.tracks ?? [];
    const originalTrack =
        allTracks.find((t) => /original/i.test(t.name)) ??
        allTracks.find((t) => !/auto-dubbed/i.test(t.name));

    const visibleTracks = allTracks.filter(
        (t) => !pref.hideDubbed || !/auto-dubbed/i.test(t.name) || t.id === pref.lang
    );

    if (!visibleTracks.length) {
        addOption("original", "Original");
    } else {
        for (const track of visibleTracks) {
            const isOriginal = originalTrack && track.id === originalTrack.id;
            addOption(isOriginal ? "original" : track.id, track.name);
        }
    }
};

// What this video will actually play: stored pref if available here,
// otherwise the original language.
const effectiveSelection = () => {
    if (pref.lang === "original") return "original";
    const options = [...langSelect.options];
    if (options.some((option) => option.value === pref.lang)) return pref.lang;

    const base = pref.lang.split(".")[0].split("-")[0];
    const match = options.find(
        (option) =>
            option.value !== "original" &&
            option.value.split(".")[0].split("-")[0] === base
    );
    return match ? match.value : "original";
};

const persist = async (nextPref) => {
    pref = nextPref;
    try {
        await browser.storage.local.set({ airtubePref: pref });
        current.textContent = "";
    } catch (error) {
        current.textContent = `Save failed: ${error && error.message}`;
    }
};

const saveLang = () => persist({ ...pref, lang: langSelect.value });

const saveAndRebuild = async () => {
    await persist({ ...pref, hideDubbed: hideDubbedToggle.checked });
    buildOptions();
    langSelect.value = effectiveSelection();
};

const STALE_CACHE_MS = 60 * 1000;

const loadTracks = async () => {
    try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (tab) {
            const response = await browser.tabs
                .sendMessage(tab.id, { type: "getTracks" })
                .catch(() => undefined);
            if (response !== undefined) return response.tracks || null;
        }
    } catch {}

    // No live page available (non-YouTube tab): use a recent cache only.
    try {
        const stored = await browser.storage.local.get([
            "airtubeTracks",
            "airtubeTracksTs",
        ]);
        if (stored.airtubeTracks && Date.now() - (stored.airtubeTracksTs || 0) < STALE_CACHE_MS) {
            return stored.airtubeTracks;
        }
    } catch {}

    return null;
};

(async () => {
    try {
        const stored = await browser.storage.local.get("airtubePref");
        pref = { ...DEFAULT_PREF, ...(stored.airtubePref || {}) };
    } catch (error) {
        current.textContent = `Storage failed: ${error && error.message}`;
    }

    tracks = await loadTracks();

    buildOptions();
    langSelect.value = effectiveSelection();
    hideDubbedToggle.checked = pref.hideDubbed;

    langSelect.addEventListener("change", saveLang);
    langSelect.addEventListener("input", saveLang);
    hideDubbedToggle.addEventListener("change", saveAndRebuild);
})();

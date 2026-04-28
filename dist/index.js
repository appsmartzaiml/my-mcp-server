import express from "express";
import cors from "cors";
import axios from "axios";
import { existsSync, readFileSync } from "fs";
loadEnvFile();
const RADIOFM_API_BASE = process.env.radiofm_api_base ||
    "https://a.rgapi.com/rfm/api";
const RADIOFM_LOGO_BASE = "https://dpi4fupzvxbqq.cloudfront.net/rfm";
const MCP_PUBLIC_URL = process.env.mcp_public_url ||
    `${(process.env.public_base_url || "https://my-mcp-server-flame.vercel.app").replace(/\/$/, "")}/mcp`;
const MCP_PUBLIC_BASE_URL = MCP_PUBLIC_URL.replace(/\/mcp\/?$/, "");
const RADIO_FALLBACK_IMAGE_URL = `${MCP_PUBLIC_BASE_URL}/RadioFallback.png`;
const PODCAST_FALLBACK_IMAGE_URL = `${MCP_PUBLIC_BASE_URL}/PodcastFallback.png`;
const port = process.env.PORT || 3000;
const RADIOFM_WIDGET_URI = "ui://radiofm/search-results-v4.html";
const SERVER_VERSION = "1.0.4";
const RADIOFM_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        query: { type: "string" },
        stations: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    logoPath: { type: "string" },
                    logoUrl: { type: "string" },
                    fallbackImageUrl: { type: "string" },
                    url: { type: "string" },
                    location: { type: "string" },
                    language: { type: "string" },
                    genre: { type: "string" },
                    stream: { type: "string" },
                    plays: { type: "string" },
                },
                required: [
                    "id",
                    "name",
                    "logoPath",
                    "logoUrl",
                    "fallbackImageUrl",
                    "url",
                    "location",
                    "language",
                    "genre",
                    "stream",
                    "plays",
                ],
            },
        },
        podcasts: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    imageUrl: { type: "string" },
                    fallbackImageUrl: { type: "string" },
                    url: { type: "string" },
                    category: { type: "string" },
                    language: { type: "string" },
                },
                required: [
                    "id",
                    "name",
                    "imageUrl",
                    "fallbackImageUrl",
                    "url",
                    "category",
                    "language",
                ],
            },
        },
    },
    required: ["query", "stations", "podcasts"],
};
function loadEnvFile() {
    if (!existsSync(".env"))
        return;
    const envContent = readFileSync(".env", "utf8");
    for (const line of envContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex === -1)
            continue;
        const key = trimmed.slice(0, separatorIndex).trim();
        const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");
        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}
function absoluteUrl(baseUrl, pathOrUrl) {
    if (!pathOrUrl)
        return "";
    if (/^https?:\/\//i.test(pathOrUrl))
        return pathOrUrl;
    return `${baseUrl.replace(/\/$/, "")}/${pathOrUrl.replace(/^\//, "")}`;
}
function stationWebsiteUrl(station) {
    const url = `https://appradiofm.com/radioplay/${station.st_shorturl}` || station.deeplink;
    return url.replace(/^http:\/\/appradiofm\.com/i, "https://appradiofm.com");
}
function podcastImageRouteParam(imageUrl) {
    if (!imageUrl)
        return "";
    try {
        const parsedUrl = new URL(imageUrl, RADIOFM_LOGO_BASE);
        const filename = parsedUrl.pathname.split("/").filter(Boolean).pop() || "";
        return filename.replace(/\./g, "-");
    }
    catch {
        const filename = imageUrl.split(/[?#]/, 1)[0].split("/").filter(Boolean).pop() || "";
        return filename.replace(/\./g, "-");
    }
}
function podcastWebsiteUrl(podcast) {
    const imageParam = podcastImageRouteParam(podcast.p_image);
    if (!podcast.p_id || !imageParam || !podcast.p_name || !podcast.cat_name) {
        return podcast.deeplink;
    }
    const routeParts = [podcast.p_id, imageParam, podcast.p_name, podcast.cat_name]
        .map((part) => encodeURIComponent(part));
    return `https://appradiofm.com/pdetail/${routeParts.join("/")}`;
}
function formatCount(value) {
    const parsed = Number.parseInt(value || "0", 10);
    return Number.isFinite(parsed) ? parsed.toLocaleString() : "0";
}
function buildStationViews(stations) {
    return stations.map((station) => ({
        id: station.st_id,
        name: station.st_name,
        logoPath: station.st_logo,
        logoUrl: absoluteUrl(RADIOFM_LOGO_BASE, station.st_logo),
        fallbackImageUrl: RADIO_FALLBACK_IMAGE_URL,
        url: stationWebsiteUrl(station),
        location: [station.st_city, station.st_state, station.country_name_rs].filter(Boolean).join(", "),
        language: station.language,
        genre: station.st_genre,
        stream: `${station.stream_type} ${station.stream_bitrate}kbps`,
        plays: formatCount(station.st_play_cnt),
    }));
}
function buildPodcastViews(podcasts) {
    return podcasts.map((podcast) => ({
        id: podcast.p_id,
        name: podcast.p_name,
        imageUrl: absoluteUrl(RADIOFM_LOGO_BASE, podcast.p_image),
        fallbackImageUrl: PODCAST_FALLBACK_IMAGE_URL,
        url: podcastWebsiteUrl(podcast),
        category: podcast.cat_name,
        language: podcast.p_lang,
    }));
}
function buildRadioFmWidgetHtml() {
    return `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #171717; background: #fff; }
    .wrap { padding: 14px; max-width: 920px; }
    .title { font-size: 22px; line-height: 1.2; margin: 0 0 14px; }
    .sectionTitle { font-size: 16px; line-height: 1.25; margin: 18px 0 10px; }
    .count { color: #777; font-weight: 500; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 14px; }
    .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; background: #fff; min-width: 0; }
    .logoButton { display: block; width: 100%; padding: 0; border: 0; background: #f6f7f9; border-radius: 4px; cursor: pointer; }
    .logo { display: block; width: 100%; aspect-ratio: 1 / 1; object-fit: contain; border-radius: 4px; }
    .name { font-size: 15px; line-height: 1.3; margin: 10px 0 4px; overflow-wrap: anywhere; }
    .meta { font-size: 12px; line-height: 1.4; margin: 0 0 6px; color: #555; overflow-wrap: anywhere; }
    .subtle { color: #777; }
    .listen { display: inline-block; background: #ff6b6b; color: #fff; border: 0; padding: 8px 14px; border-radius: 4px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .loadMore { margin: 12px 0 4px; background: #171717; color: #fff; border: 0; padding: 8px 14px; border-radius: 4px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .skeleton { position: relative; overflow: hidden; background: #eee; border-radius: 4px; }
    .skeleton::after { content: ""; position: absolute; inset: 0; transform: translateX(-100%); background: linear-gradient(90deg, transparent, rgba(255,255,255,.72), transparent); animation: shimmer 1.2s infinite; }
    .skeletonLogo { width: 100%; aspect-ratio: 1 / 1; }
    .skeletonLine { height: 12px; margin: 10px 0 0; }
    .skeletonLine.short { width: 56%; }
    .skeletonLine.medium { width: 78%; }
    .skeletonButton { width: 68px; height: 30px; margin-top: 12px; }
    @keyframes shimmer { 100% { transform: translateX(100%); } }
    .hidden { display: none; }
  </style>
</head>
<body>
  <main class="wrap">
    <h1 id="title" class="title">RadioFM results</h1>
    <h2 id="stationsTitle" class="sectionTitle hidden">Radio Stations <span id="stationsCount" class="count"></span></h2>
    <section id="stations" class="grid"></section>
    <button id="loadMoreStations" class="loadMore hidden" type="button">Load more radio stations</button>
    <h2 id="podcastsTitle" class="sectionTitle hidden">Podcasts <span id="podcastsCount" class="count"></span></h2>
    <section id="podcasts" class="grid"></section>
    <button id="loadMorePodcasts" class="loadMore hidden" type="button">Load more podcasts</button>
  </main>
  <script>
    const INITIAL_STATION_COUNT = 12;
    const INITIAL_PODCAST_COUNT = 8;
    const LOAD_MORE_STATION_COUNT = 12;
    const LOAD_MORE_PODCAST_COUNT = 8;
    const titleEl = document.getElementById("title");
    const stationsTitleEl = document.getElementById("stationsTitle");
    const stationsCountEl = document.getElementById("stationsCount");
    const stationsEl = document.getElementById("stations");
    const loadMoreStationsEl = document.getElementById("loadMoreStations");
    const podcastsTitleEl = document.getElementById("podcastsTitle");
    const podcastsCountEl = document.getElementById("podcastsCount");
    const podcastsEl = document.getElementById("podcasts");
    const loadMorePodcastsEl = document.getElementById("loadMorePodcasts");
    let currentData = null;
    let visibleStationCount = INITIAL_STATION_COUNT;
    let visiblePodcastCount = INITIAL_PODCAST_COUNT;

    function text(value) {
      return String(value || "");
    }

    function openUrl(url) {
      if (!url) return;
      if (window.openai && window.openai.openExternal) {
        window.openai.openExternal({ href: url, redirectUrl: false });
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    }

    function appendText(parent, tag, className, value) {
      const el = document.createElement(tag);
      el.className = className;
      el.textContent = text(value);
      parent.appendChild(el);
      return el;
    }

    function setHidden(el, hidden) {
      el.classList.toggle("hidden", hidden);
    }

    function renderSkeletonCards(container, count) {
      for (let index = 0; index < count; index += 1) {
        const card = document.createElement("article");
        card.className = "card";

        const logo = document.createElement("div");
        logo.className = "skeleton skeletonLogo";
        card.appendChild(logo);

        const lineOne = document.createElement("div");
        lineOne.className = "skeleton skeletonLine medium";
        card.appendChild(lineOne);

        const lineTwo = document.createElement("div");
        lineTwo.className = "skeleton skeletonLine";
        card.appendChild(lineTwo);

        const lineThree = document.createElement("div");
        lineThree.className = "skeleton skeletonLine short";
        card.appendChild(lineThree);

        const button = document.createElement("div");
        button.className = "skeleton skeletonButton";
        card.appendChild(button);

        container.appendChild(card);
      }
    }

    function renderLoading() {
      titleEl.textContent = "Loading...";
      stationsEl.replaceChildren();
      podcastsEl.replaceChildren();
      setHidden(stationsTitleEl, false);
      setHidden(podcastsTitleEl, false);
      stationsCountEl.textContent = "";
      podcastsCountEl.textContent = "";
      setHidden(loadMoreStationsEl, true);
      setHidden(loadMorePodcastsEl, true);
      renderSkeletonCards(stationsEl, 6);
      renderSkeletonCards(podcastsEl, 4);
    }

    function render(data) {
      currentData = data;
      visibleStationCount = INITIAL_STATION_COUNT;
      visiblePodcastCount = INITIAL_PODCAST_COUNT;
      renderCurrent();
    }

    function renderCurrent() {
      const data = currentData;
      const hasResult = data && (Array.isArray(data.stations) || Array.isArray(data.podcasts));
      const query = text(data && data.query);
      const stations = Array.isArray(data && data.stations) ? data.stations : [];
      const podcasts = Array.isArray(data && data.podcasts) ? data.podcasts : [];

      titleEl.textContent = query ? 'Search Results for "' + query + '"' : (hasResult ? "RadioFM results" : "Loading...");
      stationsEl.replaceChildren();
      podcastsEl.replaceChildren();
      setHidden(stationsTitleEl, !hasResult);
      setHidden(podcastsTitleEl, !hasResult);
      setHidden(loadMoreStationsEl, true);
      setHidden(loadMorePodcastsEl, true);

      if (!hasResult) {
        renderLoading();
        return;
      }

      stationsCountEl.textContent = "(" + stations.length + ")";
      podcastsCountEl.textContent = "(" + podcasts.length + ")";

      if (!stations.length) {
        appendText(stationsEl, "p", "meta", "No radio stations found.");
      }

      for (const station of stations.slice(0, visibleStationCount)) {
        const card = document.createElement("article");
        card.className = "card";

        const logoButton = document.createElement("button");
        logoButton.className = "logoButton";
        logoButton.type = "button";
        logoButton.onclick = () => openUrl(station.url);

        const logo = document.createElement("img");
        logo.className = "logo";
        logo.src = text(station.logoUrl) || text(station.fallbackImageUrl);
        logo.alt = text(station.name) + " logo";
        logo.loading = "lazy";
        logo.onerror = () => {
          const fallbackUrl = text(station.fallbackImageUrl);
          if (fallbackUrl && logo.src !== fallbackUrl) logo.src = fallbackUrl;
        };
        logoButton.appendChild(logo);
        card.appendChild(logoButton);

        appendText(card, "h2", "name", station.name);
        appendText(card, "p", "meta", station.location);
        appendText(card, "p", "meta", [station.language, station.genre].filter(Boolean).join(" - "));
        appendText(card, "p", "meta subtle", [station.stream, station.plays ? station.plays + " plays" : ""].filter(Boolean).join(" - "));

        const listen = document.createElement("button");
        listen.className = "listen";
        listen.type = "button";
        listen.textContent = "Listen";
        listen.onclick = () => openUrl(station.url);
        card.appendChild(listen);

        stationsEl.appendChild(card);
      }
      setHidden(loadMoreStationsEl, visibleStationCount >= stations.length);

      if (!podcasts.length) {
        appendText(podcastsEl, "p", "meta", "No podcasts found.");
      }

      for (const podcast of podcasts.slice(0, visiblePodcastCount)) {
        const card = document.createElement("article");
        card.className = "card";

        const imageButton = document.createElement("button");
        imageButton.className = "logoButton";
        imageButton.type = "button";
        imageButton.onclick = () => openUrl(podcast.url);

        const image = document.createElement("img");
        image.className = "logo";
        image.src = text(podcast.imageUrl) || text(podcast.fallbackImageUrl);
        image.alt = text(podcast.name) + " cover";
        image.loading = "lazy";
        image.onerror = () => {
          const fallbackUrl = text(podcast.fallbackImageUrl);
          if (fallbackUrl && image.src !== fallbackUrl) image.src = fallbackUrl;
        };
        imageButton.appendChild(image);
        card.appendChild(imageButton);

        appendText(card, "h2", "name", podcast.name);
        appendText(card, "p", "meta", [podcast.category, podcast.language].filter(Boolean).join(" - "));

        const listen = document.createElement("button");
        listen.className = "listen";
        listen.type = "button";
        listen.textContent = "Listen";
        listen.onclick = () => openUrl(podcast.url);
        card.appendChild(listen);

        podcastsEl.appendChild(card);
      }
      setHidden(loadMorePodcastsEl, visiblePodcastCount >= podcasts.length);
    }

    loadMoreStationsEl.addEventListener("click", () => {
      visibleStationCount += LOAD_MORE_STATION_COUNT;
      renderCurrent();
    });

    loadMorePodcastsEl.addEventListener("click", () => {
      visiblePodcastCount += LOAD_MORE_PODCAST_COUNT;
      renderCurrent();
    });

    render(window.openai && window.openai.toolOutput);

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method === "ui/notifications/tool-result") {
        render(message.params && message.params.structuredContent);
      }
    }, { passive: true });

    window.addEventListener("openai:set_globals", (event) => {
      const output = event.detail && event.detail.globals && event.detail.globals.toolOutput;
      if (output) render(output);
    }, { passive: true });
  </script>
</body>
</html>
    `.trim();
}
function buildTextSummary(query, stations, podcasts) {
    const stationLines = stations.slice(0, 5).map((station) => {
        const location = [station.st_city, station.st_state, station.country_name_rs].filter(Boolean).join(", ");
        return `- ${station.st_name}${location ? ` - ${location}` : ""}`;
    });
    const podcastLines = podcasts.slice(0, 3).map((podcast) => `- ${podcast.p_name}`);
    const sections = [`Search results for "${query}"`];
    if (stationLines.length) {
        sections.push(`Stations:\n${stationLines.join("\n")}`);
    }
    if (podcastLines.length) {
        sections.push(`Podcasts:\n${podcastLines.join("\n")}`);
    }
    return sections.join("\n\n");
}
// Express setup
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
// Handle preflight
// app.options("/.*/", cors());
// Health check
app.get("/", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
        status: "Radio FM MCP Server is running",
        version: SERVER_VERSION,
        protocol: "MCP",
    });
});
app.get("/mcp", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
        message: "Radio FM MCP endpoint – use POST with ChatGPT MCP protocol."
    });
});
// OpenAI Apps Challenge verification
app.get("/.well-known/openai-apps-challenge", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "text/plain");
    res.send("9-BRtIuK2ZXZVF19OJx1Gp5qKgrfzE4ekkeHUYFN_68");
});
// MCP descriptor (for ChatGPT Apps & Connectors)
app.get("/mcp.json", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.json({
        schema_version: "v1",
        name: "RadioFM",
        version: SERVER_VERSION,
        description: "Radio FM brings the world’s radio stations and podcasts directly into ChatGPT. Explore live broadcasts from over 200 countries — search by station name, city, country, language, or genre, and instantly discover music, news, talk, and sports channels that suit your mood. Whether you want trending hits, sports or regional talk shows, or local community radio, ChatGPT can use Radio FM to find and play them in real time. No authentication or setup is required — just search and start listening.",
        api: {
            type: "mcp",
            url: MCP_PUBLIC_URL,
        },
        auth: "none",
        capabilities: {
            tools: [
                {
                    name: "search_radio_stations",
                    description: "Search and discover live radio stations and podcasts from across the world by entering a station name, location, country, language, or genre. ChatGPT connects with the Radio FM database to instantly return matching stations you can explore or play — from local favorites to trending global broadcasts.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "Search query (e.g., 'RedFM', 'Vividh Bharati', 'AIR','BBC', 'India', 'Hindi', 'Jazz')",
                            },
                        },
                        required: ["query"],
                    },
                    outputSchema: RADIOFM_OUTPUT_SCHEMA,
                    "annotations": {
                        "readOnlyHint": true,
                        "openWorldHint": true,
                        "destructiveHint": false
                    },
                    _meta: {
                        ui: { resourceUri: RADIOFM_WIDGET_URI },
                        "openai/outputTemplate": RADIOFM_WIDGET_URI,
                        "openai/toolInvocation/invoking": "Searching RadioFM...",
                        "openai/toolInvocation/invoked": "RadioFM results ready",
                    },
                    // "auto_execute": true
                },
            ],
        },
        categories: ["radio", "news", "media", "entertainment", "music"],
        author: {
            name: "Radio FM",
            website: "https://appradiofm.com/terms-of-use",
            email: "support@appradiofm.com",
        },
        icon: {
            url: "https://my-mcp-server-flame.vercel.app/UpdatedRFMIcon.png",
            background: "#111827",
        },
        legal: {
            privacy_policy_url: "https://appradiofm.com/privacy-policy",
            terms_of_service_url: "https://appradiofm.com/terms-of-use",
        },
        homepage: "https://appradiofm.com/",
        license: "MIT",
    });
});
// MCP protocol handler
app.post("/mcp", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    try {
        const { method, params, id } = req.body;
        // Initialize handshake
        if (method === "initialize") {
            return res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    protocolVersion: "2024-11-05",
                    capabilities: { tools: {}, resources: {} },
                    serverInfo: { name: "radiofm-mcp-server", version: SERVER_VERSION },
                },
            });
        }
        if (method === "resources/list") {
            return res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    resources: [
                        {
                            uri: RADIOFM_WIDGET_URI,
                            name: "RadioFM Search Results",
                            description: "Displays RadioFM station and podcast search results.",
                            mimeType: "text/html;profile=mcp-app",
                        },
                    ],
                },
            });
        }
        if (method === "resources/read") {
            const uri = params?.uri;
            if (uri !== RADIOFM_WIDGET_URI) {
                throw new Error(`Unknown resource: ${uri}`);
            }
            return res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    contents: [
                        {
                            uri: RADIOFM_WIDGET_URI,
                            mimeType: "text/html;profile=mcp-app",
                            text: buildRadioFmWidgetHtml(),
                            _meta: {
                                ui: {
                                    prefersBorder: true,
                                    domain: MCP_PUBLIC_BASE_URL,
                                    csp: {
                                        resourceDomains: [
                                            "https://dpi4fupzvxbqq.cloudfront.net",
                                            "https://d3t3ozftmdmh3i.cloudfront.net",
                                            MCP_PUBLIC_BASE_URL,
                                        ],
                                        connectDomains: [],
                                    },
                                },
                                "openai/widgetDescription": "Interactive RadioFM search results with clickable station logos and listen links.",
                                "openai/widgetPrefersBorder": true,
                                "openai/widgetDomain": MCP_PUBLIC_BASE_URL,
                                "openai/widgetCSP": {
                                    resource_domains: [
                                        "https://dpi4fupzvxbqq.cloudfront.net",
                                        "https://d3t3ozftmdmh3i.cloudfront.net",
                                        MCP_PUBLIC_BASE_URL,
                                    ],
                                    connect_domains: [],
                                    redirect_domains: [
                                        "https://appradiofm.com",
                                    ],
                                },
                            },
                        },
                    ],
                },
            });
        }
        // List tools
        if (method === "tools/list") {
            return res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    tools: [
                        {
                            name: "search_radio_stations",
                            description: "Search and explore live radio stations and podcasts from around the world using the Radio FM app within ChatGPT. Discover trending music, news, and cultural broadcasts across languages, genres, and countries — all seamlessly accessible without sign-in.",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    query: {
                                        type: "string",
                                        description: "Search query (e.g., 'RedFM', 'Vividh Bharati', 'AIR', 'BBC', 'India', 'Hindi', 'Jazz')",
                                    },
                                },
                                required: ["query"],
                            },
                            "annotations": {
                                "readOnlyHint": true,
                                "openWorldHint": true,
                                "destructiveHint": false
                            },
                            outputSchema: RADIOFM_OUTPUT_SCHEMA,
                            _meta: {
                                ui: { resourceUri: RADIOFM_WIDGET_URI },
                                "openai/outputTemplate": RADIOFM_WIDGET_URI,
                                "openai/toolInvocation/invoking": "Searching RadioFM...",
                                "openai/toolInvocation/invoked": "RadioFM results ready",
                            }
                        },
                    ],
                },
            });
        }
        // Tool call
        if (method === "tools/call") {
            const { name, arguments: args } = params;
            if (name !== "search_radio_stations")
                throw new Error(`Unknown tool: ${name}`);
            const query = args?.query;
            if (!query)
                throw new Error("Search query is required");
            const response = await axios.get(`${RADIOFM_API_BASE}/new_combo_search.php`, { params: { srch: query }, timeout: 35000 });
            const apiData = response.data;
            if (apiData.data.ErrorCode !== 0)
                throw new Error(apiData.data.ErrorMessage);
            const results = apiData.data.Data;
            if (!results?.length)
                return res.json({
                    jsonrpc: "2.0",
                    id,
                    result: {
                        content: [
                            {
                                type: "text",
                                text: `🔍 No results found for "${query}". Try station name, country, language, or genre.`,
                            },
                        ],
                    },
                });
            const radioData = results.find((r) => r.type === "radio");
            const stations = radioData && radioData.data.length > 0
                ? radioData.data
                : [];
            if (radioData && radioData.data.length > 0) {
                stations.forEach((station) => {
                    station.deeplink = station.deeplink || `https://appradiofm.com/radioplay/${station.st_shorturl}`;
                });
            }
            const podcastData = results.find((r) => r.type === "podcast");
            const podcasts = podcastData && podcastData.data.length > 0
                ? podcastData.data
                : [];
            const stationViews = buildStationViews(stations);
            const podcastViews = buildPodcastViews(podcasts);
            const textSummary = buildTextSummary(query, stations, podcasts);
            return res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    structuredContent: {
                        query,
                        stations: stationViews,
                        podcasts: podcastViews,
                    },
                    content: [
                        {
                            type: "text",
                            text: textSummary,
                        },
                    ],
                    _meta: {
                        "openai/outputTemplate": RADIOFM_WIDGET_URI,
                        resultCount: {
                            stations: stations.length,
                            podcasts: podcasts.length,
                        },
                    },
                },
            });
        }
        throw new Error(`Unknown method: ${method}`);
    }
    catch (err) {
        console.error("MCP Error:", err);
        res.json({
            jsonrpc: "2.0",
            id: req.body?.id || null,
            error: { code: -32000, message: err.message || "Internal server error" },
        });
    }
});
// Start server
app.listen(port, () => {
    console.log(`✅ Radio FM MCP Server running on http://localhost:${port}`);
    console.log(`📡 MCP descriptor: /mcp.json`);
});
//# sourceMappingURL=index.js.map
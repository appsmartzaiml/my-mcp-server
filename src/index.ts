import express from "express";
import cors from "cors";
import axios from "axios";

const RADIOFM_API_BASE = "https://devappradiofm.radiofm.co/rfm/api";
const port = process.env.PORT || 3000;

// Interfaces
interface RadioStation {
    st_id: string;
    st_name: string;
    st_logo: string;
    st_weburl: string;
    st_shorturl: string;
    st_genre: string;
    st_lang: string;
    language: string;
    st_bc_freq: string;
    st_city: string;
    st_state: string;
    country_name_rs: string;
    st_country: string;
    st_play_cnt: string;
    st_fav_cnt: string;
    stream_link: string;
    stream_type: string;
    stream_bitrate: string;
    deeplink: string;
}

interface Podcast {
    p_id: string;
    p_name: string;
    p_desc: string;
    p_lang: string;
    p_image: string;
    p_email: string;
    cat_name: string;
    total_stream: string;
    deeplink: string;
    cc_code: string;
}

interface ApiResponse {
    http_response_code: number;
    http_response_message: string;
    data: {
        ErrorCode: number;
        ErrorMessage: string;
        Data: Array<{
            type: string;
            data: RadioStation[] | Podcast[];
        }>;
    };
}

// Format radio station details
function formatRadioStation(station: RadioStation, index: number): string {
    const lines = [
        `${index}. ${station.st_name}`,
        `Location: ${station.st_city}, ${station.st_state}, ${station.country_name_rs}`,
        `Language: ${station.language}`,
        `Genre: ${station.st_genre}`,
    ];

    if (station.st_bc_freq !== "~") lines.push(`Frequency: ${station.st_bc_freq}`);

    lines.push(
        `Stream: ${station.stream_type} ${station.stream_bitrate}kbps`,
        `Plays: ${parseInt(station.st_play_cnt).toLocaleString()}`,
        `Listen: https://appradiofm.com/radioplay/${station.st_shorturl}`
    );

    return lines.join("\n");
}

// Format podcast details
function formatPodcast(podcast: Podcast, index: number): string {
    const lines = [
        `${index}. ${podcast.p_name}`,
        `Category: ${podcast.cat_name}`,
        `Language: ${podcast.p_lang}`,
    ];

    if (podcast.p_desc) {
        const shortDesc =
            podcast.p_desc.length > 100
                ? podcast.p_desc.substring(0, 100) + "..."
                : podcast.p_desc;
        lines.push(`Description: ${shortDesc}`);
    }

    lines.push(
        `Streams: ${parseInt(podcast.total_stream).toLocaleString()}`,
        `Listen: ${podcast.deeplink}`
    );

    return lines.join("\n");
}

// Express setup
const app = express();
app.use(cors());
app.use(express.json());

// Handle preflight
app.options("*", cors());

// Health check
app.get("/", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
        status: "Radio FM MCP Server is running",
        version: "1.0.1",
        protocol: "MCP",
    });
});

// MCP descriptor (for ChatGPT Apps & Connectors)
app.get("/mcp.json", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
        schema_version: "v1",
        name: "RadioFM",
        version: "1.0.1",
        description:
            "Radio FM brings the world’s radio stations and podcasts directly into ChatGPT. Explore live broadcasts from over 200 countries — search by station name, city, country, language, or genre, and instantly discover music, news, talk, and sports channels that suit your mood. Whether you want trending hits, sports or regional talk shows, or local community radio, ChatGPT can use Radio FM to find and play them in real time. No authentication or setup is required — just search and start listening.",
        api: {
            type: "mcp",
            url: "https://my-mcp-server-flame.vercel.app/mcp",
        },
        auth: "none",
        capabilities: {
            tools: [
                {
                    name: "search_radio_stations",
                    description:
                        "Search and discover live radio stations and podcasts from across the world by entering a station name, location, country, language, or genre. ChatGPT connects with the Radio FM database to instantly return matching stations you can explore or play — from local favorites to trending global broadcasts.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description:
                                    "Search query (e.g., 'BBC', 'India', 'Hindi', 'Jazz')",
                            },
                        },
                        required: ["query"],
                    },
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
                    protocolVersion: "2025-11-04",
                    capabilities: { tools: {} },
                    serverInfo: { name: "radiofm-mcp-server", version: "1.0.1" },
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
                            description:
                                "Search and explore live radio stations and podcasts from around the world using the Radio FM app within ChatGPT. Discover trending music, news, and cultural broadcasts across languages, genres, and countries — all seamlessly accessible without sign-in.",
                            inputSchema: {
                                type: "object",
                                properties: {
                                    query: {
                                        type: "string",
                                        description:
                                            "Search query (e.g., 'BBC', 'India', 'Hindi', 'Jazz')",
                                    },
                                },
                                required: ["query"],
                            },
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

            const query = args?.query as string;
            if (!query) throw new Error("Search query is required");

            const response = await axios.get<ApiResponse>(
                `${RADIOFM_API_BASE}/new_combo_search.php`,
                { params: { srch: query }, timeout: 15000 }
            );
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

            const sections = [`Search Results for "${query}"`];
            const radioData = results.find((r) => r.type === "radio");
            if (radioData && radioData.data.length > 0) {
                const stations = radioData.data as RadioStation[];
                sections.push(
                    `\nRADIO STATIONS (${stations.length})`,
                    ...stations.map((station, i) => formatRadioStation(station, i + 1))
                );
            }

            const podcastData = results.find((r) => r.type === "podcast");
            if (podcastData && podcastData.data.length > 0) {
                const podcasts = podcastData.data as Podcast[];
                sections.push(
                    `\nPODCASTS (${podcasts.length})`,
                    ...podcasts.map((podcast, i) => formatPodcast(podcast, i + 1))
                );
            }

            sections.push("\nTap on any 'Listen' link to play on RadioFM.");
            return res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    content: [{ type: "text", text: sections.join("\n") }],
                },
            });
        }

        throw new Error(`Unknown method: ${method}`);
    } catch (err: any) {
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

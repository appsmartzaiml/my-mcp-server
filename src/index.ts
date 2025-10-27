import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import express from 'express';
import cors from 'cors';
import axios from "axios";

// Radio FM API configuration
const RADIOFM_API_BASE = "https://devappradiofm.radiofm.co/rfm/api";
const port = process.env.PORT || 3000;

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

// Create MCP server instance
const server = new Server(
    {
        name: "radiofm-mcp-server",
        version: "1.0.0",
    }
);

// Format radio station details
function formatRadioStation(station: RadioStation, index: number): string {
    let result = `\n🎵 **${index}. ${station.st_name}**\n`;
    result += `   📍 Location: ${station.st_city}, ${station.st_state}, ${station.country_name_rs}\n`;
    result += `   🌐 Language: ${station.language}\n`;
    result += `   🎼 Genre: ${station.st_genre}\n`;

    if (station.st_bc_freq !== "~") {
        result += `   📻 Frequency: ${station.st_bc_freq}\n`;
    }

    result += `   🎧 Stream: ${station.stream_type} @ ${station.stream_bitrate}kbps\n`;
    result += `   ⭐ Plays: ${parseInt(station.st_play_cnt).toLocaleString()} | Favorites: ${parseInt(station.st_fav_cnt).toLocaleString()}\n`;
    result += `   🔗 Play on Radio FM: ${station.deeplink}\n`;

    if (station.st_weburl && station.st_weburl !== "~") {
        result += `   🌍 Website: ${station.st_weburl}\n`;
    }

    return result;
}

// Format podcast details
function formatPodcast(podcast: Podcast, index: number): string {
    let result = `\n🎙️ **${index}. ${podcast.p_name}**\n`;
    result += `   📂 Category: ${podcast.cat_name}\n`;
    result += `   🌐 Language: ${podcast.p_lang}\n`;

    if (podcast.p_desc) {
        const shortDesc = podcast.p_desc.length > 150
            ? podcast.p_desc.substring(0, 150) + "..."
            : podcast.p_desc;
        result += `   📝 Description: ${shortDesc}\n`;
    }

    result += `   🎧 Total Streams: ${parseInt(podcast.total_stream).toLocaleString()}\n`;
    result += `   🔗 Listen on Radio FM: ${podcast.deeplink}\n`;

    return result;
}

// Set up Express app
const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (_req: express.Request, res: express.Response) => {
    res.json({ status: 'Radio FM MCP Server is running' });
});

// MCP endpoint
app.post('/mcp', async (req: express.Request, res: express.Response) => {
    try {
        const { method, params, id } = req.body;

        if (method === 'list_tools') {
            const response = {
                tools: [
                    {
                        name: "search_radio_stations",
                        description: "Search for radio stations and podcasts by name, country, language, or genre",
                        parameters: {
                            type: "object",
                            properties: {
                                query: {
                                    type: "string",
                                    description: "Search query (e.g., 'BBC', 'India', 'Hindi', 'Jazz')"
                                }
                            },
                            required: ["query"],
                            additionalProperties: false
                        },
                        returns: {
                            type: "object",
                            properties: {
                                content: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            type: { type: "string" },
                                            text: { type: "string" }
                                        },
                                        required: ["type", "text"]
                                    }
                                }
                            },
                            required: ["content"]
                        }
                    }
                ],
                schema_version: "1.0"
            };

            return res.json({
                jsonrpc: '2.0',
                id,
                result: response
            });
        }

        if (method === 'call_tool') {
            const { name, arguments: args } = params;

            if (name === 'search_radio_stations') {
                const query = args?.query as string;

                if (!query) {
                    throw new Error("Search query is required");
                }

                const response = await axios.get<ApiResponse>(
                    `${RADIOFM_API_BASE}/new_combo_search.php`,
                    {
                        params: { srch: query },
                        timeout: 15000,
                    }
                );

                const apiData = response.data;

                if (apiData.data.ErrorCode !== 0) {
                    throw new Error(apiData.data.ErrorMessage);
                }

                const results = apiData.data.Data;

                if (!results || results.length === 0) {
                    return res.json({
                        jsonrpc: '2.0',
                        id,
                        result: {
                            content: [{
                                type: "text",
                                text: `🔍 No results found for "${query}"\n\nTry searching with:\n- Station name (e.g., "BBC", "NPR")\n- Country (e.g., "UK", "USA", "India")\n- Language (e.g., "English", "Spanish")\n- Genre (e.g., "Jazz", "News", "Rock")`
                            }]
                        }
                    });
                }

                let resultText = `🎵 **Search Results for "${query}"**\n`;
                resultText += `════════════════════════════════════\n`;

                const radioData = results.find((r) => r.type === "radio");
                if (radioData && radioData.data.length > 0) {
                    const stations = radioData.data as RadioStation[];
                    resultText += `\n📻 **RADIO STATIONS (${stations.length})**\n`;
                    resultText += `────────────────────────────────────\n`;
                    stations.forEach((station, index) => {
                        resultText += formatRadioStation(station, index + 1);
                    });
                }

                const podcastData = results.find((r) => r.type === "podcast");
                if (podcastData && podcastData.data.length > 0) {
                    const podcasts = podcastData.data as Podcast[];
                    resultText += `\n\n🎙️ **PODCASTS (${podcasts.length})**\n`;
                    resultText += `────────────────────────────────────\n`;
                    podcasts.forEach((podcast, index) => {
                        resultText += formatPodcast(podcast, index + 1);
                    });
                }

                resultText += `\n════════════════════════════════════\n`;
                resultText += `💡 Click any deeplink above to play on radiofm.co\n`;

                return res.json({
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [{
                            type: "text",
                            text: resultText
                        }]
                    }
                });
            }

            throw new Error(`Unknown tool: ${name}`);
        }

        throw new Error(`Unknown method: ${method}`);
    } catch (error: any) {
        res.json({
            jsonrpc: '2.0',
            id: req.body.id,
            error: {
                code: -32000,
                message: error.message || 'Internal server error'
            }
        });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Radio FM MCP Server running on http://localhost:${port}`);
});
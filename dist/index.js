import express from 'express';
import cors from 'cors';
import axios from "axios";
// Radio FM API configuration
const RADIOFM_API_BASE = "https://devappradiofm.radiofm.co/rfm/api";
const port = process.env.PORT || 3000;
// Format radio station details
function formatRadioStation(station, index) {
    const lines = [
        `${index}. ${station.st_name}`,
        `Location: ${station.st_city}, ${station.st_state}, ${station.country_name_rs}`,
        `Language: ${station.language}`,
        `Genre: ${station.st_genre}`
    ];
    if (station.st_bc_freq !== "~") {
        lines.push(`Frequency: ${station.st_bc_freq}`);
    }
    lines.push(`Stream: ${station.stream_type} ${station.stream_bitrate}kbps`, `Plays: ${parseInt(station.st_play_cnt).toLocaleString()}`, `Listen:${station.deeplink}`);
    return lines.join('\n');
}
// Format podcast details
function formatPodcast(podcast, index) {
    const lines = [
        `${index}. ${podcast.p_name}`,
        `Category: ${podcast.cat_name}`,
        `Language: ${podcast.p_lang}`
    ];
    if (podcast.p_desc) {
        const shortDesc = podcast.p_desc.length > 100
            ? podcast.p_desc.substring(0, 100) + "..."
            : podcast.p_desc;
        lines.push(`Description: ${shortDesc}`);
    }
    lines.push(`Streams: ${parseInt(podcast.total_stream).toLocaleString()}`, `Listen: ${podcast.deeplink}`);
    return lines.join('\n');
}
// Set up Express app
const app = express();
app.use(cors());
app.use(express.json());
// Health check endpoint
app.get('/', (_req, res) => {
    res.json({
        status: 'Radio FM MCP Server is running',
        version: '1.0.0',
        protocol: 'MCP'
    });
});
// MCP endpoint - handles all MCP protocol requests
app.post('/mcp', async (req, res) => {
    try {
        const { method, params, id } = req.body;
        // Handle initialize method (required for MCP handshake)
        if (method === 'initialize') {
            return res.json({
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: {}
                    },
                    serverInfo: {
                        name: 'radiofm-mcp-server',
                        version: '1.0.0'
                    }
                }
            });
        }
        // Handle tools/list method
        if (method === 'tools/list') {
            return res.json({
                jsonrpc: '2.0',
                id,
                result: {
                    tools: [
                        {
                            name: 'search_radio_stations',
                            description: 'Search for radio stations and podcasts worldwide by name, location, language, or genre',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    query: {
                                        type: 'string',
                                        description: 'Search query (e.g., "BBC", "India", "Hindi", "Jazz")'
                                    }
                                },
                                required: ['query']
                            }
                        }
                    ]
                }
            });
        }
        // Handle tools/call method
        if (method === 'tools/call') {
            const { name, arguments: args } = params;
            if (name === 'search_radio_stations') {
                const query = args?.query;
                if (!query) {
                    throw new Error("Search query is required");
                }
                const response = await axios.get(`${RADIOFM_API_BASE}/new_combo_search.php`, {
                    params: { srch: query },
                    timeout: 15000,
                });
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
                            content: [
                                {
                                    type: 'text',
                                    text: `🔍 No results found for "${query}"\n\nTry searching with:\n- Station name (e.g., "BBC", "NPR")\n- Country (e.g., "UK", "USA", "India")\n- Language (e.g., "English", "Spanish")\n- Genre (e.g., "Jazz", "News", "Rock")`
                                }
                            ]
                        }
                    });
                }
                const sections = [`Search Results for "${query}"`];
                const radioData = results.find((r) => r.type === "radio");
                if (radioData && radioData.data.length > 0) {
                    const stations = radioData.data;
                    sections.push(`\nRADIO STATIONS (${stations.length})`, ...stations.map((station, index) => formatRadioStation(station, index + 1)));
                }
                const podcastData = results.find((r) => r.type === "podcast");
                if (podcastData && podcastData.data.length > 0) {
                    const podcasts = podcastData.data;
                    sections.push(`\nPODCASTS (${podcasts.length})`, ...podcasts.map((podcast, index) => formatPodcast(podcast, index + 1)));
                }
                sections.push('\nTap on any "Listen" link to play on radiofm.co');
                const resultText = sections.join('\n');
                return res.json({
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: resultText
                            }
                        ]
                    }
                });
            }
            throw new Error(`Unknown tool: ${name}`);
        }
        throw new Error(`Unknown method: ${method}`);
    }
    catch (error) {
        console.error('MCP Error:', error);
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
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
});
//# sourceMappingURL=index.js.map
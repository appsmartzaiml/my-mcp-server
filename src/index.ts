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

// Format radio station details
function formatRadioStation(station: RadioStation, index: number): string {
    const lines = [
        `${index}. ${station.st_name}`,
        `Location: ${station.st_city}, ${station.st_state}, ${station.country_name_rs}`,
        `Language: ${station.language}`,
        `Genre: ${station.st_genre}`
    ];

    if (station.st_bc_freq !== "~") {
        lines.push(`Frequency: ${station.st_bc_freq}`);
    }

    lines.push(
        `Stream: ${station.stream_type} ${station.stream_bitrate}kbps`,
        `Plays: ${parseInt(station.st_play_cnt).toLocaleString()}`,
        `Listen:'https://appradiofm.com/radioplay/' ${station.st_shorturl}`
    );

    return lines.join('\n');
}

// Format podcast details
function formatPodcast(podcast: Podcast, index: number): string {
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

    lines.push(
        `Streams: ${parseInt(podcast.total_stream).toLocaleString()}`,
        `Listen: ${podcast.deeplink}`
    );

    return lines.join('\n');
}

// Set up Express app
const app = express();
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (_req: express.Request, res: express.Response) => {
    res.json({
        status: 'Radio FM MCP Server is running',
        version: '1.0.0',
        protocol: 'MCP'
    });
});

// MCP endpoint - handles all MCP protocol requests
app.post('/mcp', async (req: express.Request, res: express.Response) => {
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
                    const stations = radioData.data as RadioStation[];
                    sections.push(
                        `\nRADIO STATIONS (${stations.length})`,
                        ...stations.map((station, index) => formatRadioStation(station, index + 1))
                    );
                }

                // const podcastData = results.find((r) => r.type === "podcast");
                // if (podcastData && podcastData.data.length > 0) {
                //     const podcasts = podcastData.data as Podcast[];
                //     resultText += `\n\n🎙️ **PODCASTS (${podcasts.length})**\n`;
                //     resultText += `────────────────────────────────────\n`;
                //     podcasts.forEach((podcast, index) => {
                //         resultText += formatPodcast(podcast, index + 1);
                //     });
                // }

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
    } catch (error: any) {
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
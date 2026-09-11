import express from "express";
import cors from "cors";
import axios from "axios";
import { existsSync, readFileSync } from "fs";
loadEnvFile();
const RADIOFM_LOGO_BASE = "https://dpi4fupzvxbqq.cloudfront.net/rfm";
const MCP_PUBLIC_URL = process.env.mcp_public_url ||
    `${(process.env.public_base_url || "https://my-mcp-server-flame.vercel.app").replace(/\/$/, "")}/mcp`;
const MCP_PUBLIC_BASE_URL = MCP_PUBLIC_URL.replace(/\/mcp\/?$/, "");
const RADIO_FALLBACK_IMAGE_URL = `${MCP_PUBLIC_BASE_URL}/RadioFallback.png`;
const PODCAST_FALLBACK_IMAGE_URL = `${MCP_PUBLIC_BASE_URL}/PodcastFallback.png`;
// Image hosts allowed by the widget CSP - these skip the /pimg proxy.
const DIRECT_IMAGE_ORIGINS = new Set([
    "https://dpi4fupzvxbqq.cloudfront.net",
    "https://d3t3ozftmdmh3i.cloudfront.net",
    new URL(MCP_PUBLIC_BASE_URL).origin,
]);
const port = process.env.PORT || 3000;
const RADIOFM_WIDGET_URI = "ui://radiofm/search-results-v5.html";
const SERVER_VERSION = "1.1.0";
const RADIOFM_TOOL_DESCRIPTION = [
    "Search live radio stations and podcasts worldwide from the Radio FM catalogue.",
    "Radio-only requests hit the radio filter, podcast-only requests hit the podcast filter,",
    "and anything else runs a combined search.",
    "",
    "FILTER RULE - CRITICAL: only populate a filter the user EXPLICITLY mentioned.",
    "Never infer one filter from another: a city does not imply a state, and a country does",
    "not imply a language (India does NOT mean Hindi).",
    "Do not copy a location, language or genre into `query` - each belongs in its own field.",
    "`query` is for a station or podcast NAME only; leave it empty for any browse request.",
    "",
    "Examples:",
    '  "stations in Mumbai"      -> city="Mumbai", content_type="radio"',
    '  "radio in Texas"          -> state="Texas", content_type="radio"',
    '  "top radio"               -> query="", content_type="radio" (no limit - return the full list)',
    '  "top 10 radio stations"   -> query="", limit=10, content_type="radio"',
    '  "top radio in India"      -> query="", loc="IN", content_type="radio"',
    '  "hindi stations in Delhi" -> city="Delhi", lc="hi", content_type="radio"',
    '  "jazz stations"           -> genre="jazz", content_type="radio"',
    '  "most favourite radio in India" -> query="", loc="IN", sort="favourites", content_type="radio"',
    '  "indian podcasts"         -> query="", loc="IN", content_type="podcast"',
    '  "comedy podcasts"         -> query="", genre="comedy", content_type="podcast"',
    '  "hindi podcasts"          -> query="", lc="hi", content_type="podcast"',
    '  "podcasts from Noida"     -> query="", city="Noida", state="Uttar Pradesh", loc="IN", content_type="podcast"',
    '  "Saharanpur radio"        -> query="", city="Saharanpur", state="Uttar Pradesh", loc="IN", content_type="radio"',
    "",
    "When a city is named, ALWAYS fill in the wider places it sits in too: `state`",
    "and `loc` (Saharanpur -> city=\"Saharanpur\", state=\"Uttar Pradesh\", loc=\"IN\").",
    "A small city often has no stations of its own, and those wider fields are what",
    "the search falls back to. Spell the state out in full - \"Uttar Pradesh\", not \"UP\".",
    '  "BBC"                     -> query="BBC" (everything else empty)',
    "",
    "Only set `limit` when the user asked for a specific number. A plain \"top radio\"",
    "request wants the full list, not one station.",
].join("\n");
const RADIOFM_INPUT_SCHEMA = {
    type: "object",
    properties: {
        query: {
            type: "string",
            description: "Free-text part of the search only - a station or podcast name (e.g. 'BBC', 'Vividh Bharati'). Leave empty for a browse request such as 'top radio stations in India' - a city, state, country, language or genre belongs in its own field, never here.",
        },
        content_type: {
            type: "string",
            enum: ["radio", "podcast", "any"],
            description: "'radio' when the user asked for radio/stations/FM, 'podcast' when they asked for podcasts/episodes, otherwise 'any'.",
        },
        loc: {
            type: "string",
            description: "ISO country code, e.g. 'IN' for India, 'US', 'GB', 'AU'. Only when a country is explicitly named.",
        },
        lc: {
            type: "string",
            description: "Language, e.g. 'hi'/'hindi' or 'en'/'english'. Only when a language is explicitly named - a country never implies a language.",
        },
        city: {
            type: "string",
            description: "City name such as 'Mumbai', 'Saharanpur' or 'Albany'. Only when a city is explicitly named - always set `state` and `loc` for it as well, so a city with no stations can fall back to its state and country.",
        },
        state: {
            type: "string",
            description: "State or province, spelled out in full - 'Texas', 'Uttar Pradesh', 'Maharashtra'. Never an abbreviation such as 'UP' or 'TX'. Set it whenever a state OR a city is named, along with `loc`.",
        },
        genre: {
            type: "string",
            description: "Genre for radio, or podcast category (comedy, true crime, history, technology, news & politics, sports, music, ...). Only when explicitly mentioned.",
        },
        freq: {
            type: "string",
            description: "Broadcast frequency such as '92.7', '94.3' or '1605'.",
        },
        callsign: {
            type: "string",
            description: "Station callsign such as 'WASP' or 'WAMC'.",
        },
        sort: {
            type: "string",
            enum: ["popular", "favourites"],
            description: "'favourites' only when the user asked for the most favourited/liked/loved stations. Otherwise leave unset - results are ranked by play count.",
        },
        limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "How many results to return. Set to 10 for 'top 10', and so on.",
        },
    },
    required: ["query"],
};
// Only counts are advertised to the model. The station and podcast rows travel in
// _meta so the model cannot re-list what the widget already renders.
const RADIOFM_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        query: { type: "string" },
        mode: { type: "string", enum: ["radio", "podcast", "any"] },
        stationCount: { type: "integer" },
        podcastCount: { type: "integer" },
    },
    required: ["query", "stationCount", "podcastCount"],
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
    // st_shorturl is a full short link ("http://rdo.fm/r/e3vvj") on the vector
    // API and a bare slug on the legacy one - the play page wants the slug.
    const slug = (station.st_shorturl || "").split(/[?#]/, 1)[0].split("/").filter(Boolean).pop() || "";
    if (slug)
        return `https://appradiofm.com/radioplay/${slug}`;
    // The vector API sometimes double-prefixes the host in deeplink.
    const deeplink = (station.deeplink || "").replace(/^https?:\/\/appradiofm\.com(?=https?:\/\/)/i, "");
    return deeplink.replace(/^http:\/\/appradiofm\.com/i, "https://appradiofm.com");
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
        // The vector API omits deeplink, so fall back to podcast search on the site.
        return podcast.deeplink || `https://appradiofm.com/search/${encodeURIComponent(podcast.p_name || "")}`;
    }
    const routeParts = [podcast.p_id, imageParam, podcast.p_name, podcast.cat_name]
        .map((part) => encodeURIComponent(part));
    return `https://appradiofm.com/pdetail/${routeParts.join("/")}`;
}
function formatCount(value) {
    const parsed = Number.parseInt(value || "0", 10);
    return Number.isFinite(parsed) ? parsed.toLocaleString() : "0";
}
// ---------------------------------------------------------------------------
// RFM vector search API (radio filter / podcast filter / combo search)
// ---------------------------------------------------------------------------
const RFM_VECTOR_BASE = (process.env.rfm_vector_base || "https://rfmvector.appradiofm.com").replace(/\/$/, "");
const RADIO_FILTER_PATH = "/api/v1/rd";
const PODCAST_FILTER_PATH = "/api/v1/pd";
const COMBO_SEARCH_PATH = "/api/v1/search";
// Hybrid (dense+sparse) podcast search. Separate host from the vector API.
const AIPD_SEARCH_BASE = (process.env.aipd_search_base || "https://aipd-search.appradiofm.com").replace(/\/$/, "");
const AIPD_PODCAST_PATH = "/api/v1/search/pd2";
const AIPD_COLLECTION_NAME = "podcast";
// Overall podcast search. Every parameter is optional and works on its own, so a
// filter-only browse needs no stand-in search term.
const RG_PODCAST_BASE = (process.env.rg_podcast_base || "https://devappradiofm.radiofm.co").replace(/\/$/, "");
const RG_PODCAST_PATH = "/rfm/api/podcast/rg_overall_search.php";
// Filter-driven radio browse API: no free-text search, but it returns the whole
// matching set (ranked by play count) instead of a handful of vector hits.
const RFM_AGENT_BASE = (process.env.rfm_agent_base || "https://devappradiofm.radiofm.co").replace(/\/$/, "");
const RFM_AGENT_PATH = "/rfm/api/rfm_mcp_agent.php";
// fc=1 ranks by favourite count. It is sent only when the user asked for
// favourites; otherwise the parameter is left off and the API ranks by plays.
const DEFAULT_RESULT_LIMIT = 40;
const MAX_RESULT_LIMIT = 100;
const RFM_DEVICE = "android";
const COUNTRY_NAME_TO_ISO = {
    "ascension island": "AC",
    "andorra": "AD",
    "united arab emirates": "AE",
    "afghanistan": "AF",
    "antigua and barbuda": "AG",
    "anguilla": "AI",
    "albania": "AL",
    "armenia": "AM",
    "netherlands antilles": "AN",
    "angola": "AO",
    "antarctica": "AQ",
    "argentina": "AR",
    "american samoa": "AS",
    "austria": "AT",
    "australia": "AU",
    "aruba": "AW",
    "azerbaijan": "AZ",
    "bosnia and herzegovina": "BA",
    "barbados": "BB",
    "bangladesh": "BD",
    "belgium": "BE",
    "burkina faso": "BF",
    "bulgaria": "BG",
    "bahrain": "BH",
    "burundi": "BI",
    "benin": "BJ",
    "bermuda": "BM",
    "brunei": "BN",
    "bolivia": "BO",
    "bonaire": "BQ",
    "brazil": "BR",
    "bahamas": "BS",
    "bhutan": "BT",
    "bouvet island": "BV",
    "botswana": "BW",
    "belarus": "BY",
    "belize": "BZ",
    "canada": "CA",
    "cocos (keeling) islands": "CC",
    "democratic republic of the congo": "CD",
    "central african republic": "CF",
    "republic of the congo": "CG",
    "switzerland": "CH",
    "ivory coast": "CI",
    "cook islands": "CK",
    "chile": "CL",
    "cameroon": "CM",
    "china": "CN",
    "colombia": "CO",
    "costa rica": "CR",
    "cuba": "CU",
    "cape verde": "CV",
    "curacao": "CW",
    "christmas island": "CX",
    "cyprus": "CY",
    "czech republic": "CZ",
    "germany": "DE",
    "diego garcia": "DG",
    "djibouti": "DJ",
    "denmark": "DK",
    "dominica islands": "DM",
    "dominican republic": "DO",
    "algeria": "DZ",
    "ecuador": "EC",
    "estonia": "EE",
    "egypt": "EG",
    "western sahara": "EH",
    "eritrea": "ER",
    "spain": "ES",
    "ethiopia": "ET",
    "finland": "FI",
    "fiji": "FJ",
    "falkland islands (malvinas)": "FK",
    "micronesia": "FM",
    "faroe islands": "FO",
    "france": "FR",
    "france metropolitan": "FX",
    "gabon": "GA",
    "united kingdom": "GB",
    "scotland": "GB-SCT",
    "grenada": "GD",
    "georgia": "GE",
    "french guiana": "GF",
    "guernsey": "GG",
    "ghana": "GH",
    "gibraltar": "GI",
    "greenland": "GL",
    "gambia": "GM",
    "guinea": "GN",
    "guadeloupe": "GP",
    "equatorial guinea": "GQ",
    "greece": "GR",
    "south georgia and the south sandwich islands": "GS",
    "guatemala": "GT",
    "guam": "GU",
    "guinea bissau": "GW",
    "guyana": "GY",
    "hong kong": "HK",
    "heard & mcdonald islands": "HM",
    "honduras": "HN",
    "croatia": "HR",
    "haiti": "HT",
    "hungary": "HU",
    "indonesia": "ID",
    "ireland": "IE",
    "israel": "IL",
    "isle of man": "IM",
    "india": "IN",
    "british indian ocean territory": "IO",
    "iraq": "IQ",
    "iran": "IR",
    "iceland": "IS",
    "italy": "IT",
    "jamaica": "JM",
    "jordan": "JO",
    "japan": "JP",
    "kenya": "KE",
    "kyrgyzstan": "KG",
    "cambodia": "KH",
    "kiribati": "KI",
    "comoros": "KM",
    "st. kitts and nevis": "KN",
    "north korea": "KP",
    "south korea": "KR",
    "kuwait": "KW",
    "cayman islands": "KY",
    "kazakhstan": "KZ",
    "lao people s democratic republic": "LA",
    "lebanon": "LB",
    "saint lucia": "LC",
    "liechtenstein": "LI",
    "sri lanka": "LK",
    "liberia": "LR",
    "lesotho": "LS",
    "lithuania": "LT",
    "luxembourg": "LU",
    "latvia": "LV",
    "state of libya": "LY",
    "morocco": "MA",
    "monaco": "MC",
    "moldova": "MD",
    "montenegro": "ME",
    "madagascar": "MG",
    "marshall islands": "MH",
    "republic of macedonia": "MK",
    "mali": "ML",
    "myanmar (burma)": "MM",
    "mongolia": "MN",
    "macau": "MO",
    "northern mariana islands": "MP",
    "martinique": "MQ",
    "mauritania": "MR",
    "montserrat": "MS",
    "malta": "MT",
    "mauritius": "MU",
    "maldives": "MV",
    "malawi": "MW",
    "mexico": "MX",
    "malaysia": "MY",
    "mozambique": "MZ",
    "namibia": "NA",
    "new caledonia": "NC",
    "niger": "NE",
    "norfolk island": "NF",
    "nigeria": "NG",
    "nicaragua": "NI",
    "netherlands": "NL",
    "norway": "NO",
    "nepal": "NP",
    "nauru": "NR",
    "niue": "NU",
    "new zealand": "NZ",
    "oman": "OM",
    "panama": "PA",
    "peru": "PE",
    "french polynesia": "PF",
    "papua new guinea": "PG",
    "philippines": "PH",
    "pakistan": "PK",
    "poland": "PL",
    "st. pierre & miquelon": "PM",
    "pitcairn": "PN",
    "puerto rico": "PR",
    "palestine": "PS",
    "portugal": "PT",
    "palau": "PW",
    "paraguay": "PY",
    "qatar": "QA",
    "r union": "RE",
    "romania": "RO",
    "rest of world": "ROW",
    "serbia": "RS",
    "russia": "RU",
    "rwanda": "RW",
    "saudi arabia": "SA",
    "solomon islands": "SB",
    "seychelles": "SC",
    "sudan": "SD",
    "sweden": "SE",
    "singapore": "SG",
    "st. helena": "SH",
    "slovenia": "SI",
    "svalbard & jan mayen islands": "SJ",
    "slovakia": "SK",
    "sierra leone": "SL",
    "san marino": "SM",
    "senegal": "SN",
    "somalia": "SO",
    "suriname": "SR",
    "south sudan": "SS",
    "sao tome & principe": "ST",
    "union of soviet socialist republics": "SU",
    "el salvador": "SV",
    "sint maarten": "SX",
    "syria": "SY",
    "swaziland": "SZ",
    "turks & caicos islands": "TC",
    "chad": "TD",
    "french southern territories": "TF",
    "togo": "TG",
    "thailand": "TH",
    "tajikistan": "TJ",
    "tokelau": "TK",
    "turkmenistan": "TM",
    "tunisia": "TN",
    "tonga": "TO",
    "east timor": "TP",
    "turkey": "TR",
    "trinidad and tobago": "TT",
    "tuvalu": "TV",
    "taiwan": "TW",
    "tanzania": "TZ",
    "ukraine": "UA",
    "uganda": "UG",
    "united states minor outlying islands": "UM",
    "united states of america": "US",
    "uruguay": "UY",
    "uzbekistan": "UZ",
    "vatican city state": "VA",
    "st. vincent and the grenadines": "VC",
    "venezuela": "VE",
    "british virgin islands": "VG",
    "united states virgin islands": "VI",
    "vietnam": "VN",
    "vanuatu": "VU",
    "wallis & futuna islands": "WF",
    "samoa": "WS",
    "ceuta": "XC",
    "kosovo": "XK",
    "democratic yemen": "YD",
    "yemen": "YE",
    "mayotte": "YT",
    "yugoslavia": "YU",
    "south africa": "ZA",
    "zambia": "ZM",
    "zaire": "ZR",
    "zimbabwe": "ZW",
};
// Everyday names people actually type, mapped onto the ISO codes above.
const COUNTRY_ALIAS_TO_ISO = {
    "uae": "AE",
    "emirates": "AE",
    "usa": "US",
    "us": "US",
    "u s a": "US",
    "america": "US",
    "united states": "US",
    "states": "US",
    "uk": "GB",
    "u k": "GB",
    "britain": "GB",
    "great britain": "GB",
    "england": "GB",
    "wales": "GB",
    "northern ireland": "GB",
    "scotland": "GB-SCT",
    "holland": "NL",
    "russia federation": "RU",
    "russian federation": "RU",
    "korea": "KR",
    "south korea": "KR",
    "north korea": "KP",
    "vietnam": "VN",
    "viet nam": "VN",
    "laos": "LA",
    "macedonia": "MK",
    "north macedonia": "MK",
    "czechia": "CZ",
    "burma": "MM",
    "myanmar": "MM",
    "ivory coast": "CI",
    "cote d ivoire": "CI",
    "cape verde": "CV",
    "east timor": "TP",
    "timor leste": "TP",
    "congo": "CG",
    "drc": "CD",
    "dr congo": "CD",
    "libya": "LY",
    "vatican": "VA",
    "syria": "SY",
    "bosnia": "BA",
    "brasil": "BR",
    "deutschland": "DE",
    "espana": "ES",
    "bharat": "IN",
    "bhartiya": "IN",
    "bharatiya": "IN",
    "indian": "IN",
    "hindustan": "IN",
};
// The podcast search API matches on ISO 639-1 instead, so codes are translated
// back on the way out.
const ISO_639_2_TO_1 = {
    asm: "as", ara: "ar", ben: "bn", bho: "bh", bul: "bg", chi: "zh", hrv: "hr", ces: "cs",
    dan: "da", nld: "nl", eng: "en", est: "et", fil: "fil", tgl: "tl", fin: "fi", fra: "fr",
    deu: "de", ell: "el", guj: "gu", heb: "he", hin: "hi", hun: "hu", ind: "id", ita: "it",
    jpn: "ja", kan: "kn", kor: "ko", lav: "lv", lit: "lt", msa: "ms", mal: "ml", mar: "mr",
    nep: "ne", nor: "no", ori: "or", fas: "fa", pol: "pl", por: "pt", pan: "pa", ron: "ro",
    rus: "ru", srp: "sr", sin: "si", slk: "sk", slv: "sl", spa: "es", swa: "sw", swe: "sv",
    tam: "ta", tel: "te", tha: "th", tur: "tr", ukr: "uk", urd: "ur", vie: "vi",
};
// The API matches languages on ISO 639-2 codes (mostly /T, with a few /B).
// Verified against the live index - "chi" works where "zho" does not.
const LANGUAGE_TO_ISO_639_2 = {
    "assamese": "asm", "as": "asm",
    "arabic": "ara", "ar": "ara",
    "bengali": "ben", "bangla": "ben", "bn": "ben",
    "bhojpuri": "bho",
    "bulgarian": "bul", "bg": "bul",
    "chinese": "chi", "mandarin": "chi", "cantonese": "chi", "zh": "chi",
    "croatian": "hrv", "hr": "hrv",
    "czech": "ces", "cs": "ces",
    "danish": "dan", "da": "dan",
    "dutch": "nld", "nl": "nld",
    "english": "eng", "en": "eng",
    "estonian": "est", "et": "est",
    "filipino": "fil", "tagalog": "tgl",
    "finnish": "fin", "fi": "fin",
    "french": "fra", "fr": "fra",
    "german": "deu", "de": "deu",
    "greek": "ell", "el": "ell",
    "gujarati": "guj", "gu": "guj",
    "hebrew": "heb", "he": "heb",
    "hindi": "hin", "hi": "hin",
    "hungarian": "hun", "hu": "hun",
    "indonesian": "ind", "id": "ind",
    "italian": "ita", "it": "ita",
    "japanese": "jpn", "ja": "jpn",
    "kannada": "kan", "kn": "kan",
    "korean": "kor", "ko": "kor",
    "latvian": "lav", "lv": "lav",
    "lithuanian": "lit", "lt": "lit",
    "malay": "msa", "ms": "msa",
    "malayalam": "mal", "ml": "mal",
    "marathi": "mar", "mr": "mar",
    "nepali": "nep", "ne": "nep",
    "norwegian": "nor", "no": "nor",
    "odia": "ori", "oriya": "ori", "or": "ori",
    "persian": "fas", "farsi": "fas", "fa": "fas",
    "polish": "pol", "pl": "pol",
    "portuguese": "por", "pt": "por",
    "punjabi": "pan", "panjabi": "pan", "pa": "pan",
    "romanian": "ron", "ro": "ron",
    "russian": "rus", "ru": "rus",
    "serbian": "srp", "sr": "srp",
    "sinhala": "sin", "si": "sin",
    "slovak": "slk", "sk": "slk",
    "slovenian": "slv", "sl": "slv",
    "spanish": "spa", "castellano": "spa", "es": "spa",
    "swahili": "swa", "sw": "swa",
    "swedish": "swe", "sv": "swe",
    "tamil": "tam", "ta": "tam",
    "telugu": "tel", "te": "tel",
    "thai": "tha", "th": "tha",
    "turkish": "tur", "tr": "tur",
    "ukrainian": "ukr", "uk": "ukr",
    "urdu": "urd", "ur": "urd",
    "vietnamese": "vie", "vi": "vie",
};
const GENRE_KEYWORDS = [
    "adult contemporary", "classic rock", "hip hop", "hip-hop", "top 40", "easy listening",
    "world music", "oldies", "bollywood", "devotional", "spiritual", "religious", "gospel",
    "classical", "country", "electronic", "dance", "house", "techno", "trance", "reggae",
    "jazz", "blues", "rock", "metal", "punk", "indie", "alternative", "pop", "rap",
    "folk", "latin", "salsa", "soul", "funk", "disco", "ambient", "chill", "lounge",
    "news", "talk", "sports", "business", "comedy", "culture", "education", "kids",
    "variety", "community", "regional", "traditional", "instrumental", "meditation",
    "80s", "90s", "70s", "60s", "50s",
];
// Words that describe the *shape* of the request rather than what to search for.
const GENERIC_QUERY_TOKENS = new Set([
    "a", "about", "an", "and", "any", "are", "around", "at", "best", "biggest", "channel",
    "channels", "chart", "charts", "episode", "episodes", "featuring", "find", "for", "from",
    "get", "give", "good", "greatest", "hear", "in", "is", "list", "listen", "live", "me",
    "hits", "music", "my", "near", "of", "on", "online", "play", "please", "podcast",
    "podcasts", "popular",
    "program", "programme", "programmes", "programs", "radio", "radios", "rated", "recommend",
    "regarding", "search", "show", "shows", "some", "station", "stations", "stream",
    "song", "songs", "streaming", "suggest", "talk", "the", "to", "top", "tracks", "trending",
    "tune", "want", "what", "which", "world",
]);
// "most favourited stations" asks for a different ranking, not a different filter.
const FAVOURITE_INTENT_TOKENS = new Set([
    "favourite", "favourites", "favourited", "favorite", "favorites", "favorited",
    "fav", "favs", "liked", "loved", "bookmarked",
]);
// Podcast category ids accepted by the overall podcast search API.
const PODCAST_CATEGORY_TO_ID = {
    "comedy": 1,
    "arts": 2,
    "games & hobbies": 3,
    "games and hobbies": 3,
    "games": 3,
    "hobbies": 3,
    "business": 7,
    "motivation": 8,
    "religion & spirituality": 9,
    "religion and spirituality": 9,
    "religion": 9,
    "spirituality": 9,
    "education": 11,
    "arts and design": 12,
    "arts & design": 12,
    "design": 12,
    "health": 13,
    "fashion & beauty": 14,
    "fashion and beauty": 14,
    "fashion": 14,
    "beauty": 14,
    "government & organizations": 16,
    "government and organizations": 16,
    "government": 16,
    "kids & family": 17,
    "kids and family": 17,
    "kids": 17,
    "family": 17,
    "music": 18,
    "news & politics": 19,
    "news and politics": 19,
    "news": 19,
    "politics": 19,
    "science & medicine": 20,
    "science and medicine": 20,
    "science": 20,
    "medicine": 20,
    "society & culture": 21,
    "society and culture": 21,
    "society": 21,
    "culture": 21,
    "sports & recreation": 22,
    "sports and recreation": 22,
    "sports": 22,
    "recreation": 22,
    "tv & film": 23,
    "tv and film": 23,
    "tv": 23,
    "film": 23,
    "movies": 23,
    "technology": 24,
    "tech": 24,
    "storytelling": 33,
    "philosophy": 34,
    "horror and paranormal": 35,
    "horror & paranormal": 35,
    "horror and paranomal": 35,
    "horror": 35,
    "paranormal": 35,
    "true crime": 36,
    "crime": 36,
    "leisure": 37,
    "travel": 38,
    "fiction": 39,
    "crypto": 40,
    "cryptocurrency": 40,
    "marketing": 41,
    "history": 42,
};
// Longest first so "true crime" wins over "crime".
const PODCAST_CATEGORY_MATCH_ORDER = Object.keys(PODCAST_CATEGORY_TO_ID).sort((a, b) => b.length - a.length);
const RADIO_INTENT_TOKENS = new Set([
    "radio", "radios", "station", "stations", "fm", "am", "channel", "channels",
    "broadcast", "broadcasts", "callsign", "frequency", "airwaves",
]);
const PODCAST_INTENT_TOKENS = new Set([
    "podcast", "podcasts", "episode", "episodes", "audiobook", "audiobooks", "series",
]);
function normalizeText(value) {
    return value
        .toLowerCase()
        .replace(/[’']/g, " ")
        .replace(/[^a-z0-9.\- ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/** Turn "India", "IN", "in", "USA" into the ISO code the API expects. */
function resolveCountryCode(value) {
    if (!value)
        return "";
    const raw = value.trim();
    if (!raw)
        return "";
    const upper = raw.toUpperCase();
    if (COUNTRY_ISO_CODES.has(upper))
        return upper;
    const normalized = normalizeText(raw);
    return COUNTRY_NAME_TO_ISO[normalized] || COUNTRY_ALIAS_TO_ISO[normalized] || "";
}
/** Turn "Hindi", "hi", "hin" into the 3-letter code the API matches on. */
function resolveLanguageCode(value) {
    if (!value)
        return "";
    const normalized = normalizeText(value);
    if (!normalized)
        return "";
    if (LANGUAGE_TO_ISO_639_2[normalized])
        return LANGUAGE_TO_ISO_639_2[normalized];
    // Already a 3-letter code such as "hin" or "eng".
    return /^[a-z]{3}$/.test(normalized) ? normalized : "";
}
function clampLimit(value, fallback) {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(MAX_RESULT_LIMIT, Math.max(1, Math.trunc(parsed)));
}
const COUNTRY_ISO_CODES = new Set(Object.values(COUNTRY_NAME_TO_ISO));
// Longest first, so "united arab emirates" wins over "united states".
const COUNTRY_MATCH_ORDER = [
    ...Object.keys(COUNTRY_NAME_TO_ISO),
    ...Object.keys(COUNTRY_ALIAS_TO_ISO),
].sort((a, b) => b.length - a.length);
const LANGUAGE_MATCH_ORDER = Object.keys(LANGUAGE_TO_ISO_639_2)
    // A bare 2-letter code is too easy to hit by accident inside free text.
    .filter((name) => name.length > 2)
    .sort((a, b) => b.length - a.length);
const GENRE_MATCH_ORDER = [...GENRE_KEYWORDS].sort((a, b) => b.length - a.length);
class NotDeployedError extends Error {
    constructor(path) {
        super(`Endpoint ${path} is not available`);
        this.name = "NotDeployedError";
    }
}
/**
 * Work out which endpoint to hit and which filters to send.
 *
 * Filters supplied by the caller always win; anything left blank is inferred
 * from the raw query. Inference only ever fires on an explicit mention - a
 * city never implies a state, and a country never implies a language.
 */
function buildSearchIntent(args) {
    const rawQuery = String(args?.query ?? args?.srch ?? "").trim();
    let working = normalizeText(rawQuery);
    const explicitLoc = resolveCountryCode(args?.loc ?? args?.country);
    const explicitLc = resolveLanguageCode(args?.lc ?? args?.language);
    const explicitCity = String(args?.city ?? args?.ct ?? "").trim();
    const explicitState = String(args?.state ?? args?.st ?? "").trim();
    const explicitGenre = String(args?.genre ?? "").trim();
    const explicitFreq = String(args?.freq ?? args?.frequency ?? "").trim();
    const explicitCallsign = String(args?.callsign ?? "").trim();
    const explicitType = String(args?.content_type ?? args?.type ?? "").trim().toLowerCase();
    let mode = explicitType === "radio" || explicitType === "podcast" ? explicitType : "any";
    let limit = clampLimit(args?.limit, 0) || 0;
    let loc = explicitLoc;
    let lc = explicitLc;
    let genre = explicitGenre;
    let freq = explicitFreq;
    const callsign = explicitCallsign;
    const cut = (pattern) => {
        const match = working.match(pattern);
        if (!match)
            return "";
        working = `${working.slice(0, match.index)} ${working.slice((match.index || 0) + match[0].length)}`
            .replace(/\s+/g, " ")
            .trim();
        return match[1] ?? match[0];
    };
    // "top 10 ...", "10 best ...", "show me 5 stations"
    if (!limit) {
        const counted = cut(/\b(?:top|best|first|any)\s+(\d{1,3})\b/) ||
            cut(/\b(\d{1,3})\s+(?:top|best|good|popular)\b/) ||
            cut(/\b(\d{1,3})\s+(?:radio|station|stations|podcast|podcasts|channel|channels)\b/);
        limit = clampLimit(counted, 0) || 0;
    }
    // A frequency is either decimal (92.7) or carries an FM/AM/MHz marker.
    if (!freq) {
        freq =
            cut(/\b(\d{2,4}\.\d{1,2})\s*(?:fm|am|mhz|khz)?\b/) ||
                cut(/\b(\d{2,4})\s*(?:fm|am|mhz|khz)\b/) ||
                "";
    }
    // Longest country name first so "united arab emirates" beats "united".
    if (!loc) {
        for (const name of COUNTRY_MATCH_ORDER) {
            const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:\\s|$)`);
            if (pattern.test(working)) {
                loc = COUNTRY_NAME_TO_ISO[name] || COUNTRY_ALIAS_TO_ISO[name] || "";
                working = working.replace(pattern, " ").replace(/\s+/g, " ").trim();
                break;
            }
        }
    }
    if (!lc) {
        for (const name of LANGUAGE_MATCH_ORDER) {
            const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:\\s|$)`);
            if (pattern.test(working)) {
                lc = LANGUAGE_TO_ISO_639_2[name];
                working = working.replace(pattern, " ").replace(/\s+/g, " ").trim();
                break;
            }
        }
    }
    if (!genre) {
        for (const name of GENRE_MATCH_ORDER) {
            const pattern = new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:\\s|$)`);
            if (pattern.test(working)) {
                genre = name;
                working = working.replace(pattern, " ").replace(/\s+/g, " ").trim();
                break;
            }
        }
    }
    const tokens = working.split(" ").filter(Boolean);
    const favourites = String(args?.sort ?? "").trim().toLowerCase().startsWith("fav") ||
        args?.favourites === true ||
        tokens.some((token) => FAVOURITE_INTENT_TOKENS.has(token));
    if (mode === "any") {
        const wantsRadio = tokens.some((token) => RADIO_INTENT_TOKENS.has(token));
        const wantsPodcast = tokens.some((token) => PODCAST_INTENT_TOKENS.has(token));
        if (wantsRadio && !wantsPodcast)
            mode = "radio";
        else if (wantsPodcast && !wantsRadio)
            mode = "podcast";
        // A frequency or callsign only ever describes a radio station, and the
        // "fm" that signalled it has already been consumed by the freq match.
        else if (!wantsPodcast && (freq || callsign))
            mode = "radio";
    }
    let srch = tokens
        .filter((token) => !GENERIC_QUERY_TOKENS.has(token) && !FAVOURITE_INTENT_TOKENS.has(token))
        .join(" ")
        .trim();
    // "fm"/"am" carry meaning inside a station name ("Red FM") but not on their own.
    if (/^(?:fm|am|fm am|am fm)$/.test(srch))
        srch = "";
    // A filter-only or browse-only request has nothing left to search for.
    if (!srch && !loc && !lc && !genre && !freq && !callsign && !explicitCity && !explicitState) {
        return {
            mode,
            srch: "",
            loc: "",
            lc: "",
            city: "",
            state: "",
            genre: "",
            freq: "",
            callsign: "",
            limit: limit || DEFAULT_RESULT_LIMIT,
            explore: true,
            favourites,
        };
    }
    return {
        mode,
        srch,
        loc,
        lc,
        city: explicitCity,
        state: explicitState,
        genre,
        freq,
        callsign,
        // explore=true makes the API ignore every other filter, so it is only
        // ever used for the unfiltered "just show me something" case above.
        explore: false,
        favourites,
        limit: limit || DEFAULT_RESULT_LIMIT,
    };
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function toFormBody(filters) {
    const body = new URLSearchParams();
    body.set("srch", filters.srch);
    body.set("device", RFM_DEVICE);
    body.set("limit", String(filters.limit));
    if (filters.loc)
        body.set("loc", filters.loc);
    if (filters.lc)
        body.set("lc", filters.lc);
    if (filters.callsign)
        body.set("callsign", filters.callsign);
    if (filters.genre)
        body.set("genre", filters.genre);
    if (filters.freq)
        body.set("freq", filters.freq);
    if (filters.explore)
        body.set("explore", "true");
    return body;
}
function readResults(payload) {
    const blocks = payload?.data?.Data;
    // ErrorCode arrives as a number from the legacy API and a string from the
    // vector API, and "-1" simply means "nothing matched".
    if (!blocks?.length || Number(payload?.data?.ErrorCode ?? -1) !== 0) {
        return { stations: [], podcasts: [] };
    }
    const radioBlock = blocks.find((block) => block.type === "radio");
    const podcastBlock = blocks.find((block) => block.type === "podcast");
    return {
        stations: radioBlock?.data || [],
        podcasts: podcastBlock?.data || [],
    };
}
function isEmpty(results) {
    return !results.stations.length && !results.podcasts.length;
}
async function postFilter(path, filters) {
    const response = await axios.post(`${RFM_VECTOR_BASE}${path}`, toFormBody(filters).toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 35000,
        validateStatus: (status) => status < 500,
    });
    // /api/v1/pd is not deployed on every environment yet.
    if (response.status === 404)
        throw new NotDeployedError(path);
    return { ...readResults(response.data), endpoint: path };
}
/** The browse API names the country field `country_name`; everything else expects `country_name_rs`. */
function toRadioStation(row) {
    return {
        st_id: String(row.st_id ?? ""),
        st_name: row.st_name,
        st_logo: row.st_logo,
        st_weburl: row.st_weburl,
        st_shorturl: row.st_shorturl,
        st_genre: row.st_genre,
        st_lang: row.st_lang,
        language: row.language,
        st_bc_freq: "",
        st_city: row.st_city,
        st_state: row.st_state,
        country_name_rs: row.country_name,
        st_country: row.st_country,
        st_play_cnt: String(row.st_play_cnt ?? ""),
        st_fav_cnt: String(row.st_fav_cnt ?? ""),
        stream_link: row.stream_link,
        stream_type: row.stream_type,
        stream_bitrate: String(row.stream_bitrate ?? ""),
        deeplink: "",
    };
}
/**
 * A city the catalogue has no stations for should fall back to its state, and a
 * state with none to its country, rather than straight to an unfiltered list.
 * Each step drops exactly one level of location, and only while a broader one
 * is still available to fall back to.
 */
function radioBrowseSteps(intent) {
    const base = { ...intent };
    const steps = [base];
    if (base.city && (base.state || base.loc)) {
        steps.push({ ...base, city: "" });
    }
    if (base.state && base.loc) {
        steps.push({ ...base, city: "", state: "" });
    }
    // A country with a language or genre that matches nothing there is still
    // better answered by the whole country than by nothing at all.
    if (base.loc && (base.lc || base.genre)) {
        steps.push({ ...base, city: "", state: "", lc: "", genre: "" });
    }
    return steps;
}
/**
 * Radio browse by country / language / city / state / genre. Used for requests
 * that name filters but no station, where the vector index returns only a few
 * near matches and the user asked for the full list.
 */
async function agentRadioBrowse(filters) {
    const response = await axios.get(`${RFM_AGENT_BASE}${RFM_AGENT_PATH}`, {
        params: {
            cc: filters.loc || undefined,
            lc: filters.lc || undefined,
            gn: filters.genre || undefined,
            ct: filters.city || undefined,
            st: filters.state || undefined,
            fc: filters.favourites ? 1 : undefined,
            page: 1,
            limit: filters.limit,
        },
        timeout: 35000,
        validateStatus: (status) => status < 500,
    });
    if (response.status === 404)
        throw new NotDeployedError(RFM_AGENT_PATH);
    const rows = response.data?.Data?.data;
    // This API reports success as ErrorCode 1, unlike the vector API's 0.
    if (!Array.isArray(rows) || !rows.length) {
        return { stations: [], podcasts: [], endpoint: RFM_AGENT_PATH };
    }
    return {
        stations: rows.filter((row) => row?.st_id).map(toRadioStation),
        podcasts: [],
        endpoint: RFM_AGENT_PATH,
    };
}
/** Category words map to the numeric cat_id the podcast API filters on. */
function resolvePodcastCategoryId(...candidates) {
    for (const candidate of candidates) {
        const normalized = normalizeText(candidate);
        if (!normalized)
            continue;
        const direct = PODCAST_CATEGORY_TO_ID[normalized];
        if (direct)
            return direct;
        for (const name of PODCAST_CATEGORY_MATCH_ORDER) {
            if (new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:\\s|$)`).test(normalized)) {
                return PODCAST_CATEGORY_TO_ID[name];
            }
        }
    }
    return undefined;
}
/**
 * Overall podcast search: free text plus country / language / category, any of
 * which may stand alone. It has no limit parameter, so results are trimmed here.
 */
async function rgPodcastSearch(filters) {
    const categoryId = resolvePodcastCategoryId(filters.genre, filters.srch);
    // The category word has done its job as cat_id; leaving it in `s` as well
    // narrows the text match to podcasts with it in the title.
    const searchText = [filters.srch, categoryId ? "" : filters.genre]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(" ")
        .trim();
    const response = await axios.get(`${RG_PODCAST_BASE}${RG_PODCAST_PATH}`, {
        params: {
            s: searchText || undefined,
            cc: filters.loc ? filters.loc.toLowerCase() : undefined,
            lc: ISO_639_2_TO_1[filters.lc] || undefined,
            cat_id: categoryId,
        },
        timeout: 35000,
        validateStatus: (status) => status < 500,
    });
    if (response.status === 404)
        throw new NotDeployedError(RG_PODCAST_PATH);
    const rows = response.data?.data?.Data;
    if (!Array.isArray(rows) || Number(response.data?.data?.ErrorCode ?? -1) !== 0) {
        return { stations: [], podcasts: [], endpoint: RG_PODCAST_PATH };
    }
    return {
        stations: [],
        podcasts: rows.filter((podcast) => podcast?.p_id).slice(0, filters.limit),
        endpoint: RG_PODCAST_PATH,
    };
}
/**
 * The hybrid endpoint has no filter fields, so everything the user typed has to
 * collapse back into one search string. A word like "comedy" or "news" is parsed
 * out as a genre for the radio indexes but is plain search text for podcasts.
 */
function hybridPodcastQuery(filters) {
    return [filters.srch, filters.genre, filters.callsign].map((part) => part.trim()).filter(Boolean).join(" ");
}
/**
 * Hybrid podcast search. Takes only `srch` (no location/language/genre filters)
 * and applies no server-side limit, so results are trimmed here.
 */
async function podcastHybridSearch(filters) {
    const response = await axios.get(`${AIPD_SEARCH_BASE}${AIPD_PODCAST_PATH}`, {
        params: { srch: hybridPodcastQuery(filters), collection_name: AIPD_COLLECTION_NAME },
        timeout: 35000,
        validateStatus: (status) => status < 500,
    });
    if (response.status === 404)
        throw new NotDeployedError(AIPD_PODCAST_PATH);
    const rows = response.data?.data?.Data;
    if (!Array.isArray(rows) || Number(response.data?.data?.ErrorCode ?? -1) !== 0) {
        return { stations: [], podcasts: [], endpoint: AIPD_PODCAST_PATH };
    }
    // /pd2 returns podcasts flat; the older /pd wraps them in `list` blocks.
    const podcasts = rows.flatMap((row) => (Array.isArray(row?.list) ? row.list : [row]));
    return {
        stations: [],
        podcasts: podcasts.filter((podcast) => podcast?.p_id).slice(0, filters.limit),
        endpoint: AIPD_PODCAST_PATH,
    };
}
async function comboSearch(filters) {
    const response = await axios.get(`${RFM_VECTOR_BASE}${COMBO_SEARCH_PATH}`, {
        params: { srch: filters.srch, device: RFM_DEVICE, limit: filters.limit },
        timeout: 35000,
        validateStatus: (status) => status < 500,
    });
    return { ...readResults(response.data), endpoint: COMBO_SEARCH_PATH };
}
/**
 * Filters are ANDed server-side, so an over-specified request often matches
 * nothing. Relax it a step at a time rather than returning an empty widget.
 */
function relaxationSteps(intent) {
    const base = { ...intent };
    const steps = [base];
    if (base.genre && base.lc)
        steps.push({ ...base, genre: "" });
    if (base.lc || base.genre)
        steps.push({ ...base, lc: "", genre: "" });
    if (base.freq && (base.lc || base.genre))
        steps.push({ ...base, lc: "", genre: "", freq: "" });
    // A genre- or frequency-only request that those indexes do not know about:
    // search for it as text instead.
    if (!base.srch && base.genre) {
        steps.push({ ...base, srch: base.genre, genre: "", lc: "" });
    }
    if (!base.srch && base.freq) {
        steps.push({ ...base, srch: base.freq, freq: "", genre: "", lc: "" });
    }
    if (base.srch && (base.loc || base.lc || base.genre || base.freq || base.callsign)) {
        steps.push({ ...base, loc: "", lc: "", genre: "", freq: "", callsign: "" });
    }
    return steps;
}
async function runSearch(intent) {
    const steps = relaxationSteps(intent);
    // Podcast text searches go to the hybrid endpoint first; it has no filter
    // support, so browse-style requests (no srch) still use the vector API.
    if (intent.mode === "podcast") {
        try {
            const searched = await rgPodcastSearch(intent);
            if (!isEmpty(searched))
                return searched;
        }
        catch (err) {
            console.error("Podcast search failed, falling back:", err);
        }
    }
    if (intent.mode === "podcast" && hybridPodcastQuery(intent)) {
        try {
            const hybrid = await podcastHybridSearch(intent);
            if (!isEmpty(hybrid))
                return hybrid;
        }
        catch (err) {
            console.error("Hybrid podcast search failed, falling back:", err);
        }
    }
    // A radio request with filters but no station name is a browse, not a search.
    // The browse API has no free-text field, so named stations still go to the
    // vector index below.
    if (intent.mode === "radio" && !intent.srch && !intent.freq && !intent.callsign) {
        try {
            for (const filters of radioBrowseSteps(intent)) {
                const browsed = await agentRadioBrowse(filters);
                if (!isEmpty(browsed))
                    return browsed;
            }
        }
        catch (err) {
            console.error("Radio browse failed, falling back:", err);
        }
    }
    if (intent.mode === "radio" || intent.mode === "podcast") {
        const path = intent.mode === "radio" ? RADIO_FILTER_PATH : PODCAST_FILTER_PATH;
        try {
            for (const filters of steps) {
                const results = await postFilter(path, filters);
                if (!isEmpty(results))
                    return results;
            }
            const broad = await comboSearchWithFallback(intent, []);
            return intent.mode === "podcast"
                ? { ...broad, stations: [] }
                : { ...broad, podcasts: [] };
        }
        catch (err) {
            if (!(err instanceof NotDeployedError))
                throw err;
            // Fall through to the combo endpoint and keep only the wanted type.
            const results = await comboSearchWithFallback(intent, steps);
            return intent.mode === "podcast"
                ? { ...results, stations: [] }
                : { ...results, podcasts: [] };
        }
    }
    return comboSearchWithFallback(intent, steps);
}
async function comboSearchWithFallback(intent, steps) {
    // The combo endpoint takes no filters, so feed it the most descriptive text
    // we have; fall back to the radio filter when there is nothing to type.
    let text = [intent.srch, intent.genre, intent.callsign, intent.freq]
        .filter(Boolean)
        .join(" ")
        .trim();
    if (!text && intent.mode === "podcast")
        text = "podcast";
    if (text) {
        const results = await comboSearch({ ...intent, srch: text });
        if (!isEmpty(results))
            return results;
    }
    for (const filters of steps) {
        const results = await postFilter(RADIO_FILTER_PATH, filters);
        if (!isEmpty(results))
            return results;
    }
    return { stations: [], podcasts: [], endpoint: RADIO_FILTER_PATH };
}
// "Warschaw, Warschaw, Poland" -> "Warschaw, Poland": drop the state when it repeats the city.
function stationLocation(station) {
    const city = titleCaseIfLower(station.st_city);
    let state = titleCaseIfLower(station.st_state);
    if (state.toLowerCase() === city.toLowerCase())
        state = "";
    const country = titleCaseIfLower(station.country_name_rs) || countryNameFromCode(station.st_country);
    return [city, state, country].filter(Boolean).join(", ");
}
// The combo search API sends places all lowercase ("lesser poland"). Text that
// already has capitals ("USA", "Kraków") is left as the API wrote it.
function titleCaseIfLower(value) {
    const trimmed = (value || "").trim();
    if (trimmed !== trimmed.toLowerCase())
        return trimmed;
    return trimmed.replace(/(^|[\s\-(])(\p{L})/gu, (_match, lead, letter) => lead + letter.toUpperCase());
}
const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
// The combo search API often leaves city/state/country blank but always sends
// st_country ("gb"), so the card can still show "United Kingdom".
function countryNameFromCode(code) {
    const upper = (code || "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(upper))
        return "";
    try {
        const name = REGION_NAMES.of(upper) || "";
        return name === upper ? "" : name;
    }
    catch {
        return "";
    }
}
function countValue(value) {
    const parsed = Number.parseInt(value || "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
}
/**
 * showFavourites: only the radio agent API sends real favourite counts - the
 * vector /rd and combo APIs send "0" for every station, so the card hides them.
 */
function buildStationViews(stations, showFavourites) {
    return stations.map((station) => ({
        id: station.st_id,
        name: station.st_name,
        logoPath: station.st_logo,
        logoUrl: absoluteUrl(RADIOFM_LOGO_BASE, station.st_logo),
        fallbackImageUrl: RADIO_FALLBACK_IMAGE_URL,
        url: stationWebsiteUrl(station),
        location: stationLocation(station),
        language: station.language,
        // Cards show one line of genres; the first three are enough.
        genre: (station.st_genre || "").split(",").map((genre) => genre.trim()).filter(Boolean).slice(0, 3).join(", "),
        stream: `${(station.stream_type || "").toUpperCase()} ${station.stream_bitrate}kbps`,
        plays: formatCount(station.st_play_cnt),
        playCount: countValue(station.st_play_cnt),
        favouriteCount: showFavourites ? countValue(station.st_fav_cnt) : null,
    }));
}
/**
 * Podcast art is hosted on whichever CDN the publisher uses (megaphone, acast,
 * buzzsprout, iono...), which no widget CSP allowlist can keep up with, so it
 * is served back through this origin instead.
 */
function proxiedImageUrl(imageUrl) {
    if (!imageUrl)
        return "";
    if (!/^https?:\/\//i.test(imageUrl))
        return imageUrl;
    // RadioFM's own CDNs (e.g. /podcast/200/<id>.jpg, not just /rfm) are already
    // in the widget CSP, so they load directly.
    let origin = "";
    try {
        origin = new URL(imageUrl).origin;
    }
    catch {
        return imageUrl;
    }
    if (DIRECT_IMAGE_ORIGINS.has(origin))
        return imageUrl;
    return `${MCP_PUBLIC_BASE_URL}/pimg?u=${encodeURIComponent(imageUrl)}`;
}
function buildPodcastViews(podcasts) {
    return podcasts.map((podcast) => ({
        id: podcast.p_id,
        name: podcast.p_name,
        imageUrl: proxiedImageUrl(absoluteUrl(RADIOFM_LOGO_BASE, podcast.p_image)),
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
    .card { display: flex; flex-direction: column; align-items: flex-start; border: 1px solid #ddd; border-radius: 8px; padding: 12px; background: #fff; min-width: 0; }
    .card > * { max-width: 100%; }
    .logoButton { display: block; width: 100%; padding: 0; border: 0; background: #f6f7f9; border-radius: 4px; cursor: pointer; }
    .logo { display: block; width: 100%; aspect-ratio: 1 / 1; object-fit: contain; border-radius: 4px; }
    .name { font-size: 15px; line-height: 1.3; margin: 10px 0 4px; width: 100%; min-height: 1.3em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { font-size: 12px; line-height: 1.4; margin: 0 0 6px; color: #555; overflow-wrap: anywhere; }
    .oneLine { width: 100%; min-height: 1.4em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .card .listen { margin-top: auto; }
    .stats { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
    .stat { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 12px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; cursor: default; }
    .stat svg { width: 12px; height: 12px; flex: none; }
    .stat.plays { background: #F1ECFE; color: #5B3FD6; }
    .stat.favs { background: #FDECEF; color: #D6336C; }
    .subtle { color: #777; }
    .listen { display: inline-block; background: linear-gradient(to bottom, #865AF7, #2C5BD1); color: #fff; border: 0; padding: 8px 14px; border-radius: 4px; font-size: 14px; font-weight: 600; cursor: pointer; }
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
      el.title = text(value);
      parent.appendChild(el);
      return el;
    }

    const STAT_ICONS = {
      plays: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5z"/></svg>',
      favs: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 20.6s-7.4-4.5-9.2-9.3C1.6 8 3.7 4.6 7.1 4.6c2 0 3.5 1.1 4.9 2.8 1.4-1.7 2.9-2.8 4.9-2.8 3.4 0 5.5 3.4 4.3 6.7-1.8 4.8-9.2 9.3-9.2 9.3z"/></svg>'
    };
    const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

    // Pill with an icon and a short count ("86.3M"); the exact figure is in the tooltip.
    function appendStat(parent, kind, count, label) {
      const value = Number(count) || 0;
      const el = document.createElement("span");
      el.className = "stat " + kind;
      el.title = value.toLocaleString("en") + " " + label;
      el.setAttribute("aria-label", el.title);
      el.innerHTML = STAT_ICONS[kind];
      const number = document.createElement("span");
      number.textContent = compactNumber.format(value);
      el.appendChild(number);
      parent.appendChild(el);
    }

    function appendStationStats(card, station) {
      const row = document.createElement("div");
      row.className = "stats";
      appendStat(row, "plays", station.playCount, "plays");
      // Only the radio-only APIs send a real favourite count; the server leaves it null otherwise.
      if (station.favouriteCount != null) appendStat(row, "favs", station.favouriteCount, "favourites");
      card.appendChild(row);
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
      setHidden(stationsTitleEl, true);
      setHidden(podcastsTitleEl, true);
      stationsCountEl.textContent = "";
      podcastsCountEl.textContent = "";
      setHidden(loadMoreStationsEl, true);
      setHidden(loadMorePodcastsEl, true);
      renderSkeletonCards(stationsEl, 6);
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
      const mode = text(data && data.mode) || "any";
      const showStations = mode !== "podcast";
      const showPodcasts = mode !== "radio";
      const stations = showStations && Array.isArray(data && data.stations) ? data.stations : [];
      const podcasts = showPodcasts && Array.isArray(data && data.podcasts) ? data.podcasts : [];

      titleEl.textContent = query ? 'Search Results for "' + query + '"' : (hasResult ? "RadioFM results" : "Loading...");
      stationsEl.replaceChildren();
      podcastsEl.replaceChildren();
      setHidden(stationsTitleEl, !hasResult || !showStations);
      setHidden(podcastsTitleEl, !hasResult || !showPodcasts);
      setHidden(loadMoreStationsEl, true);
      setHidden(loadMorePodcastsEl, true);

      if (!hasResult) {
        renderLoading();
        return;
      }

      stationsCountEl.textContent = "(" + stations.length + ")";
      podcastsCountEl.textContent = "(" + podcasts.length + ")";

      if (showStations && !stations.length) {
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
        appendText(card, "p", "meta oneLine", station.location);
        appendText(card, "p", "meta oneLine", [station.language, station.genre].filter(Boolean).join(" - "));
        appendText(card, "p", "meta subtle oneLine", station.stream);
        appendStationStats(card, station);

        const listen = document.createElement("button");
        listen.className = "listen";
        listen.type = "button";
        listen.textContent = "Listen";
        listen.onclick = () => openUrl(station.url);
        card.appendChild(listen);

        stationsEl.appendChild(card);
      }
      setHidden(loadMoreStationsEl, visibleStationCount >= stations.length);

      if (showPodcasts && !podcasts.length) {
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
        appendText(card, "p", "meta oneLine", [podcast.category, podcast.language].filter(Boolean).join(" - "));

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

    function hasResults(value) {
      return !!value && (Array.isArray(value.stations) || Array.isArray(value.podcasts));
    }

    // The full result set travels in _meta so the model never sees it and cannot
    // re-list the stations under the widget. structuredContent stays as a fallback.
    function pickPayload(output, meta) {
      const fromMeta = meta && meta.radiofm;
      if (hasResults(fromMeta)) return fromMeta;
      if (hasResults(output)) return output;
      return fromMeta || output;
    }

    render(pickPayload(
      window.openai && window.openai.toolOutput,
      window.openai && window.openai.toolResponseMetadata
    ));

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method === "ui/notifications/tool-result") {
        const params = message.params || {};
        render(pickPayload(params.structuredContent, params._meta));
      }
    }, { passive: true });

    window.addEventListener("openai:set_globals", (event) => {
      const globals = (event.detail && event.detail.globals) || {};
      const payload = pickPayload(globals.toolOutput, globals.toolResponseMetadata);
      if (hasResults(payload)) render(payload);
    }, { passive: true });
  </script>
</body>
</html>
    `.trim();
}
function buildTextSummary(query, stations, podcasts) {
    const parts = [];
    if (stations.length)
        parts.push(`${stations.length} radio station${stations.length === 1 ? "" : "s"}`);
    if (podcasts.length)
        parts.push(`${podcasts.length} podcast${podcasts.length === 1 ? "" : "s"}`);
    const found = parts.length ? parts.join(" and ") : "no matches";
    const subject = query ? `"${query}"` : "this request";
    // Names are deliberately omitted: the widget above already lists every result,
    // so repeating them here would show the user the same stations twice.
    return `Displayed ${found} for ${subject} in the Radio FM widget above. The user can already see the full list, so do not repeat, name, or re-list any station or podcast — reply with at most one short sentence.`;
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
// Podcast artwork proxy - see proxiedImageUrl().
app.get("/pimg", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const target = String(req.query.u || "");
    let parsed;
    try {
        parsed = new URL(target);
    }
    catch {
        return res.redirect(302, PODCAST_FALLBACK_IMAGE_URL);
    }
    const host = parsed.hostname.toLowerCase();
    const isPrivateHost = parsed.protocol !== "https:" ||
        host === "localhost" ||
        host.endsWith(".local") ||
        /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
        host === "[::1]";
    if (isPrivateHost) {
        return res.redirect(302, PODCAST_FALLBACK_IMAGE_URL);
    }
    try {
        const upstream = await axios.get(parsed.toString(), {
            responseType: "arraybuffer",
            timeout: 10000,
            maxRedirects: 3,
            maxContentLength: 8 * 1024 * 1024,
        });
        const contentType = String(upstream.headers["content-type"] || "");
        if (!contentType.startsWith("image/")) {
            return res.redirect(302, PODCAST_FALLBACK_IMAGE_URL);
        }
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        return res.send(Buffer.from(upstream.data));
    }
    catch {
        return res.redirect(302, PODCAST_FALLBACK_IMAGE_URL);
    }
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
                    description: RADIOFM_TOOL_DESCRIPTION,
                    inputSchema: RADIOFM_INPUT_SCHEMA,
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
                            description: RADIOFM_TOOL_DESCRIPTION,
                            inputSchema: RADIOFM_INPUT_SCHEMA,
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
            const intent = buildSearchIntent(args || {});
            const query = String(args?.query ?? "").trim();
            if (!query && !intent.srch && !intent.loc && !intent.lc && !intent.city && !intent.state && !intent.genre && !intent.freq && !intent.callsign && !intent.explore) {
                throw new Error("Search query is required");
            }
            const { stations, podcasts, endpoint } = await runSearch(intent);
            if (!stations.length && !podcasts.length) {
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
            }
            const stationViews = buildStationViews(stations, endpoint === RFM_AGENT_PATH);
            const podcastViews = buildPodcastViews(podcasts);
            const textSummary = buildTextSummary(query, stations, podcasts);
            return res.json({
                jsonrpc: "2.0",
                id,
                result: {
                    structuredContent: {
                        query,
                        mode: intent.mode,
                        stationCount: stationViews.length,
                        podcastCount: podcastViews.length,
                    },
                    content: [
                        {
                            type: "text",
                            text: textSummary,
                        },
                    ],
                    _meta: {
                        "openai/outputTemplate": RADIOFM_WIDGET_URI,
                        "openai/widgetDescription": "Radio FM search results are already listed in the widget. Do not repeat or re-list them in the reply.",
                        radiofm: {
                            query,
                            mode: intent.mode,
                            stations: stationViews,
                            podcasts: podcastViews,
                        },
                        resultCount: {
                            stations: stations.length,
                            podcasts: podcasts.length,
                        },
                        appliedFilters: {
                            endpoint,
                            srch: intent.srch,
                            loc: intent.loc,
                            lc: intent.lc,
                            genre: intent.genre,
                            freq: intent.freq,
                            callsign: intent.callsign,
                            limit: intent.limit,
                            explore: intent.explore,
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
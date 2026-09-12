import { resolveViaMusicFetch } from './musicfetch_resolver.js';
import { toJSON } from 'seroval';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseSerovalResponse } from './seroval_parser.js';
import { getValidAccessToken, refreshAccessToken } from './token_manager.js';
import { resolveTrackDirect } from './spotify_resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HASH_MAP_PATH = path.join(__dirname, 'hash_map.json');
const CATALOG_PATH = path.join(__dirname, 'distributors_catalog.json');

// In-memory cache for resolved tracks
const trackCache = new Map();

// Load local hash dictionary
export function getHashMap() {
    try {
        if (fs.existsSync(HASH_MAP_PATH)) {
            return JSON.parse(fs.readFileSync(HASH_MAP_PATH, 'utf-8'));
        }
    } catch (e) {}
    return {};
}

export function getDistributorCatalog() {
    try {
        if (fs.existsSync(CATALOG_PATH)) {
            return JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
        }
    } catch (e) {}
    return [];
}

export function findCatalogMatch(name) {
    if (!name) return null;
    const clean = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!clean || clean.length < 3) return null;
    const catalog = getDistributorCatalog();
    for (const item of catalog) {
        const itemClean = item.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        if (clean === itemClean) return item;
    }
    for (const item of catalog) {
        const itemClean = item.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        if (itemClean.length >= 6 && (clean === itemClean || clean.includes(itemClean))) {
            return item;
        }
    }
    return null;
}

export function saveHashMapping(hash, name) {
    if (!hash || !name) return;
    const map = getHashMap();
    map[hash.trim().toLowerCase()] = name.trim();
    trackCache.clear();
    try {
        fs.writeFileSync(HASH_MAP_PATH, JSON.stringify(map, null, 2), 'utf-8');
        console.log(`Saved new hash mapping: ${hash} -> ${name}`);
    } catch (e) {
        console.error('Error saving hash_map.json:', e.message);
    }
}

/**
 * Resolves the 100% legal, uneditable distributor behind a track via official DDEX Art Track feeds
 */
export async function resolveRealDistributorViaDDEX(trackName, artistName, isrc, upc) {
    const queries = [];
    if (isrc) queries.push(`"${isrc}" Provided to YouTube by`);
    if (upc) queries.push(`"${upc}" Provided to YouTube by`);
    if (trackName && artistName) queries.push(`"${trackName}" "${artistName}" Provided to YouTube by`);

    for (const q of queries) {
        try {
            const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
            const res = await fetch(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            if (!res.ok) continue;
            const html = await res.text();
            const videoIds = [...new Set([...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map(m => m[1]))];

            for (const vid of videoIds.slice(0, 2)) {
                try {
                    const vres = await fetch(`https://www.youtube.com/watch?v=${vid}`, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                        }
                    });
                    if (!vres.ok) continue;
                    const vhtml = await vres.text();
                    
                    // Verify that the video actually pertains to this track/artist if query was by name
                    if (artistName && !vhtml.toLowerCase().includes(artistName.toLowerCase().slice(0, 5))) {
                        continue;
                    }

                    const match = vhtml.match(/Provided to YouTube by\s+([^\\<"\n\r]+)/i);
                    if (match && match[1]) {
                        let distro = match[1].split(/[\r\n\u00B7\u2022]/)[0].trim();
                        if (distro.length > 1 && !distro.toLowerCase().includes('youtube')) {
                            return distro;
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {}
    }
    return null;
}

/**
 * Resolves distributor from Apple Music / iTunes public catalog
 */
export async function resolveViaAppleMusic(trackName, artistName, upc) {
    try {
        let url = '';
        if (upc) {
            url = `https://itunes.apple.com/lookup?upc=${encodeURIComponent(upc)}`;
        }
        let res = url ? await fetch(url) : null;
        let data = res && res.ok ? await res.json() : null;

        if (!data || !data.results || data.results.length === 0) {
            if (trackName && artistName) {
                url = `https://itunes.apple.com/search?term=${encodeURIComponent(trackName + ' ' + artistName)}&entity=song&limit=3`;
                res = await fetch(url);
                data = res.ok ? await res.json() : null;
            }
        }

        if (data && data.results && data.results.length > 0) {
            for (const item of data.results) {
                if (item.collectionViewUrl) {
                    const pageRes = await fetch(item.collectionViewUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                    });
                    if (pageRes.ok) {
                        const html = await pageRes.text();
                        const distMatch = html.match(/\[(?:dist\.|distributed by)\s*([^\]]+)\]/i);
                        if (distMatch) return distMatch[1].trim();
                        const assocMatch = html.match(/Associated Label Of\s+([^\n\r<"]+)/i);
                        if (assocMatch) return assocMatch[1].trim();
                    }
                }
            }
        }
    } catch (e) {}
    return null;
}

/**
 * Resolves legal distributor / delivery entity via SoundExchange / IFPI Registry
 */
export async function resolveViaSoundExchange(isrc, upc) {
    try {
        const loginRes = await fetch('https://isrc-api.soundexchange.com/api/ext/login', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Origin': 'https://isrcsearch.ifpi.org',
                'Referer': 'https://isrcsearch.ifpi.org/'
            }
        });
        if (!loginRes.ok) return null;
        const rawCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')];
        const cookieStr = (rawCookies || []).map(c => (c || '').split(';')[0]).join('; ');
        const loginJson = await loginRes.json();
        const token = loginJson.token;
        if (!token) return null;

        const queries = [];
        if (upc) queries.push({ icpn: upc });
        if (isrc) queries.push({ isrc });

        for (const q of queries) {
            const res = await fetch('https://isrc-api.soundexchange.com/api/ext/recordings', {
                method: 'POST',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Origin': 'https://isrcsearch.ifpi.org',
                    'Referer': 'https://isrcsearch.ifpi.org/',
                    'Content-Type': 'application/json',
                    'Cookie': cookieStr,
                    'Authorization': `Token ${token}`
                },
                body: JSON.stringify({
                    searchFields: q,
                    start: 0,
                    number: 10,
                    showReleases: true
                })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.recordings && data.recordings.length > 0) {
                    for (const r of data.recordings) {
                        const label = r.releaseLabel || '';
                        if (label.includes('Records DK') || label.endsWith(' DK')) return 'DistroKid';
                        const catMatch = findCatalogMatch(label);
                        if (catMatch) return catMatch;
                    }
                }
            }
        }
    } catch (e) {}
    return null;
}

/**
 * Multi-tier automated live resolver
 */
export async function resolveLiveDistributor(trackName, artistName, isrc, upc) {
    // 1. YouTube DDEX feed
    try {
        const ddex = await resolveRealDistributorViaDDEX(trackName, artistName, isrc, upc);
        if (ddex) return ddex;
    } catch(e) {}

    // 2. Apple Music / iTunes
    try {
        const apple = await resolveViaAppleMusic(trackName, artistName, upc);
        if (apple) return apple;
    } catch(e) {}

    // 3. SoundExchange / IFPI
    try {
        const sx = await resolveViaSoundExchange(isrc, upc);
        if (sx) return sx;
    } catch(e) {}

    return null;
}

// Endpoint for track resolution (no daily limit)
const ENDPOINT_URL = "https://distrochecker.app/_serverFn/84bc24f28ea5b242aaf87900dacb7d51886fcb5dc3be93b433c2a6109e2a97be";

/**
 * Extracts track or album ID and kind from input query
 */
export function parseSpotifyInput(query) {
    const clean = (query || '').trim();
    
    // YouTube Video URL or ID
    const ytMatch = clean.match(/(?:youtube\.com\/(?:watch\?.*v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
    if (ytMatch) {
        return { kind: 'youtube', id: ytMatch[1] };
    }

    // Album URL or URI
    const albumMatch = clean.match(/(?:album\/|spotify:album:)([a-zA-Z0-9]{22})/);
    if (albumMatch) {
        return { kind: 'album', id: albumMatch[1] };
    }
    
    // Track URL or URI
    const trackMatch = clean.match(/(?:track\/|spotify:track:)([a-zA-Z0-9]{22})/);
    if (trackMatch) {
        return { kind: 'track', id: trackMatch[1] };
    }
    
    // Raw 22-character Spotify ID
    if (/^[a-zA-Z0-9]{22}$/.test(clean)) {
        return { kind: 'track', id: clean };
    }
    
    throw new Error('Geçerli bir Spotify veya YouTube şarkı linki giriniz.');
}

/**
 * Resolves YouTube Art Track metadata and distributor via direct DDEX
 */
export async function resolveYouTubeTrack(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await res.text();

    let trackName = 'Bilinmeyen Parça';
    let artists = [];
    let albumName = '';
    let label = '';
    let distributor = '';
    let releaseDate = '';

    const ddexIdx = html.indexOf('Provided to YouTube by');
    if (ddexIdx !== -1) {
        const block = html.slice(ddexIdx, ddexIdx + 800);
        const clean = block.replace(/\\\\n/g, '\n').replace(/\\n/g, '\n');
        const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
        
        const mDistro = lines[0]?.match(/Provided to YouTube by\s+(.+)/i);
        if (mDistro) distributor = mDistro[1].trim();

        if (lines[1]) {
            const parts = lines[1].split(/[\u00B7\u2022]/).map(p => p.trim());
            trackName = parts[0] || trackName;
            if (parts.length > 1) artists = parts.slice(1);
        }

        if (lines[2]) albumName = lines[2];

        for (const l of lines) {
            if (l.startsWith('℗')) label = l.replace('℗', '').trim();
            const mRel = l.match(/Released on:\s*(\d{4}-\d{2}-\d{2})/i);
            if (mRel) releaseDate = mRel[1];
        }
    } else {
        const titleM = html.match(/<title>([^<]+)<\/title>/);
        if (titleM) trackName = titleM[1].replace('- YouTube', '').trim();
    }

    const finalDistro = distributor || 'YouTube Content ID';
    const subLabel = label && label !== finalDistro ? label : null;

    return {
        trackId: videoId,
        trackName,
        albumName: albumName || trackName,
        artists: artists.length ? artists : ['Sanatçı'],
        label: label || finalDistro,
        distributorName: finalDistro,
        distributorDisplay: finalDistro,
        subLabel: subLabel,
        isWhiteLabel: !!subLabel,
        parentDistributor: finalDistro,
        isrc: 'YouTube DDEX Direct',
        upc: 'N/A',
        distributorHash: 'YouTube Content ID Art Track',
        coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        releaseDate: releaseDate || 'N/A',
        catalogDate: releaseDate || 'N/A',
        playcount: null,
        playcountDisplay: 'YouTube DDEX',
        isUnmapped: false,
        platform: 'youtube'
    };
}

/**
 * Resolves a single track ID into its distributor and full metadata
 */
export async function resolveTrack(trackId, customToken = null, retryOn401 = true) {
    if (trackCache.has(trackId)) {
        const cached = trackCache.get(trackId);
        const hash = (cached.distributorHash || '').toLowerCase();
        const currentMap = getHashMap();
        if (hash && currentMap[hash]) {
            cached.distributorName = currentMap[hash];
            cached.distributorDisplay = currentMap[hash];
            if (cached.subLabel && cached.subLabel.toLowerCase() !== currentMap[hash].toLowerCase()) {
                cached.parentDistributor = currentMap[hash];
                cached.isWhiteLabel = true;
            } else {
                cached.parentDistributor = null;
                cached.isWhiteLabel = false;
            }
            cached.isUnmapped = false;
        }
        return cached;
    }

    let result = null;

    // 1. Primary: Direct Spotify Internal Spclient (Protobuf) - Fast, 100% independent
    try {
        result = await resolveTrackDirect(trackId);
    } catch (spErr) {
        console.warn('⚠️ Spotify Direct resolver fallback:', spErr.message);
    }

    // 2. Fallback: Distrochecker if direct fails
    if (!result) {
        try {
            let token = customToken || await getValidAccessToken();
            const payload = { data: { trackId } };
            const serialized = toJSON(payload);
            let resp = await fetch(ENDPOINT_URL, {
                method: "POST",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "x-tsr-serverFn": "true",
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Origin": "https://distrochecker.app",
                    "Referer": "https://distrochecker.app/"
                },
                body: JSON.stringify(serialized)
            });

            if (resp.status === 401 && retryOn401) {
                console.warn('⚠️ 401 Unauthorized received. Auto-refreshing access token and retrying...');
                token = await refreshAccessToken();
                return await resolveTrack(trackId, token, false);
            }

            if (resp.ok) {
                const rawJson = await resp.json();
                result = parseSerovalResponse(rawJson);
            }
        } catch (dcErr) {
            console.warn('Distrochecker fallback error:', dcErr.message);
        }
    }

    if (!result || !result.trackId) {
        throw new Error('Parça bilgisi çözülemedi.');
    }

    // 1. Check local hash map
    const hash = (result.distributorHash || '').toLowerCase();
    const currentMap = getHashMap();
    let baseDistro = hash && currentMap[hash] ? currentMap[hash] : null;

    // If hash is unmapped, attempt automatic multi-tier resolution:
    // 1. Live MusicFetch automated engine (100% gold standard)
    // 2. Official DDEX YouTube, Apple Music, SoundExchange
    if (!baseDistro && hash) {
        try {
            const spotifyUrl = `https://open.spotify.com/track/${result.trackId}`;
            const mfDistro = await resolveViaMusicFetch(spotifyUrl);
            if (mfDistro) {
                baseDistro = mfDistro;
                saveHashMapping(hash, mfDistro);
                console.log(`[Auto-Discovered from MusicFetch] Hash: ${hash} -> ${mfDistro}`);
            }
        } catch(e) {
            console.warn('MusicFetch live auto-resolver notice:', e.message);
        }

        if (!baseDistro) {
            try {
                const liveDistro = await resolveLiveDistributor(result.trackName, result.artists?.[0], result.isrc, result.upc);
                if (liveDistro) {
                    baseDistro = liveDistro;
                    const catCheck = findCatalogMatch(liveDistro);
                    if (catCheck) {
                        saveHashMapping(hash, catCheck);
                    }
                }
            } catch(e) {}
        }
    }

    // 2. Check if label matches a recognized distributor/white-label
    const labelMatch = findCatalogMatch(result.label);
    const cleanLabel = (result.label || '').trim();

    if (baseDistro) {
        // If hash is mapped to a verified distributor (e.g. Broma 16, Distrus, AudioSalad, DistroKid, Eveara, Revelator)
        result.distributorName = baseDistro;
        result.distributorDisplay = baseDistro;

        // If label is distinct from base distributor
        if (cleanLabel && cleanLabel.toLowerCase() !== baseDistro.toLowerCase()) {
            result.subLabel = cleanLabel;
            result.parentDistributor = baseDistro;
            result.isWhiteLabel = true;
        } else {
            result.parentDistributor = null;
            result.isWhiteLabel = false;
        }
        result.isUnmapped = false;
    } else if (labelMatch) {
        result.distributorName = labelMatch;
        result.distributorDisplay = labelMatch;
        result.parentDistributor = null;
        result.isWhiteLabel = false;
        result.isUnmapped = false;
    } else {
        // Truly unmapped hash: Never treat a user-typed label or artist name as a verified distributor!
        result.distributorName = 'Tanımlanmamış Dağıtıcı (Özel Hash)';
        result.distributorDisplay = 'Tanımlanmamış Dağıtıcı (Özel Hash)';
        result.subLabel = cleanLabel;
        result.parentDistributor = null;
        result.isWhiteLabel = false;
        result.isUnmapped = true;
    }
    
    trackCache.set(trackId, result);
    return result;
}

/**
 * Fetches all track IDs from a Spotify album page
 */
export async function fetchAlbumTracks(albumId) {
    const url = `https://open.spotify.com/album/${albumId}`;
    const resp = await fetch(url, {
        headers: {
            "User-Agent": "Mozilla/5.0"
        }
    });
    
    if (!resp.ok) {
        throw new Error(`Albüm sayfası yüklenemedi: HTTP ${resp.status}`);
    }
    
    const html = await resp.text();
    const matches = [...html.matchAll(/(?:track\/|spotify:track:)([a-zA-Z0-9]{22})/g)];
    const trackIds = [...new Set(matches.map(m => m[1]))];
    
    if (trackIds.length === 0) {
        throw new Error('Albüme ait parça bulunamadı.');
    }
    
    return trackIds;
}

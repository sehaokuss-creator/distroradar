import { checkDistributionStores as checkMusicFetchStores, SUPPORTED_STORES } from './musicfetch_resolver.js';

// In-memory cache for definitive store results
const definitiveStoresCache = new Map();

/**
 * 1. Apple Music / iTunes Official API Lookup
 */
async function checkAppleMusic(trackName, artistName, isrc) {
    const queries = [];
    if (isrc) queries.push(`term=${encodeURIComponent(isrc)}`);
    if (trackName && artistName) {
        queries.push(`term=${encodeURIComponent(trackName + ' ' + artistName)}`);
    } else if (trackName) {
        queries.push(`term=${encodeURIComponent(trackName)}`);
    }

    const countries = ['TR', 'US', 'GB'];
    for (const q of queries) {
        for (const country of countries) {
            try {
                const url = `https://itunes.apple.com/search?${q}&country=${country}&entity=song&limit=3`;
                const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                if (!res.ok) continue;
                const data = await res.json();
                if (data.resultCount > 0) {
                    for (const item of data.results) {
                        // Title check if query wasn't ISRC
                        if (!q.includes(isrc || '____')) {
                            const cleanTrack = trackName.toLowerCase().replace(/[^a-z0-9]/g, '');
                            const itemTrack = (item.trackName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                            if (!itemTrack.includes(cleanTrack.slice(0, 6)) && !cleanTrack.includes(itemTrack.slice(0, 6))) {
                                continue;
                            }
                        }
                        return {
                            isLive: true,
                            url: item.trackViewUrl || item.collectionViewUrl,
                            previewUrl: item.previewUrl
                        };
                    }
                }
            } catch (e) {}
        }
    }
    return { isLive: false, url: null };
}

/**
 * 2. Deezer Official API Lookup
 */
async function checkDeezer(trackName, artistName, isrc) {
    if (isrc) {
        try {
            const res = await fetch(`https://api.deezer.com/search?q=isrc:${encodeURIComponent(isrc)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.total > 0 && data.data?.[0]?.link) {
                    return {
                        isLive: true,
                        url: data.data[0].link,
                        previewUrl: data.data[0].preview
                    };
                }
            }
        } catch (e) {}
    }

    if (trackName && artistName) {
        try {
            const query = `track:"${trackName}" artist:"${artistName}"`;
            const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.total > 0 && data.data?.[0]?.link) {
                    return {
                        isLive: true,
                        url: data.data[0].link,
                        previewUrl: data.data[0].preview
                    };
                }
            }
        } catch (e) {}
    }

    return { isLive: false, url: null };
}

/**
 * 3. YouTube & YouTube Music Direct DDEX Lookup
 */
async function checkYouTube(trackName, artistName, isrc) {
    const queries = [];
    if (isrc) queries.push(`"${isrc}" Provided to YouTube by`);
    if (trackName && artistName) queries.push(`"${trackName}" "${artistName}" Provided to YouTube by`);

    for (const q of queries) {
        try {
            const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
            const res = await fetch(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            if (!res.ok) continue;
            const html = await res.text();
            const videoIds = [...new Set([...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map(m => m[1]))];

            if (videoIds.length > 0) {
                const vid = videoIds[0];
                return {
                    isLive: true,
                    youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
                    youtubeMusicUrl: `https://music.youtube.com/watch?v=${vid}`,
                    youtubeShortsUrl: `https://www.youtube.com/shorts/${vid}`
                };
            }
        } catch (e) {}
    }

    return { isLive: false, youtubeUrl: null, youtubeMusicUrl: null, youtubeShortsUrl: null };
}

/**
 * Unified Definitive 40-Store Checker combining Official APIs + MusicFetch
 */
export async function getDefinitiveStores(spotifyTrackUrl, trackDetails = {}) {
    if (definitiveStoresCache.has(spotifyTrackUrl)) {
        return definitiveStoresCache.get(spotifyTrackUrl);
    }

    const { trackName, artistName, isrc, trackId } = trackDetails;

    // Run Official Direct APIs and MusicFetch in parallel
    const [appleRes, deezerRes, ytRes, mfRes] = await Promise.allSettled([
        checkAppleMusic(trackName, artistName, isrc),
        checkDeezer(trackName, artistName, isrc),
        checkYouTube(trackName, artistName, isrc),
        checkMusicFetchStores(spotifyTrackUrl)
    ]);

    const apple = appleRes.status === 'fulfilled' ? appleRes.value : { isLive: false };
    const deezer = deezerRes.status === 'fulfilled' ? deezerRes.value : { isLive: false };
    const yt = ytRes.status === 'fulfilled' ? ytRes.value : { isLive: false };
    const mf = mfRes.status === 'fulfilled' ? mfRes.value : null;

    const mfStoresMap = new Map();
    if (mf && mf.stores) {
        mf.stores.forEach(s => mfStoresMap.set(s.id, s.isLive));
    }

    // Build the definitive 40-store list with direct links and verified status
    const verifiedStores = SUPPORTED_STORES.map(store => {
        let isLive = false;
        let url = null;
        let source = 'MusicFetch Network';

        // 1. Spotify
        if (store.id === 'spotify') {
            isLive = true;
            url = spotifyTrackUrl;
            source = 'Spotify Resmi API';
        }
        // 2. Apple Music
        else if (store.id === 'apple-music') {
            if (apple.isLive) {
                isLive = true;
                url = apple.url;
                source = 'Apple iTunes Resmi API';
            } else if (mfStoresMap.get('apple-music') || mfStoresMap.get('apple')) {
                isLive = true;
                source = 'MusicFetch Doğrulaması';
            }
        }
        // 3. Deezer
        else if (store.id === 'deezer') {
            if (deezer.isLive) {
                isLive = true;
                url = deezer.url;
                source = 'Deezer Resmi API';
            } else if (mfStoresMap.get('deezer')) {
                isLive = true;
                source = 'MusicFetch Doğrulaması';
            }
        }
        // 4. YouTube
        else if (store.id === 'youtube') {
            if (yt.isLive) {
                isLive = true;
                url = yt.youtubeUrl;
                source = 'YouTube DDEX Lisansı';
            } else if (mfStoresMap.get('youtube')) {
                isLive = true;
                source = 'MusicFetch Doğrulaması';
            }
        }
        // 5. YouTube Music
        else if (store.id === 'youtube-music') {
            if (yt.isLive) {
                isLive = true;
                url = yt.youtubeMusicUrl;
                source = 'YouTube Music DDEX';
            } else if (mfStoresMap.get('youtube-music') || mfStoresMap.get('youtube')) {
                isLive = true;
                source = 'MusicFetch Doğrulaması';
            }
        }
        // 6. YouTube Shorts
        else if (store.id === 'youtube-shorts') {
            if (yt.isLive) {
                isLive = true;
                url = yt.youtubeShortsUrl;
                source = 'YouTube Shorts Audio';
            } else if (mfStoresMap.get('youtube-shorts') || mfStoresMap.get('youtube')) {
                isLive = true;
                source = 'MusicFetch Doğrulaması';
            }
        }
        // All remaining stores (Amazon, Tidal, Boomplay, Anghami, Audiomack, etc.)
        else {
            if (mfStoresMap.get(store.id)) {
                isLive = true;
                source = 'MusicFetch Doğrulaması';
            }
        }

        return {
            id: store.id,
            name: store.name,
            icon: store.icon,
            category: store.category,
            isLive,
            url,
            source: isLive ? source : 'Dağıtımda Tespit Edilmedi'
        };
    });

    const liveCount = verifiedStores.filter(s => s.isLive).length;
    const finalResult = {
        title: trackName || mf?.title || 'Şarkı',
        subtitle: artistName || mf?.subtitle || '',
        image: mf?.image || '',
        footerContent: mf?.footerContent || (isrc ? `ISRC: ${isrc}` : ''),
        liveCount,
        totalCount: SUPPORTED_STORES.length,
        percentage: Math.round((liveCount / SUPPORTED_STORES.length) * 100),
        stores: verifiedStores
    };

    definitiveStoresCache.set(spotifyTrackUrl, finalResult);
    return finalResult;
}

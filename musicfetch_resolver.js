import fs from 'fs';
import puppeteer from 'puppeteer-core';

const COMMON_BROWSER_PATHS = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

function getExecutablePath() {
    if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) {
        return process.env.BROWSER_PATH;
    }
    for (const p of COMMON_BROWSER_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

export const SUPPORTED_STORES = [
    { id: 'amazon', name: 'Amazon', icon: 'fa-brands fa-amazon', category: 'Global Store' },
    { id: 'amazon-music', name: 'Amazon Music', icon: 'fa-solid fa-music', category: 'Streaming' },
    { id: 'anghami', name: 'Anghami', icon: 'fa-solid fa-play', category: 'Regional (MENA)' },
    { id: 'apple-music', name: 'Apple Music', icon: 'fa-brands fa-apple', category: 'Streaming' },
    { id: 'audiomack', name: 'Audiomack', icon: 'fa-solid fa-headphones', category: 'Streaming' },
    { id: 'audius', name: 'Audius', icon: 'fa-solid fa-bolt', category: 'Web3 / Indie' },
    { id: 'awa', name: 'AWA', icon: 'fa-solid fa-wave-square', category: 'Regional (Japan)' },
    { id: 'bandcamp', name: 'Bandcamp', icon: 'fa-brands fa-bandcamp', category: 'Indie Store' },
    { id: 'beatport', name: 'Beatport', icon: 'fa-solid fa-sliders', category: 'Electronic / DJ' },
    { id: 'boomplay', name: 'Boomplay', icon: 'fa-solid fa-fire', category: 'Regional (Africa)' },
    { id: 'deezer', name: 'Deezer', icon: 'fa-brands fa-deezer', category: 'Streaming' },
    { id: 'discogs', name: 'Discogs', icon: 'fa-solid fa-record-vinyl', category: 'Database / Physical' },
    { id: 'flo', name: 'FLO', icon: 'fa-solid fa-water', category: 'Regional (Korea)' },
    { id: 'gaana', name: 'Gaana', icon: 'fa-solid fa-guitar', category: 'Regional (India)' },
    { id: 'genius', name: 'Genius', icon: 'fa-solid fa-font', category: 'Lyrics / Data' },
    { id: 'instagram', name: 'Instagram', icon: 'fa-brands fa-instagram', category: 'Social Audio' },
    { id: 'jiosaavn', name: 'JioSaavn', icon: 'fa-solid fa-radio', category: 'Regional (India)' },
    { id: 'joox', name: 'Joox', icon: 'fa-solid fa-compact-disc', category: 'Regional (Asia)' },
    { id: 'kkbox', name: 'KKBOX', icon: 'fa-solid fa-box', category: 'Regional (Asia)' },
    { id: 'line-music', name: 'Line Music', icon: 'fa-brands fa-line', category: 'Regional (Japan)' },
    { id: 'musicbrainz', name: 'MusicBrainz', icon: 'fa-solid fa-brain', category: 'Open Database' },
    { id: 'napster', name: 'Napster', icon: 'fa-brands fa-napster', category: 'Streaming' },
    { id: 'iheartradio', name: 'iHeartRadio', icon: 'fa-solid fa-heart', category: 'Radio / Streaming' },
    { id: 'netease', name: 'NetEase', icon: 'fa-solid fa-cloud', category: 'Regional (China)' },
    { id: 'pandora', name: 'Pandora', icon: 'fa-solid fa-p', category: 'Radio / USA' },
    { id: 'qobuz', name: 'Qobuz', icon: 'fa-solid fa-circle-nodes', category: 'Hi-Res Audio' },
    { id: 'qq-music', name: 'QQ Music', icon: 'fa-brands fa-qq', category: 'Regional (China)' },
    { id: '7digital', name: '7digital', icon: 'fa-solid fa-7', category: 'B2B Digital Store' },
    { id: 'shazam', name: 'Shazam', icon: 'fa-solid fa-bolt-lightning', category: 'Recognition' },
    { id: 'soundcloud', name: 'SoundCloud', icon: 'fa-brands fa-soundcloud', category: 'Streaming' },
    { id: 'spotify', name: 'Spotify', icon: 'fa-brands fa-spotify', category: 'Streaming' },
    { id: 'telmore-musik', name: 'Telmore Musik', icon: 'fa-solid fa-mobile-screen', category: 'Regional (Nordic)' },
    { id: 'tidal', name: 'Tidal', icon: 'fa-solid fa-water', category: 'Hi-Fi Streaming' },
    { id: 'tiktok', name: 'TikTok', icon: 'fa-brands fa-tiktok', category: 'Social Audio' },
    { id: 'trebel', name: 'Trebel', icon: 'fa-solid fa-triangle-exclamation', category: 'Free Music App' },
    { id: 'yandex', name: 'Yandex', icon: 'fa-brands fa-yandex', category: 'Regional (CIS)' },
    { id: 'yousee-musik', name: 'YouSee Musik', icon: 'fa-solid fa-tv', category: 'Regional (Nordic)' },
    { id: 'youtube', name: 'YouTube', icon: 'fa-brands fa-youtube', category: 'Video / Content ID' },
    { id: 'youtube-music', name: 'YouTube Music', icon: 'fa-brands fa-youtube', category: 'Streaming' },
    { id: 'youtube-shorts', name: 'YouTube Shorts', icon: 'fa-solid fa-clapperboard', category: 'Social Audio' }
];

// In-memory cache for store lookups
const storesCache = new Map();

class MusicFetchService {
    constructor() {
        this.browser = null;
        this.isInitializing = false;
    }

    async getBrowser() {
        if (this.browser && this.browser.connected) {
            return this.browser;
        }

        if (this.isInitializing) {
            while (this.isInitializing) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (this.browser && this.browser.connected) return this.browser;
        }

        this.isInitializing = true;
        const exePath = getExecutablePath();
        if (!exePath) {
            console.warn('⚠️ No Chrome or Edge executable found for MusicFetch resolver.');
            this.isInitializing = false;
            return null;
        }

        try {
            this.browser = await puppeteer.launch({
                executablePath: exePath,
                headless: false,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-blink-features=AutomationControlled',
                    '--window-position=-2000,-2000',
                    '--window-size=1200,800'
                ]
            });
            console.log('⚡ MusicFetch background resolver engine active.');
            return this.browser;
        } catch (err) {
            console.error('Failed to launch browser for MusicFetch:', err.message);
            return null;
        } finally {
            this.isInitializing = false;
        }
    }

    async resolveDistributor(spotifyTrackUrl) {
        const browser = await this.getBrowser();
        if (!browser) return null;

        let page = null;
        try {
            page = await browser.newPage();
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            return await new Promise(async (resolve) => {
                let resolved = false;

                const cleanup = (result) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timer);
                        resolve(result);
                    }
                };

                const timer = setTimeout(async () => {
                    try {
                        if (page) {
                            const bodyText = await page.evaluate(() => document.body.innerText);
                            const m = bodyText.match(/Distributor\s+([^·\n\r]+?)\s*·/i);
                            if (m && m[1]) {
                                let name = m[1].trim();
                                if (name.toLowerCase() === 'nudacy') name = 'Nucady';
                                if (!name.toLowerCase().includes('finder') && name.length >= 2) {
                                    return cleanup(name);
                                }
                            }
                        }
                    } catch(e) {}
                    cleanup(null);
                }, 8500);

                page.on('response', async (resp) => {
                    if (resp.url().includes('api/free-tools') && resp.status() === 200) {
                        try {
                            const data = await resp.json();
                            if (data?.result?.distributor) {
                                let name = data.result.distributor.trim();
                                if (name.toLowerCase() === 'nudacy') name = 'Nucady';
                                cleanup(name);
                            }
                        } catch(e) {}
                    }
                });

                try {
                    await page.goto('https://musicfetch.io/distributor-finder', {
                        waitUntil: 'networkidle2',
                        timeout: 18000
                    });

                    const input = await page.$('input');
                    if (input) {
                        await input.type(spotifyTrackUrl);
                        await page.keyboard.press('Enter');
                    } else {
                        cleanup(null);
                    }
                } catch(e) {
                    cleanup(null);
                }
            });
        } catch (e) {
            console.warn('MusicFetch resolution error:', e.message);
            return null;
        } finally {
            if (page) {
                await page.close().catch(() => {});
            }
        }
    }

    async checkStores(spotifyTrackUrl) {
        if (storesCache.has(spotifyTrackUrl)) {
            return storesCache.get(spotifyTrackUrl);
        }

        const browser = await this.getBrowser();
        if (!browser) return null;

        let page = null;
        try {
            page = await browser.newPage();
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            const resultData = await new Promise(async (resolve) => {
                let resolved = false;

                const cleanup = (result) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timer);
                        resolve(result);
                    }
                };

                const timer = setTimeout(() => {
                    cleanup(null);
                }, 10000);

                page.on('response', async (resp) => {
                    if (resp.url().includes('api/free-tools') && resp.status() === 200) {
                        try {
                            const data = await resp.json();
                            if (data?.result) {
                                cleanup(data.result);
                            }
                        } catch(e) {}
                    }
                });

                try {
                    await page.goto('https://musicfetch.io/music-distribution-checker', {
                        waitUntil: 'networkidle2',
                        timeout: 18000
                    });

                    const input = await page.$('input');
                    if (input) {
                        await input.type(spotifyTrackUrl);
                        await page.keyboard.press('Enter');
                    } else {
                        cleanup(null);
                    }
                } catch(e) {
                    cleanup(null);
                }
            });

            if (!resultData) return null;

            const liveServices = (resultData.services || []).map(s => s.toLowerCase().replace(/[^a-z0-9]/g, ''));
            
            // Map each of the 40 stores
            const mappedStores = SUPPORTED_STORES.map(store => {
                const storeNorm = store.id.toLowerCase().replace(/[^a-z0-9]/g, '');
                const nameNorm = store.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                
                // Check if this store is live
                const isLive = liveServices.some(s => s === storeNorm || s === nameNorm || (storeNorm.length > 4 && s.includes(storeNorm)));
                return {
                    id: store.id,
                    name: store.name,
                    icon: store.icon,
                    category: store.category,
                    isLive
                };
            });

            const liveCount = mappedStores.filter(s => s.isLive).length;
            const res = {
                title: resultData.title || '',
                subtitle: resultData.subtitle || '',
                image: resultData.image || '',
                footerContent: resultData.footerContent || '',
                liveCount,
                totalCount: SUPPORTED_STORES.length,
                percentage: Math.round((liveCount / SUPPORTED_STORES.length) * 100),
                stores: mappedStores
            };

            storesCache.set(spotifyTrackUrl, res);
            return res;
        } catch (e) {
            console.warn('MusicFetch checkStores error:', e.message);
            return null;
        } finally {
            if (page) {
                await page.close().catch(() => {});
            }
        }
    }
}

export const musicFetchService = new MusicFetchService();

export async function resolveViaMusicFetch(spotifyTrackUrl) {
    return await musicFetchService.resolveDistributor(spotifyTrackUrl);
}

export async function checkDistributionStores(spotifyTrackUrl) {
    return await musicFetchService.checkStores(spotifyTrackUrl);
}

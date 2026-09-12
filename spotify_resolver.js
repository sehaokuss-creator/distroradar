import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function spotifyIdToHex(id) {
  let big = 0n;
  for (const char of id) {
    big = big * 62n + BigInt(BASE62.indexOf(char));
  }
  return big.toString(16).padStart(32, '0');
}

export function hexToSpotifyId(hex) {
  let big = BigInt('0x' + hex);
  let res = '';
  while (big > 0n) {
    const mod = Number(big % 62n);
    res = BASE62[mod] + res;
    big = big / 62n;
  }
  return res.padStart(22, '0');
}

// Secret derivation for Spotify Web Player TOTP
const rawSecret = ',7/*F("rLJ2oxaKL^f+E1xvP@N';
const r = rawSecret.split('').map((e, t) => e.charCodeAt(0) ^ ((t % 33) + 9));
const secretBuf = Buffer.from(r.join(''), 'utf8');

function generateTOTP(secretBuffer, period = 30, digits = 6, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', secretBuffer);
  hmac.update(buf);
  const digest = hmac.digest();

  const offset = digest[digest.length - 1] & 0xf;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % Math.pow(10, digits);
  return code.toString().padStart(digits, '0');
}

let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Retrieves a valid official Spotify Web Player Bearer Access Token using sp_dc cookie
 */
export async function getSpotifyAccessToken(customSpDc = null) {
  const spDc = customSpDc || process.env.SP_DC;
  if (!spDc) {
    throw new Error('SP_DC çerezi tanımlı değil.');
  }

  const now = Date.now();
  if (cachedToken && tokenExpiresAt - now > 60000) {
    return cachedToken;
  }

  // Fetch serverTime from Spotify open page
  let serverTime = Math.floor(now / 1000);
  try {
    const page = await fetch('https://open.spotify.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Cookie': 'sp_dc=' + spDc
      }
    });
    const html = await page.text();
    const m = html.match(/<script id="appServerConfig"[^>]*>([^<]+)<\/script>/);
    if (m) {
      const cfg = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      if (cfg.serverTime) serverTime = cfg.serverTime;
    }
  } catch (e) {
    console.warn('Could not read Spotify serverTime, using local time:', e.message);
  }

  const totpClient = generateTOTP(secretBuf, 30, 6, now);
  const totpServer = generateTOTP(secretBuf, 30, 6, serverTime * 1000);

  const params = new URLSearchParams({
    reason: 'init',
    productType: 'web_player',
    totp: totpClient,
    totpServer: totpServer,
    totpVer: '61'
  });

  const res = await fetch(`https://open.spotify.com/api/token?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Cookie': 'sp_dc=' + spDc,
      'Accept': 'application/json',
      'Referer': 'https://open.spotify.com/'
    }
  });

  if (!res.ok) {
    throw new Error(`Spotify token hatası: HTTP ${res.status}`);
  }

  const data = await res.json();
  cachedToken = data.accessToken;
  tokenExpiresAt = data.accessTokenExpirationTimestampMs || (now + 3600000);
  console.log('⚡ Canlı Spotify Access Token yenilendi! Son geçerlilik:', new Date(tokenExpiresAt).toLocaleTimeString());
  return cachedToken;
}

/**
 * Parses raw protobuf response from spclient.wg.spotify.com/metadata/4/track/{hex_id}
 */
export function parseTrackProtobuf(buf) {
  let pos = 0;
  let trackName = '';
  let albumName = '';
  const artists = [];
  let label = '';
  let isrc = '';
  let distributorHash = '';
  let releaseDate = null;

  // Search ISRC in text
  const str = buf.toString('latin1');
  const isrcMatch = str.match(/[A-Z]{2}[A-Z0-9]{3}\d{7}/);
  if (isrcMatch) isrc = isrcMatch[0];

  function readVarint() {
    let res = 0;
    let shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      res |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return res;
  }

  while (pos < buf.length) {
    const tag = readVarint();
    const fieldNum = tag >> 3;
    const wireType = tag & 0x7;

    if (wireType === 0) {
      readVarint();
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const len = readVarint();
      const end = pos + len;
      const slice = buf.subarray(pos, end);

      if (fieldNum === 2 && !trackName) {
        trackName = slice.toString('utf8');
      } else if (fieldNum === 3) {
        parseAlbum(slice);
      } else if (fieldNum === 4) {
        parseArtist(slice);
      } else if (fieldNum === 25) {
        parseLicensor(slice);
      }
      pos = end;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }

  function parseDateProto(dbuf) {
    let p = 0;
    let y = null, m = null, d = null;
    while (p < dbuf.length) {
      const tag = dbuf[p++];
      const f = tag >> 3;
      let v = 0, s = 0;
      while (p < dbuf.length) {
        const b = dbuf[p++];
        v |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      const val = v >> 1;
      if (f === 1) y = val;
      if (f === 2) m = val;
      if (f === 3) d = val;
    }
    if (y) {
      if (m && d) return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      if (m) return y + '-' + String(m).padStart(2, '0');
      return String(y);
    }
    return null;
  }

  function parseAlbum(abuf) {
    let p = 0;
    while (p < abuf.length) {
      const tag = abuf[p++];
      const f = tag >> 3;
      const w = tag & 7;
      if (w === 2) {
        let l = abuf[p++];
        if (l & 0x80) l = (l & 0x7f) | (abuf[p++] << 7);
        const sub = abuf.subarray(p, p + l);
        if (f === 2 && !albumName) albumName = sub.toString('utf8');
        if (f === 3) parseArtist(sub);
        if (f === 5 && !label) label = sub.toString('utf8');
        if (f === 6 && !releaseDate) releaseDate = parseDateProto(sub);
        p += l;
      } else if (w === 0) {
        while (abuf[p++] & 0x80);
      } else if (w === 1) p += 8;
      else if (w === 5) p += 4;
      else break;
    }
  }

  function parseArtist(arbuf) {
    let p = 0;
    while (p < arbuf.length) {
      const tag = arbuf[p++];
      const f = tag >> 3;
      const w = tag & 7;
      if (w === 2) {
        let l = arbuf[p++];
        if (l & 0x80) l = (l & 0x7f) | (arbuf[p++] << 7);
        const sub = arbuf.subarray(p, p + l);
        if (f === 2) {
          const name = sub.toString('utf8');
          if (name && !artists.includes(name)) artists.push(name);
        }
        p += l;
      } else if (w === 0) {
        while (arbuf[p++] & 0x80);
      } else if (w === 1) p += 8;
      else if (w === 5) p += 4;
      else break;
    }
  }

  function parseLicensor(lbuf) {
    let p = 0;
    while (p < lbuf.length) {
      const tag = lbuf[p++];
      const f = tag >> 3;
      const w = tag & 7;
      if (w === 2) {
        let l = lbuf[p++];
        if (l & 0x80) l = (l & 0x7f) | (lbuf[p++] << 7);
        if (f === 1 && l === 16) {
          distributorHash = lbuf.subarray(p, p + 16).toString('hex');
        } else if (f === 2) {
          const sub = lbuf.subarray(p, p + l);
          parseLicensor(sub);
        }
        p += l;
      } else if (w === 0) {
        while (lbuf[p++] & 0x80);
      } else break;
    }
  }

  // Fallback scan for distributor hash if field 25 parsing missed submessage
  if (!distributorHash) {
    const hex = buf.toString('hex');
    const m = hex.match(/ca01[0-9a-f]{2,4}0a10([a-f0-9]{32})/);
    if (m) distributorHash = m[1];
  }

  return {
    trackName,
    albumName,
    artists,
    label,
    isrc,
    distributorHash,
    releaseDate
  };
}

/**
 * Fetches high-res track thumbnail via Spotify oEmbed
 */
export async function getTrackCoverUrl(trackId) {
  try {
    const res = await fetch(`https://open.spotify.com/oembed?url=spotify:track:${trackId}`);
    if (res.ok) {
      const data = await res.json();
      return data.thumbnail_url || null;
    }
  } catch (e) {}
  return null;
}

/**
 * Fetches rich details (playcount, catalog/release date, duration, high-res cover) from Spotify Partner API
 */
export async function fetchTrackDetails(trackId, token) {
  try {
    const url = 'https://api-partner.spotify.com/pathfinder/v1/query?operationName=getTrack&variables=' + 
      encodeURIComponent(JSON.stringify({ uri: `spotify:track:${trackId}` })) +
      '&extensions=' + encodeURIComponent(JSON.stringify({
        persistedQuery: {
          version: 1,
          sha256Hash: 'a8ef9e9f02b836feb0da3003c31dbb30decc6f4b473ef89ca88c882386d668de'
        }
      }));
    
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    if (r.ok) {
      const data = await r.json();
      const t = data.data?.trackUnion;
      if (t) {
        const pc = t.playcount != null ? Number(t.playcount) : 0;
        const relDate = t.albumOfTrack?.date?.isoString ? t.albumOfTrack.date.isoString.slice(0, 10) : (t.albumOfTrack?.date?.year ? String(t.albumOfTrack.date.year) : null);
        return {
          playcount: pc,
          playcountDisplay: pc.toLocaleString('tr-TR'),
          durationMs: t.duration?.totalMilliseconds || null,
          releaseDate: relDate,
          catalogDate: relDate,
          coverUrl: t.albumOfTrack?.coverArt?.sources?.[0]?.url || null,
          albumId: t.albumOfTrack?.id || null,
          albumName: t.albumOfTrack?.name || null
        };
      }
    }
  } catch (e) {
    console.warn('Pathfinder getTrack failed:', e.message);
  }
  return null;
}

export async function getAlbumUpc(albumId, token) {
  if (!albumId) return null;
  try {
    const hex = spotifyIdToHex(albumId);
    const res = await fetch(`https://spclient.wg.spotify.com/metadata/4/album/${hex}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const str = buf.toString('latin1');
      const m = str.match(/(?:upc|ean)?[^\d]?(\d{12,14})/i) || str.match(/\b\d{12,14}\b/);
      if (m) return m[1] || m[0];
    }
  } catch(e) {}
  return null;
}

/**
 * Resolves a track ID directly from Spotify internal spclient + Partner API
 */
export async function resolveTrackDirect(trackId) {
  const hexId = spotifyIdToHex(trackId);
  const token = await getSpotifyAccessToken();

  const url = `https://spclient.wg.spotify.com/metadata/4/track/${hexId}`;

  // Query spclient protobuf and partner GraphQL in parallel
  const [resSpclient, partnerDetails, oembedCover] = await Promise.all([
    fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }),
    fetchTrackDetails(trackId, token),
    getTrackCoverUrl(trackId)
  ]);

  if (!resSpclient.ok) {
    throw new Error(`Spotify Spclient Hatası: HTTP ${resSpclient.status}`);
  }

  const buf = Buffer.from(await resSpclient.arrayBuffer());
  const parsed = parseTrackProtobuf(buf);

  const finalCover = partnerDetails?.coverUrl || oembedCover || 'https://open.spotify.com/favicon.ico';
  const finalAlbumId = partnerDetails?.albumId || null;

  // Extract UPC if album ID is known
  let upc = null;
  if (finalAlbumId) {
    upc = await getAlbumUpc(finalAlbumId, token);
  }

  return {
    trackId,
    trackName: parsed.trackName,
    albumName: partnerDetails?.albumName || parsed.albumName,
    albumId: finalAlbumId,
    artists: parsed.artists,
    label: parsed.label,
    isrc: parsed.isrc,
    upc: upc || null,
    distributorHash: parsed.distributorHash,
    coverUrl: finalCover,
    playcount: partnerDetails?.playcount != null ? partnerDetails.playcount : null,
    playcountDisplay: partnerDetails?.playcountDisplay || (partnerDetails?.playcount != null ? Number(partnerDetails.playcount).toLocaleString('tr-TR') : '0'),
    releaseDate: partnerDetails?.releaseDate || parsed.releaseDate || null,
    catalogDate: partnerDetails?.catalogDate || parsed.releaseDate || null,
    durationMs: partnerDetails?.durationMs || null
  };
}

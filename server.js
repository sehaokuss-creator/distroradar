import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { parseSpotifyInput, resolveTrack, resolveYouTubeTrack, fetchAlbumTracks, saveHashMapping } from './distro_service.js';
import { updateSession } from './token_manager.js';
import { getDefinitiveStores } from './direct_stores_resolver.js';
import { keyManager } from './key_manager.js';
import { activityLogger } from './activity_logger.js';
import { securityGuard } from './security_guard.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_CONFIG_FILE = path.join(__dirname, 'admin_config.json');

function getAdminPassword() {
    try {
        if (fs.existsSync(ADMIN_CONFIG_FILE)) {
            const cfg = JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8'));
            if (cfg.adminPassword) return cfg.adminPassword;
        }
    } catch (e) {}
    return process.env.ADMIN_PASSWORD || 'eneswitzannesi';
}

function setAdminPassword(newPassword) {
    try {
        const cfg = {
            adminPassword: newPassword,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to write admin config:', e.message);
    }
}

// Admin Session Token Store (in-memory)
const adminTokens = new Set();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Dedicated Admin Panel Route
app.get('/admin-panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Health check endpoints for Cloud hosting & 24/7 Uptime Keep-Alive pings
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/ping', (req, res) => res.status(200).send('pong'));

// Authentication Helper & Middleware for Standard Keys
function extractKey(req) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7).trim();
    }
    return req.headers['x-access-key'] || req.query.key || req.body?.accessKey || req.body?.key;
}

function requireAccessKey(req, res, next) {
    const key = extractKey(req);
    if (!key) {
        return res.status(401).json({
            success: false,
            error: 'Erişim anahtarı gereklidir (Access key required). Lütfen geçerli bir key giriniz.',
            code: 'AUTH_REQUIRED'
        });
    }

    const verification = keyManager.verifyKey(key);
    if (!verification.valid) {
        return res.status(403).json({
            success: false,
            error: verification.reason || 'Geçersiz veya süresi dolmuş anahtar.',
            code: 'INVALID_KEY'
        });
    }

    req.accessKey = verification;
    next();
}

// Middleware for Admin Session Authentication
function requireAdminAuth(req, res, next) {
    const auth = req.headers['authorization'];
    let token = null;
    if (auth && auth.startsWith('Bearer ')) {
        token = auth.slice(7).trim();
    }
    if (!token || !adminTokens.has(token)) {
        return res.status(401).json({
            success: false,
            error: 'Yetkisiz erişim. Lütfen admin şifresiyle giriş yapınız.'
        });
    }
    next();
}

// Public Key Verification Endpoint
app.post('/api/auth/verify', (req, res) => {
    const key = req.body?.key || extractKey(req);
    if (!key) {
        return res.status(400).json({ valid: false, reason: 'Key sağlanmadı.' });
    }
    const result = keyManager.verifyKey(key);
    return res.json(result);
});

// Admin Password Login Endpoint
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body || {};
    if (password && password === getAdminPassword()) {
        const token = 'adm_' + crypto.randomBytes(24).toString('hex');
        adminTokens.add(token);
        console.log(`🛡️ [ADMIN LOGIN] Admin logged in successfully from IP: ${securityGuard.getClientIp(req)}`);
        return res.json({ success: true, token });
    }
    return res.status(401).json({ success: false, error: 'Hatalı yönetici şifresi.' });
});

// Admin Password Change Endpoint
app.post('/api/admin/change-password', requireAdminAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, error: 'Yeni şifre en az 4 karakter olmalıdır.' });
    }
    if (currentPassword !== getAdminPassword()) {
        return res.status(400).json({ success: false, error: 'Mevcut şifre hatalı.' });
    }
    setAdminPassword(newPassword);
    console.log(`🔐 [ADMIN] Admin password successfully changed!`);
    return res.json({ success: true, message: 'Yönetici şifresi başarıyla güncellendi!' });
});

function getKeyStatusInfo(keyString) {
    if (!keyString) return { status: 'unknown', active: false, label: '', role: 'user' };
    const entry = keyManager.keys.get(keyString.trim());
    if (!entry) return { status: 'revoked', active: false, label: 'Bilinmeyen Key', role: 'user' };
    const isExpired = entry.expiresAt ? new Date() > new Date(entry.expiresAt) : false;
    const role = entry.role || 'user';
    if (!entry.active) return { status: 'revoked', active: false, label: entry.label || '', role };
    if (isExpired) return { status: 'expired', active: false, label: entry.label || '', role };
    return { status: 'active', active: true, label: entry.label || '', role };
}

// Admin Data Endpoints
app.get('/api/admin/stats', requireAdminAuth, (req, res) => {
    return res.json({ success: true, data: activityLogger.getStats() });
});

app.get('/api/admin/users', requireAdminAuth, (req, res) => {
    const users = activityLogger.getUsersSummary();
    const enriched = users.map(u => {
        const info = getKeyStatusInfo(u.fullKey);
        return {
            ...u,
            keyStatus: info.status,
            isKeyActive: info.active,
            keyRole: info.role,
            keyLabel: info.label || u.keyLabel
        };
    });
    return res.json({ success: true, users: enriched });
});

app.get('/api/admin/all-queries', requireAdminAuth, (req, res) => {
    const enriched = activityLogger.logs.slice(0, 300).map(q => {
        const info = getKeyStatusInfo(q.fullKey);
        return {
            ...q,
            keyStatus: info.status,
            isKeyActive: info.active,
            keyRole: info.role,
            keyLabel: info.label || q.keyLabel
        };
    });
    return res.json({ success: true, queries: enriched });
});

app.get('/api/admin/user-queries', requireAdminAuth, (req, res) => {
    const { ip, key } = req.query;
    const queries = activityLogger.getUserQueries(ip, key).map(q => {
        const info = getKeyStatusInfo(q.fullKey);
        return {
            ...q,
            keyStatus: info.status,
            isKeyActive: info.active,
            keyRole: info.role,
            keyLabel: info.label || q.keyLabel
        };
    });
    return res.json({ success: true, queries });
});

app.get('/api/admin/keys', requireAdminAuth, (req, res) => {
    return res.json({ success: true, keys: keyManager.listKeys() });
});

app.post('/api/admin/generate-key', requireAdminAuth, (req, res) => {
    const { role, label, expiresDays, maxUses, features, rateLimit } = req.body || {};
    const newKey = keyManager.generateKey({ role, label, expiresDays, maxUses, features, rateLimit });
    return res.json({ success: true, key: newKey });
});

app.post('/api/admin/update-key', requireAdminAuth, (req, res) => {
    const { key, role, label, active, maxUses, expiresAt, features, rateLimit } = req.body || {};
    const updated = keyManager.updateKey(key, { role, label, active, maxUses, expiresAt, features, rateLimit });
    if (!updated) {
        return res.status(404).json({ success: false, error: 'Key bulunamadı.' });
    }
    return res.json({ success: true, key: updated });
});

app.post('/api/admin/reactivate-key', requireAdminAuth, (req, res) => {
    const { key } = req.body || {};
    const updated = keyManager.updateKey(key, { active: true });
    if (!updated) {
        return res.status(404).json({ success: false, error: 'Key bulunamadı.' });
    }
    return res.json({ success: true, key: updated, message: 'Key tekrar aktif edildi.' });
});

app.post('/api/admin/revoke-key', requireAdminAuth, (req, res) => {
    const { key } = req.body || {};
    const success = keyManager.revokeKey(key);
    return res.json({ success, message: success ? 'Key iptal edildi.' : 'Key bulunamadı.' });
});

app.post('/api/admin/delete-key', requireAdminAuth, (req, res) => {
    const { key } = req.body || {};
    const success = keyManager.deleteKey(key);
    return res.json({ success, message: success ? 'Key kalıcı olarak silindi.' : 'Key bulunamadı.' });
});

// API endpoint for song or album distributor lookup (Protected + Rate Limited + Logged)
app.get('/api/lookup', requireAccessKey, securityGuard.rateLimiter.bind(securityGuard), async (req, res) => {
    try {
        if (req.accessKey?.features && req.accessKey.features.canLookup === false) {
            return res.status(403).json({ error: 'Bu anahtarın şarkı sorgulama yetkisi kapalıdır.' });
        }
        const query = req.query.query;
        const clientIp = securityGuard.getClientIp(req);
        console.log(`\n🔍 [LOOKUP] [${clientIp}] Query: ${query}`);
        if (!query) {
            return res.status(400).json({ error: 'Lütfen bir Spotify veya YouTube şarkı linki giriniz.' });
        }

        const parsed = parseSpotifyInput(query);

        if (parsed.kind === 'youtube') {
            const ytData = await resolveYouTubeTrack(parsed.id);
            console.log(`✅ [YOUTUBE RESOLVED] ${ytData.trackName} (${ytData.trackId}) -> ${ytData.distributorDisplay}`);
            
            activityLogger.logQuery({
                ip: clientIp,
                key: req.accessKey?.key,
                keyLabel: req.accessKey?.label,
                type: 'lookup',
                trackId: ytData.trackId,
                trackName: ytData.trackName,
                artistName: ytData.artists?.[0],
                coverUrl: ytData.coverUrl,
                distributor: ytData.distributorDisplay
            });

            return res.json({
                success: true,
                type: 'track',
                data: ytData
            });
        }

        if (parsed.kind === 'track') {
            const trackData = await resolveTrack(parsed.id);
            console.log(`✅ [RESOLVED] ${trackData.trackName} (${trackData.trackId}) -> ${trackData.distributorDisplay}`);

            activityLogger.logQuery({
                ip: clientIp,
                key: req.accessKey?.key,
                keyLabel: req.accessKey?.label,
                type: 'lookup',
                trackId: trackData.trackId,
                trackName: trackData.trackName,
                artistName: trackData.artists?.[0],
                coverUrl: trackData.coverUrl,
                distributor: trackData.distributorDisplay
            });

            return res.json({
                success: true,
                type: 'track',
                data: trackData
            });
        }

        if (parsed.kind === 'album') {
            const trackIds = await fetchAlbumTracks(parsed.id);
            const results = [];
            for (const tId of trackIds) {
                try {
                    const tData = await resolveTrack(tId);
                    results.push({ status: 'fulfilled', data: tData });
                } catch (err) {
                    results.push({ status: 'rejected', trackId: tId, error: err.message });
                }
            }

            if (results[0]?.data) {
                activityLogger.logQuery({
                    ip: clientIp,
                    key: req.accessKey?.key,
                    keyLabel: req.accessKey?.label,
                    type: 'lookup',
                    trackId: parsed.id,
                    trackName: results[0].data.albumName || 'Albüm',
                    artistName: results[0].data.artists?.[0],
                    coverUrl: results[0].data.coverUrl,
                    distributor: results[0].data.distributorDisplay
                });
            }

            return res.json({
                success: true,
                type: 'album',
                albumId: parsed.id,
                totalTracks: trackIds.length,
                tracks: results
            });
        }

        return res.status(400).json({ error: 'Desteklenmeyen istek tipi.' });
    } catch (err) {
        console.error('Lookup error:', err.message);
        return res.status(500).json({ error: err.message || 'İstek işlenirken bir hata oluştu.' });
    }
});

// API endpoint to check 40-platform store distribution status (Protected + Rate Limited + Logged)
app.get('/api/stores', requireAccessKey, securityGuard.rateLimiter.bind(securityGuard), async (req, res) => {
    try {
        if (req.accessKey?.features && req.accessKey.features.canCheckStores === false) {
            return res.status(403).json({ error: 'Bu anahtarın mağaza dağıtım denetimi yetkisi bulunmuyor. Bu özellik Premium veya Admin lisansı gerektirir.' });
        }
        const query = req.query.query;
        const clientIp = securityGuard.getClientIp(req);
        if (!query) {
            return res.status(400).json({ error: 'Lütfen bir Spotify şarkı linki giriniz.' });
        }

        const parsed = parseSpotifyInput(query);
        if (parsed.kind !== 'track') {
            return res.status(400).json({ error: 'Mağaza dağıtım kontrolü şu an yalnızca tekil şarkı linkleri için geçerlidir.' });
        }

        const trackUrl = `https://open.spotify.com/track/${parsed.id}`;
        console.log(`\n🏪 [STORE CHECK] [${clientIp}] Query: ${trackUrl}`);

        let trackDetails = { trackId: parsed.id };
        try {
            const tData = await resolveTrack(parsed.id);
            if (tData) {
                trackDetails.trackName = tData.trackName;
                trackDetails.artistName = tData.artists?.[0];
                trackDetails.isrc = tData.isrc;
                trackDetails.coverUrl = tData.coverUrl;
            }
        } catch (e) {}

        const storeData = await getDefinitiveStores(trackUrl, trackDetails);
        if (!storeData) {
            return res.status(502).json({ error: 'Mağaza dağıtım bilgisi sorgulanamadı. Lütfen tekrar deneyiniz.' });
        }

        activityLogger.logQuery({
            ip: clientIp,
            key: req.accessKey?.key,
            keyLabel: req.accessKey?.label,
            type: 'stores',
            trackId: parsed.id,
            trackName: storeData.title,
            artistName: storeData.subtitle,
            coverUrl: storeData.image || trackDetails.coverUrl,
            distributor: `${storeData.liveCount}/${storeData.totalCount} Mağaza Yayında`,
            storesCount: storeData.liveCount
        });

        console.log(`✅ [STORE CHECK RESOLVED] ${storeData.title} -> ${storeData.liveCount}/${storeData.totalCount} stores live`);
        return res.json({
            success: true,
            data: storeData
        });
    } catch (err) {
        console.error('Stores check error:', err.message);
        return res.status(500).json({ error: err.message || 'Mağaza dağıtım kontrolünde bir hata oluştu.' });
    }
});

// Endpoint to map a new hash to a distributor name (Protected)
app.post('/api/map-hash', requireAccessKey, (req, res) => {
    const { hash, name } = req.body || {};
    if (!hash || !name) {
        return res.status(400).json({ error: 'Hash ve Distribütör Adı zorunludur.' });
    }
    saveHashMapping(hash, name);
    return res.json({ success: true, message: `Hash (${hash}) başarıyla '${name}' olarak kaydedildi.` });
});

// Endpoint to update access token
app.post('/api/update-token', (req, res) => {
    const { accessToken, refreshToken } = req.body || {};
    if (!accessToken) {
        return res.status(400).json({ error: 'Access token zorunludur.' });
    }
    updateSession(accessToken, refreshToken);
    return res.json({ success: true, message: 'Access token başarıyla güncellendi!' });
});

// Endpoint to list all 300+ known distributors
app.get('/api/distributors', (req, res) => {
    try {
        const catalogPath = path.join(__dirname, 'distributors_catalog.json');
        if (fs.existsSync(catalogPath)) {
            const list = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
            return res.json(list);
        }
    } catch(e) {}
    return res.json([]);
});

let server;
if (!process.env.VERCEL) {
    server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`=======================================================`);
        console.log(`🎵 DistroRadar Pro Sunucusu Başlatıldı!`);
        console.log(`🚀 Kullanıcı Arayüzü: http://localhost:${PORT}`);
        console.log(`🛡️ Yönetici Paneli:   http://localhost:${PORT}/admin-panel`);
        console.log(`=======================================================`);
    });
}

export default app;

if (server) {
    server.on('error', (e) => {
        console.error('Server error:', e);
    });
}

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

process.on('exit', (code) => {
    console.log(`[PROCESS EXIT] Node process exiting with code: ${code}`);
});

// Heartbeat
if (!process.env.VERCEL) {
    setInterval(() => {}, 30000);
}

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOGS_FILE = path.join(__dirname, 'query_logs.json');
const MAX_LOG_ENTRIES = 2000;

class ActivityLogger {
    constructor() {
        this.logs = [];
        this.loadLogs();
    }

    loadLogs() {
        try {
            if (fs.existsSync(LOGS_FILE)) {
                const data = fs.readFileSync(LOGS_FILE, 'utf8');
                this.logs = JSON.parse(data);
                if (!Array.isArray(this.logs)) this.logs = [];
            }
        } catch (e) {
            console.error('Error loading query_logs.json:', e.message);
            this.logs = [];
        }
    }

    saveLogs() {
        try {
            // Trim logs to MAX_LOG_ENTRIES to avoid unbounded file growth
            if (this.logs.length > MAX_LOG_ENTRIES) {
                this.logs = this.logs.slice(-MAX_LOG_ENTRIES);
            }
            fs.writeFileSync(LOGS_FILE, JSON.stringify(this.logs, null, 2), 'utf8');
        } catch (e) {
            console.error('Error saving query_logs.json:', e.message);
        }
    }

    /**
     * Records a new query
     */
    logQuery({
        ip,
        key,
        keyLabel = '',
        type = 'lookup',
        trackId = '',
        trackName = '',
        artistName = '',
        coverUrl = '',
        distributor = '',
        storesCount = 0
    }) {
        const cleanIp = (ip || '127.0.0.1').replace('::ffff:', '');
        const entry = {
            id: 'log_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
            timestamp: new Date().toISOString(),
            ip: cleanIp,
            key: key ? (key.length > 24 ? key.slice(0, 10) + '...' + key.slice(-4) : key) : 'ANONYMOUS',
            fullKey: key || '',
            keyLabel: keyLabel || 'Bilinmeyen Kullanıcı',
            type, // 'lookup' or 'stores'
            trackId,
            trackName: trackName || 'Bilinmeyen Şarkı',
            artistName: artistName || 'Bilinmeyen Sanatçı',
            coverUrl: coverUrl || '',
            distributor: distributor || 'Tespit Edilemedi',
            storesCount: Number(storesCount) || 0
        };

        this.logs.unshift(entry); // Prepend to keep newest first
        this.saveLogs();
        return entry;
    }

    /**
     * Returns grouped summary of all unique users/IPs
     */
    getUsersSummary() {
        const userMap = new Map();

        for (const log of this.logs) {
            const identifier = `${log.ip}_${log.fullKey}`;
            if (!userMap.has(identifier)) {
                userMap.set(identifier, {
                    ip: log.ip,
                    key: log.key,
                    fullKey: log.fullKey,
                    keyLabel: log.keyLabel,
                    totalQueries: 0,
                    firstSeen: log.timestamp,
                    lastActive: log.timestamp,
                    lastTrack: {
                        name: log.trackName,
                        artist: log.artistName,
                        coverUrl: log.coverUrl
                    }
                });
            }

            const record = userMap.get(identifier);
            record.totalQueries++;
            if (new Date(log.timestamp) > new Date(record.lastActive)) {
                record.lastActive = log.timestamp;
                record.lastTrack = {
                    name: log.trackName,
                    artist: log.artistName,
                    coverUrl: log.coverUrl
                };
            }
        }

        return Array.from(userMap.values()).sort(
            (a, b) => new Date(b.lastActive) - new Date(a.lastActive)
        );
    }

    /**
     * Returns queries filtered by specific IP or Key
     */
    getUserQueries(ip, key = null) {
        return this.logs.filter(log => {
            if (ip && log.ip === ip) {
                if (key && log.fullKey && log.fullKey !== key) return false;
                return true;
            }
            if (key && log.fullKey === key) return true;
            return false;
        }).slice(0, 100);
    }

    /**
     * Returns overall statistics
     */
    getStats() {
        const uniqueIps = new Set(this.logs.map(l => l.ip)).size;
        const uniqueKeys = new Set(this.logs.filter(l => l.fullKey).map(l => l.fullKey)).size;
        const today = new Date().toISOString().slice(0, 10);
        const queriesToday = this.logs.filter(l => l.timestamp.startsWith(today)).length;

        return {
            totalQueries: this.logs.length,
            queriesToday,
            uniqueIps,
            uniqueKeys
        };
    }
}

export const activityLogger = new ActivityLogger();

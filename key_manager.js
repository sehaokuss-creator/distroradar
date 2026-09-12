import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEYS_FILE = path.join(__dirname, 'access_keys.json');
const TMP_KEYS_FILE = path.join('/tmp', 'access_keys.json');
const GIST_ID = process.env.STORAGE_GIST_ID || '87d0c6953bb189d4df145a11004dab7e';
const GITHUB_TOKEN = process.env.STORAGE_GH_TOKEN;

// Default initial keys if file doesn't exist
const DEFAULT_KEYS = {
    "dfinder_master_2026": {
        "id": "master_01",
        "key": "dfinder_master_2026",
        "role": "admin",
        "label": "Master Administrator Key",
        "createdAt": new Date().toISOString(),
        "expiresAt": null,
        "maxUses": null,
        "useCount": 0,
        "active": true
    },
    "dfinder_demo_pass_xyz": {
        "id": "demo_01",
        "key": "dfinder_demo_pass_xyz",
        "role": "user",
        "label": "Global Demo Key",
        "createdAt": new Date().toISOString(),
        "expiresAt": null,
        "maxUses": null,
        "useCount": 0,
        "active": true
    }
};

class KeyManager {
    constructor() {
        this.keys = new Map();
        this.loadKeys();
    }

    async syncFromGist() {
        if (!GITHUB_TOKEN || !GIST_ID) return;
        try {
            const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                headers: {
                    'Authorization': `Bearer ${GITHUB_TOKEN}`,
                    'User-Agent': 'DistroRadar-App'
                }
            });
            if (res.ok) {
                const data = await res.json();
                const content = data.files?.['access_keys.json']?.content;
                if (content) {
                    const parsed = JSON.parse(content);
                    for (const [k, v] of Object.entries(parsed)) {
                        this.keys.set(k, v);
                    }
                    console.log(`🔑 [KEY MANAGER] Synced ${this.keys.size} keys from cloud storage.`);
                }
            }
        } catch (e) {
            console.error('[KEY MANAGER] Cloud sync error:', e.message);
        }
    }

    async syncToGist() {
        if (!GITHUB_TOKEN || !GIST_ID) return;
        try {
            const obj = Object.fromEntries(this.keys);
            await fetch(`https://api.github.com/gists/${GIST_ID}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${GITHUB_TOKEN}`,
                    'User-Agent': 'DistroRadar-App',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    files: {
                        'access_keys.json': { content: JSON.stringify(obj, null, 2) }
                    }
                })
            });
        } catch (e) {
            console.error('[KEY MANAGER] Cloud save error:', e.message);
        }
    }

    loadKeys() {
        // 1. Primary load from build-time file
        try {
            if (fs.existsSync(KEYS_FILE)) {
                const raw = fs.readFileSync(KEYS_FILE, 'utf8');
                const parsed = JSON.parse(raw);
                this.keys = new Map(Object.entries(parsed));
                console.log(`🔑 [KEY MANAGER] Loaded ${this.keys.size} access keys.`);
            } else {
                this.keys = new Map(Object.entries(DEFAULT_KEYS));
                this.saveKeys();
            }
        } catch (err) {
            this.keys = new Map(Object.entries(DEFAULT_KEYS));
        }

        // 2. Load from ephemeral /tmp if exists
        try {
            if (fs.existsSync(TMP_KEYS_FILE)) {
                const raw = fs.readFileSync(TMP_KEYS_FILE, 'utf8');
                const parsed = JSON.parse(raw);
                for (const [k, v] of Object.entries(parsed)) {
                    this.keys.set(k, v);
                }
            }
        } catch (e) {}

        // 3. Background cloud sync
        this.syncFromGist().catch(() => {});

        // Allow environment variable to inject or enforce master key
        if (process.env.MASTER_ADMIN_KEY && !this.keys.has(process.env.MASTER_ADMIN_KEY)) {
            this.keys.set(process.env.MASTER_ADMIN_KEY, {
                id: 'env_master',
                key: process.env.MASTER_ADMIN_KEY,
                role: 'admin',
                label: 'Env Master Key',
                createdAt: new Date().toISOString(),
                expiresAt: null,
                maxUses: null,
                useCount: 0,
                active: true
            });
            this.saveKeys();
        }
    }

    async saveKeys() {
        const obj = Object.fromEntries(this.keys);
        try {
            fs.writeFileSync(KEYS_FILE, JSON.stringify(obj, null, 2), 'utf8');
        } catch (err) {}

        try {
            fs.writeFileSync(TMP_KEYS_FILE, JSON.stringify(obj, null, 2), 'utf8');
        } catch (err) {}

        await this.syncToGist();
    }

    /**
     * Verifies if a given key is valid, active, and unexpired.
     * Increments usage count upon successful verification.
     */
    async verifyKey(keyString) {
        if (!keyString || typeof keyString !== 'string') {
            return { valid: false, reason: 'Key sağlanmadı.' };
        }

        const trimmed = keyString.trim();
        let entry = this.keys.get(trimmed);

        if (!entry) {
            // Check cloud storage in case key was just created in another instance
            await this.syncFromGist();
            entry = this.keys.get(trimmed);
        }

        if (!entry) {
            return { valid: false, reason: 'Geçersiz erişim anahtarı (Invalid access key).' };
        }

        if (!entry.active) {
            return { valid: false, reason: 'Bu anahtar devre dışı bırakılmış (Key revoked).' };
        }

        if (entry.expiresAt) {
            const now = new Date();
            const exp = new Date(entry.expiresAt);
            if (now > exp) {
                return { valid: false, reason: 'Bu anahtarın kullanım süresi dolmuş (Key expired).' };
            }
        }

        if (entry.maxUses && entry.useCount >= entry.maxUses) {
            return { valid: false, reason: 'Bu anahtar maksimum kullanım sınırına ulaştı (Usage limit reached).' };
        }

        // Record usage
        entry.useCount = (entry.useCount || 0) + 1;
        entry.lastUsedAt = new Date().toISOString();
        await this.saveKeys();

        return {
            valid: true,
            role: entry.role || 'user',
            label: entry.label || '',
            expiresAt: entry.expiresAt,
            useCount: entry.useCount,
            key: entry.key,
            rateLimit: entry.rateLimit !== undefined ? entry.rateLimit : (entry.role === 'admin' ? 0 : (entry.role === 'premium' ? 120 : 30)),
            features: entry.features || {
                canLookup: true,
                canCheckStores: true
            }
        };
    }

    /**
     * Generates a new access key (supports user, premium, admin)
     */
    async generateKey({ role = 'user', label = 'Client Key', expiresDays = null, maxUses = null, features = {}, rateLimit = null }) {
        const validRole = ['admin', 'premium', 'user'].includes(role) ? role : 'user';
        const randomHex = crypto.randomBytes(12).toString('hex');
        const prefix = validRole === 'admin' ? 'admin_' : (validRole === 'premium' ? 'prem_' : '');
        const key = `dfinder_${prefix}${randomHex}`;

        let expiresAt = null;
        if (expiresDays && Number(expiresDays) > 0) {
            const date = new Date();
            date.setDate(date.getDate() + Number(expiresDays));
            expiresAt = date.toISOString();
        }

        const defaultRateLimit = validRole === 'admin' ? 0 : (validRole === 'premium' ? 120 : 30);
        const resolvedRateLimit = rateLimit !== null && rateLimit !== undefined ? Number(rateLimit) : defaultRateLimit;

        const newEntry = {
            id: 'key_' + crypto.randomBytes(6).toString('hex'),
            key,
            role: validRole,
            label: label || (validRole === 'admin' ? 'Admin Key' : (validRole === 'premium' ? 'Premium VIP Key' : 'User Access Key')),
            createdAt: new Date().toISOString(),
            expiresAt,
            maxUses: maxUses ? Number(maxUses) : null,
            useCount: 0,
            active: true,
            rateLimit: resolvedRateLimit,
            features: {
                canLookup: features.canLookup !== false,
                canCheckStores: features.canCheckStores !== false
            }
        };

        this.keys.set(key, newEntry);
        await this.saveKeys();
        console.log(`🔑 [KEY MANAGER] Generated new [${validRole.toUpperCase()}] key: ${key} (${newEntry.label})`);
        return newEntry;
    }

    /**
     * Revokes or deletes a key
     */
    async revokeKey(keyString) {
        if (!keyString) return false;
        const entry = this.keys.get(keyString.trim());
        if (entry) {
            entry.active = false;
            await this.saveKeys();
            console.log(`🚫 [KEY MANAGER] Revoked key: ${keyString}`);
            return true;
        }
        return false;
    }

    /**
     * Updates an existing key's metadata (role, label, active, maxUses, expiresAt, features, rateLimit)
     */
    async updateKey(keyString, updates = {}) {
        if (!keyString) return null;
        const entry = this.keys.get(keyString.trim());
        if (!entry) return null;

        if (updates.role !== undefined && ['admin', 'premium', 'user'].includes(updates.role)) {
            entry.role = updates.role;
        }
        if (updates.label !== undefined) entry.label = updates.label;
        if (updates.active !== undefined) entry.active = Boolean(updates.active);
        if (updates.maxUses !== undefined) entry.maxUses = updates.maxUses ? Number(updates.maxUses) : null;
        if (updates.expiresAt !== undefined) entry.expiresAt = updates.expiresAt;
        if (updates.rateLimit !== undefined) entry.rateLimit = updates.rateLimit !== null ? Number(updates.rateLimit) : null;
        
        if (updates.features !== undefined) {
            entry.features = {
                ...(entry.features || { canLookup: true, canCheckStores: true }),
                ...updates.features
            };
        }

        entry.updatedAt = new Date().toISOString();
        await this.saveKeys();
        console.log(`✏️ [KEY MANAGER] Updated key: ${keyString} (${entry.label}, role: ${entry.role})`);
        return entry;
    }

    /**
     * Permanently deletes a key from database
     */
    async deleteKey(keyString) {
        if (!keyString) return false;
        const trimmed = keyString.trim();
        if (this.keys.has(trimmed)) {
            this.keys.delete(trimmed);
            await this.saveKeys();
            console.log(`🗑️ [KEY MANAGER] Permanently deleted key: ${trimmed}`);
            return true;
        }
        return false;
    }

    /**
     * Returns list of all keys for admin inspection
     */
    listKeys() {
        return Array.from(this.keys.values()).map(k => ({
            ...k,
            role: k.role || 'user',
            rateLimit: k.rateLimit !== undefined ? k.rateLimit : (k.role === 'admin' ? 0 : (k.role === 'premium' ? 120 : 30)),
            features: k.features || { canLookup: true, canCheckStores: true },
            isExpired: k.expiresAt ? new Date() > new Date(k.expiresAt) : false
        }));
    }
}

export const keyManager = new KeyManager();

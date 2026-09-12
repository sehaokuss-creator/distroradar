import crypto from 'crypto';

class SecurityGuard {
    constructor() {
        // Map of identifier -> array of timestamps
        this.rateLimitMap = new Map();
        this.WINDOW_MS = 60 * 1000; // 1 minute window
        this.MAX_REQUESTS = 30; // Max 30 requests per minute per IP/Key

        // Periodic cleanup of stale rate-limit entries
        setInterval(() => {
            const now = Date.now();
            for (const [id, timestamps] of this.rateLimitMap.entries()) {
                const fresh = timestamps.filter(t => now - t < this.WINDOW_MS);
                if (fresh.length === 0) {
                    this.rateLimitMap.delete(id);
                } else {
                    this.rateLimitMap.set(id, fresh);
                }
            }
        }, 30000);
    }

    /**
     * Extracts IP address accurately considering reverse proxies
     */
    getClientIp(req) {
        const xForwardedFor = req.headers['x-forwarded-for'];
        if (xForwardedFor) {
            return xForwardedFor.split(',')[0].trim().replace('::ffff:', '');
        }
        return (req.socket?.remoteAddress || '127.0.0.1').replace('::ffff:', '');
    }

    /**
     * Express middleware to enforce rate limiting per IP and per Access Key
     */
    rateLimiter(req, res, next) {
        const ip = this.getClientIp(req);
        const key = req.accessKey?.key || req.headers['x-access-key'] || req.query.key || 'no_key';
        const identifier = `${ip}_${key}`;

        // Role-based or custom rate limit
        let limit = this.MAX_REQUESTS; // default 30
        if (req.accessKey) {
            if (req.accessKey.role === 'admin' || req.accessKey.rateLimit === 0) {
                return next(); // Unlimited for admin
            }
            if (req.accessKey.rateLimit && req.accessKey.rateLimit > 0) {
                limit = req.accessKey.rateLimit;
            } else if (req.accessKey.role === 'premium') {
                limit = 120;
            }
        }

        const now = Date.now();
        const timestamps = this.rateLimitMap.get(identifier) || [];
        const recent = timestamps.filter(t => now - t < this.WINDOW_MS);

        if (recent.length >= limit) {
            const retryAfterSec = Math.ceil((this.WINDOW_MS - (now - recent[0])) / 1000);
            return res.status(429).json({
                success: false,
                error: `Çok fazla istek gönderildi (${limit} istek/dk sınırı). Lütfen ${retryAfterSec} saniye sonra tekrar deneyiniz (Rate limit exceeded).`,
                code: 'RATE_LIMITED',
                retryAfter: retryAfterSec
            });
        }

        recent.push(now);
        this.rateLimitMap.set(identifier, recent);
        next();
    }
}

export const securityGuard = new SecurityGuard();

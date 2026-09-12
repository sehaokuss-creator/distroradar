import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_FILE = path.join(__dirname, 'session.json');

const SUPABASE_URL = "https://gkteaslgsmlcpqtxxqxm.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_fNOA6BHT1fR1omVFuYegCA_e-ulwyrW";

let session = {
    accessToken: null,
    refreshToken: null,
    expiresAt: 0
};

// Initialize from file or env
export function initSession() {
    if (fs.existsSync(SESSION_FILE)) {
        try {
            session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            console.log('Loaded auth session from session.json');
            return;
        } catch (e) {
            console.error('Error reading session.json:', e.message);
        }
    }
    
    session.accessToken = "eyJhbGciOiJFUzI1NiIsImtpZCI6IjFjNDQwNzQ0LTljNDEtNGUyMy1iMDc2LTAyNDlkYWJmMzFhNiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2drdGVhc2xnc21sY3BxdHh4cXhtLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiI3OWExMjdlNi03NDExLTQ5NTMtYWNhZC1mMTI3YTgxOWYxMDAiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg4ODc5MDIzLCJpYXQiOjE3ODg4NzU0MjMsImVtYWlsIjoiYWxpcmVuYXNoYXRpcG9nbHVAZ21haWwuY29tIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJlbWFpbCIsInByb3ZpZGVycyI6WyJlbWFpbCJdfSwidXNlcl9tZXRhZGF0YSI6eyJlbWFpbCI6ImFsaXJlbmFzaGF0aXBvZ2x1QGdtYWlsLmNvbSIsImVtYWlsX3ZlcmlmaWVkIjp0cnVlLCJwaG9uZV92ZXJpZmllZCI6ZmFsc2UsInN1YiI6Ijc5YTEyN2U2LTc0MTEtNDk1My1hY2FkLWYxMjdhODE5ZjEwMCJ9LCJyb2xlIjoiYXV0aGVudGljYXRlZCIsImFhbCI6ImFhbDEiLCJhbXIiOlt7Im1ldGhvZCI6InBhc3N3b3JkIiwidGltZXN0YW1wIjoxNzg4ODcxMTc5fV0sInNlc3Npb25faWQiOiI1NjU4MGIyZS1hYjM4LTRhMTgtYWQ4ZS05ZmU4YTRmZjg5MTciLCJpc19hbm9ueW1vdXMiOmZhbHNlfQ.8mf7XKql-_M_Araum6xQsD43_MY0jEQFFmCGP-LSN_wceiGKTqaixq9_YBwJUVMhLjPkyyWEjbJw8WrSCSo_vA";
    session.refreshToken = "eoatdqdrgqwj"; // fresh token from refresh test
    session.expiresAt = 1788879023;
    saveSession();
}

function saveSession() {
    try {
        fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving session.json:', e.message);
    }
}

export function updateSession(accessToken, refreshToken = null) {
    if (!accessToken) return;
    session.accessToken = accessToken.trim();
    if (refreshToken) session.refreshToken = refreshToken.trim();
    session.expiresAt = Math.floor(Date.now() / 1000) + 3600;
    saveSession();
    console.log('✅ Session manually updated with new token.');
}

/**
 * Refreshes the session using Supabase refresh token endpoint
 */
export async function refreshAccessToken() {
    if (!session.refreshToken) {
        initSession();
    }

    console.log('🔄 Refreshing Supabase access token...');
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': PUBLISHABLE_KEY,
            'Authorization': `Bearer ${PUBLISHABLE_KEY}`
        },
        body: JSON.stringify({ refresh_token: session.refreshToken })
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Token refresh failed: HTTP ${resp.status} - ${errText}`);
    }

    const data = await resp.json();
    session.accessToken = data.access_token;
    session.refreshToken = data.refresh_token;
    session.expiresAt = data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600);
    saveSession();

    console.log('✅ Access token refreshed successfully! Expires at:', new Date(session.expiresAt * 1000).toLocaleTimeString());
    return session.accessToken;
}

/**
 * Returns a guaranteed valid access token, auto-refreshing if within 5 mins of expiry
 */
export async function getValidAccessToken() {
    if (!session.accessToken) {
        initSession();
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    // If expired or expiring in under 5 minutes (300s), refresh
    if (!session.accessToken || (session.expiresAt && session.expiresAt - nowSeconds < 300)) {
        return await refreshAccessToken();
    }

    return session.accessToken;
}

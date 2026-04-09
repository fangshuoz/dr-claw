/**
 * Gemini OAuth Token Management
 * ==============================
 *
 * Reads OAuth credentials from the Gemini CLI's token store (~/.gemini/oauth_creds.json),
 * extracts client credentials from the Gemini CLI bundle for token refresh,
 * and provides unified auth header resolution (OAuth → API key fallback).
 *
 * Modeled after OpenClaw's extensions/google/oauth.* modules.
 */

import { promises as fs } from 'fs';
import { existsSync, readFileSync, realpathSync, readdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { getGeminiApiKeyForUser } from './geminiApiKey.js';

const OAUTH_CREDS_PATH = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes early

// Environment variable keys (same as OpenClaw)
const CLIENT_ID_KEYS = [
  'OPENCLAW_GEMINI_OAUTH_CLIENT_ID',
  'GEMINI_CLI_OAUTH_CLIENT_ID',
  'VIBELAB_GEMINI_OAUTH_CLIENT_ID',
];
const CLIENT_SECRET_KEYS = [
  'OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET',
  'GEMINI_CLI_OAUTH_CLIENT_SECRET',
  'VIBELAB_GEMINI_OAUTH_CLIENT_SECRET',
];

let cachedClientCredentials = null;
let cachedOAuthTokens = null;
let cachedOAuthTokensMtime = 0;

// ---------------------------------------------------------------------------
// OAuth token loading & refresh
// ---------------------------------------------------------------------------

/**
 * Load raw OAuth credentials from ~/.gemini/oauth_creds.json
 * Returns null if the file doesn't exist.
 */
export async function loadGeminiOAuthTokens() {
  try {
    const stat = await fs.stat(OAUTH_CREDS_PATH);
    const mtime = stat.mtimeMs;

    // Use cache if file hasn't changed
    if (cachedOAuthTokens && mtime === cachedOAuthTokensMtime) {
      return cachedOAuthTokens;
    }

    const raw = await fs.readFile(OAUTH_CREDS_PATH, 'utf-8');
    const tokens = JSON.parse(raw);
    cachedOAuthTokens = tokens;
    cachedOAuthTokensMtime = mtime;
    return tokens;
  } catch {
    return null;
  }
}

/**
 * Check if the OAuth access token is expired (with buffer).
 */
export function isTokenExpired(tokens) {
  if (!tokens?.expiry_date) return true;
  return Date.now() >= (tokens.expiry_date - TOKEN_EXPIRY_BUFFER_MS);
}

/**
 * Refresh the access token using the refresh_token.
 * Writes updated credentials back to ~/.gemini/oauth_creds.json.
 */
export async function refreshAccessToken(tokens) {
  if (!tokens?.refresh_token) {
    throw new Error('No refresh token available');
  }

  const clientConfig = resolveOAuthClientConfig();
  if (!clientConfig) {
    throw new Error('Cannot refresh token: Gemini CLI OAuth client credentials not found. Install Gemini CLI or set GEMINI_CLI_OAUTH_CLIENT_ID/SECRET.');
  }

  const body = new URLSearchParams({
    client_id: clientConfig.clientId,
    client_secret: clientConfig.clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  const updatedTokens = {
    ...tokens,
    access_token: data.access_token,
    expiry_date: Date.now() + (data.expires_in * 1000),
    ...(data.id_token ? { id_token: data.id_token } : {}),
    ...(data.scope ? { scope: data.scope } : {}),
  };

  // Write back to file so Gemini CLI also benefits
  try {
    await fs.writeFile(OAUTH_CREDS_PATH, JSON.stringify(updatedTokens, null, 2), 'utf-8');
    cachedOAuthTokens = updatedTokens;
    cachedOAuthTokensMtime = Date.now();
    console.log('[GeminiOAuth] Access token refreshed and saved.');
  } catch (err) {
    console.warn('[GeminiOAuth] Failed to persist refreshed token:', err.message);
    // Still usable in-memory
    cachedOAuthTokens = updatedTokens;
  }

  return updatedTokens;
}

/**
 * Get a valid access token, refreshing if necessary.
 * Returns null if no OAuth credentials are available.
 */
export async function getValidAccessToken() {
  let tokens = await loadGeminiOAuthTokens();
  if (!tokens) return null;

  if (!tokens.access_token || isTokenExpired(tokens)) {
    if (!tokens.refresh_token) return null;
    try {
      tokens = await refreshAccessToken(tokens);
    } catch (err) {
      console.error('[GeminiOAuth] Token refresh failed:', err.message);
      return null;
    }
  }

  return tokens.access_token;
}

// ---------------------------------------------------------------------------
// Auth header resolution (OAuth → API key fallback)
// ---------------------------------------------------------------------------

/**
 * Returns { headers, authMethod } for authenticating Gemini API calls.
 * Prefers API key (consistent with queryGeminiApi env-var check), falls back to OAuth.
 */
export async function getGeminiAuthHeaders(userId) {
  // Try API key first (matches queryGeminiApi precedence)
  const apiKey = getGeminiApiKeyForUser(userId);
  if (apiKey) {
    return {
      headers: { 'x-goog-api-key': apiKey },
      authMethod: 'api-key',
    };
  }

  // Fallback to OAuth
  const accessToken = await getValidAccessToken();
  if (accessToken) {
    return {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      authMethod: 'oauth',
    };
  }

  return { headers: null, authMethod: null };
}

// ---------------------------------------------------------------------------
// Client credential extraction (from Gemini CLI bundle)
// ---------------------------------------------------------------------------

function resolveEnvVar(keys) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Extract OAuth client_id and client_secret from the Gemini CLI installation.
 * Same approach as OpenClaw: find the gemini binary, resolve it, search for oauth2.js.
 */
export function extractGeminiCliCredentials() {
  if (cachedClientCredentials) return cachedClientCredentials;

  try {
    const geminiPath = findInPath('gemini');
    if (!geminiPath) return null;

    const resolvedPath = realpathSync(geminiPath);
    const geminiCliDirs = resolveGeminiCliDirs(geminiPath, resolvedPath);

    for (const dir of geminiCliDirs) {
      const creds = readFromKnownPaths(dir) || readFromBundle(dir) || findInTree(dir, 10);
      if (creds) {
        cachedClientCredentials = creds;
        return creds;
      }
    }
  } catch {
    // Gemini CLI not installed
  }
  return null;
}

/**
 * Resolve client config: env vars → Gemini CLI extraction.
 * Returns null if neither source provides credentials.
 */
export function resolveOAuthClientConfig() {
  const envClientId = resolveEnvVar(CLIENT_ID_KEYS);
  const envClientSecret = resolveEnvVar(CLIENT_SECRET_KEYS);
  if (envClientId && envClientSecret) {
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  return extractGeminiCliCredentials();
}

// ---------------------------------------------------------------------------
// Helpers for finding credentials in Gemini CLI installation
// ---------------------------------------------------------------------------

function findInPath(name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function resolveGeminiCliDirs(geminiPath, resolvedPath) {
  const binDir = path.dirname(geminiPath);
  const candidates = [
    path.dirname(path.dirname(resolvedPath)),
    path.join(path.dirname(resolvedPath), 'node_modules', '@google', 'gemini-cli'),
    path.join(binDir, 'node_modules', '@google', 'gemini-cli'),
    path.join(path.dirname(binDir), 'node_modules', '@google', 'gemini-cli'),
    path.join(path.dirname(binDir), 'lib', 'node_modules', '@google', 'gemini-cli'),
  ];

  const seen = new Set();
  return candidates.filter((dir) => {
    const key = process.platform === 'win32' ? dir.replace(/\\/g, '/').toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return existsSync(path.join(dir, 'package.json')) ||
           existsSync(path.join(dir, 'node_modules', '@google', 'gemini-cli-core'));
  });
}

function parseCredentials(content) {
  const clientId =
    content.match(/OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/)?.[1] ??
    content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/)?.[1];
  const clientSecret =
    content.match(/OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/)?.[1] ??
    content.match(/(GOCSPX-[A-Za-z0-9_-]+)/)?.[1];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function readCredFile(filePath) {
  try {
    return parseCredentials(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readFromKnownPaths(geminiCliDir) {
  const searchPaths = [
    path.join(geminiCliDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'),
    path.join(geminiCliDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'code_assist', 'oauth2.js'),
  ];
  for (const p of searchPaths) {
    if (existsSync(p)) {
      const creds = readCredFile(p);
      if (creds) return creds;
    }
  }
  return null;
}

function readFromBundle(geminiCliDir) {
  const bundleDir = path.join(geminiCliDir, 'bundle');
  if (!existsSync(bundleDir)) return null;
  try {
    for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        const creds = readCredFile(path.join(bundleDir, entry.name));
        if (creds) return creds;
      }
    }
  } catch {}
  return null;
}

function findInTree(dir, depth) {
  if (depth <= 0) return null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'oauth2.js') {
        const creds = readCredFile(p);
        if (creds) return creds;
      }
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const found = findInTree(p, depth - 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

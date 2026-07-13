import 'dotenv/config';
// Bridge chạy ở services/zalo-bridge nhưng env thực tế nằm ở InvoiceFlow root
// (.env.local — share với Next.js). Load thêm từ đó nếu SUPABASE_URL chưa có.
// dotenv/config mặc định chỉ load .env, KHÔNG load .env.local → phải explicit.
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
const rootEnv = resolve(process.cwd(), '../../.env.local');
// Load .env.local nếu SUPABASE_URL HOẶC NEXT_PUBLIC_SUPABASE_URL chưa có
// (cả 2 đều dùng được nhờ migration RLS policy).
if (
  !process.env.SUPABASE_URL &&
  !process.env.NEXT_PUBLIC_SUPABASE_URL &&
  existsSync(rootEnv)
) {
  loadDotenv({ path: rootEnv });
}
import express from 'express';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import authRouter from './routes/auth.js';
import accountsRouter from './routes/accounts.js';
import statusRouter from './routes/status.js';
import extensionRouter from './routes/extension.js';
import zaloClientRouter, { zaloEventBus } from './routes/zalo-client.js';
import { sessionManager, setZaloEventBus } from './services/sessionManager.js';
import * as accountRegistry from './services/accountRegistry.js';
import { logger } from './utils/logger.js';

// Bootstrap registry: auto-register "shop-owner" nếu chưa có.
accountRegistry.ensureBootstrapped();

// Kết nối SSE event bus → sessionManager để forward message tới frontend real-time.
setZaloEventBus(zaloEventBus);

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3001;
const allowedOrigins = String(
  process.env.ALLOWED_ORIGINS ||
    'http://localhost:3000,http://127.0.0.1:3000,http://localhost:4000,http://127.0.0.1:4000,https://crm.smb.markeeai.com,https://seeding.markeeai.com,https://timetech.markeeai.com'
)
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS: cho phép InvoiceFlow frontend (4000) và extension gọi vào.
// Lưu ý: preflight (OPTIONS) phải echo lại Access-Control-Allow-Headers + Allow-Credentials
// với cùng giá trị mà request thật sẽ gửi. Header `x-user-id` là non-simple → bắt buộc.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || allowedOrigins[0]);
  }
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-api-key, x-user-id, x-account-id, x-requested-with'
  );
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Connect page (served with API key injected) ───────────────────────────────
const connectHtmlPath = join(__dirname, 'public', 'connect.html');
const extensionInstallHtmlPath = join(__dirname, 'public', 'extension-install.html');
const extensionZipPath = join(__dirname, 'public', 'markee-zalo-extension.zip');
const publicAssetsPath = join(__dirname, 'public', 'assets');
let connectHtmlTemplate = '';
let extensionInstallHtmlTemplate = '';
try {
  connectHtmlTemplate = readFileSync(connectHtmlPath, 'utf8');
} catch (_) {
  connectHtmlTemplate = '<h1>connect.html not found</h1>';
}
try {
  extensionInstallHtmlTemplate = readFileSync(extensionInstallHtmlPath, 'utf8');
} catch (_) {
  extensionInstallHtmlTemplate = '<h1>extension-install.html not found</h1>';
}

function sendConnectPage(req, res) {
  const html = connectHtmlTemplate
    .replace('{{BRIDGE_API_KEY}}', process.env.BRIDGE_API_KEY || '')
    .replace('{{BRIDGE_PORT}}', String(process.env.PORT || 3001));
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

app.get('/connect', sendConnectPage);
app.get('/zalo-bridge/connect', sendConnectPage);

function sendExtensionInstallPage(req, res, prefix = '') {
  const bridgeUrl = getBridgePublicUrl(req, prefix);
  const html = extensionInstallHtmlTemplate
    .replaceAll('{{DOWNLOAD_URL}}', `${bridgeUrl}/extension-download`)
    .replaceAll('{{BRIDGE_URL}}', bridgeUrl);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

function downloadExtension(req, res) {
  res.download(extensionZipPath, 'markee-zalo-extension.zip');
}

app.get('/extension-install', (req, res) => sendExtensionInstallPage(req, res));
app.get('/zalo-bridge/extension-install', (req, res) => sendExtensionInstallPage(req, res, '/zalo-bridge'));
app.get('/extension-download', downloadExtension);
app.get('/zalo-bridge/extension-download', downloadExtension);
app.use('/assets', express.static(publicAssetsPath));
app.use('/zalo-bridge/assets', express.static(publicAssetsPath));

function getBridgePublicUrl(req, prefix = '') {
  const envUrl = process.env.ZALO_BRIDGE_PUBLIC_URL || '';
  if (envUrl) return envUrl.replace(/\/+$/, '');

  const forwardedProto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('host');
  return `${forwardedProto}://${host}${prefix}`.replace(/\/+$/, '');
}

function sendBridgeConfig(req, res, prefix = '') {
  const bridgeUrl = getBridgePublicUrl(req, prefix);
  res.json({
    bridgeUrl,
    apiKey: process.env.BRIDGE_API_KEY || '',
    extensionInstallUrl:
      process.env.ZALO_EXTENSION_INSTALL_URL ||
      `${bridgeUrl}/extension-install`,
  });
}

app.get('/config', (req, res) => sendBridgeConfig(req, res));

// ── API Key guard (optional - set BRIDGE_API_KEY to enable) ──────────────────
const PUBLIC_PATHS = [
  '/connect',
  '/config',
  '/health',
  '/extension-install',
  '/extension-download',
  '/zalo-bridge/connect',
  '/zalo-bridge/config',
  '/zalo-bridge/health',
  '/zalo-bridge/extension-install',
  '/zalo-bridge/extension-download'
];
app.use((req, res, next) => {
  const key = process.env.BRIDGE_API_KEY;
  if (!key) return next();
  if (PUBLIC_PATHS.includes(req.path)) return next();
  if (req.path.startsWith('/auth/qr-image')) return next();
  if (req.path.startsWith('/zalo-bridge/auth/qr-image')) return next();
  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (provided !== key) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/auth/accounts', accountsRouter);
app.use('/status', statusRouter);
app.use('/api', extensionRouter);   // extension-login-zalo posts here
app.use('/api', zaloClientRouter);  // InvoiceFlow frontend consumes here

app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.use('/zalo-bridge/auth', authRouter);
app.use('/zalo-bridge/auth/accounts', accountsRouter);
app.use('/zalo-bridge/status', statusRouter);
app.use('/zalo-bridge/api', extensionRouter);
app.use('/zalo-bridge/api', zaloClientRouter);
app.get('/zalo-bridge/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/zalo-bridge/config', (req, res) => sendBridgeConfig(req, res, '/zalo-bridge'));

// ── Start ─────────────────────────────────────────────────────────────────────
const httpServer = createServer(app);
httpServer.listen(PORT, () => {
  logger.info(`Zalo Bridge started on port ${PORT}`);
  // Restore any persisted sessions on startup
  sessionManager.restoreAll().catch(err =>
    logger.error('Failed to restore sessions on startup', { err: err.message })
  );
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, graceful shutdown...');
  await sessionManager.destroyAll();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('CRITICAL: Uncaught Exception detected in Zalo Bridge process', {
    message: err.message,
    stack: err.stack,
  });
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('CRITICAL: Unhandled Rejection detected in Zalo Bridge process', {
    reason: String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

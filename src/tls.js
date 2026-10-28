// ============================================================
// tls.js - WebUI 自签名 HTTPS 证书
// 首次启动用 openssl 生成 data/tls/{cert,key}.pem，之后复用；损坏 / 临近过期时自动重签。
// data/ 已在 .gitignore 中排除，私钥不会进仓库。
// ============================================================
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { ROOT } from './paths.js';
import { logger } from './logger.js';

export const TLS_DIR = path.join(ROOT, 'data', 'tls');
export const CERT_FILE = path.join(TLS_DIR, 'cert.pem');
export const KEY_FILE = path.join(TLS_DIR, 'key.pem');

const CERT_DAYS = 3650;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000; // 剩不到 30 天就重签

/** openssl 优先取 OPENSSL_BIN，其次 PATH，最后找 Git for Windows 自带的（Windows 上最常见） */
function findOpenssl() {
  const list = [
    process.env.OPENSSL_BIN,
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  ].filter(Boolean);
  for (const bin of list) {
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
      return bin;
    } catch { /* 换下一个 */ }
  }
  return '';
}

/** 本机非回环 IPv4：写进 SAN，手机/别的电脑用局域网地址访问时证书名字才对得上 */
function lanIPv4() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
}

/** 现有证书是否还能用：能解析、未临近过期、公钥与私钥匹配 */
function certUsable() {
  try {
    const x509 = new crypto.X509Certificate(fs.readFileSync(CERT_FILE));
    if (Date.parse(x509.validTo) - Date.now() < RENEW_BEFORE_MS) return false;
    const pubFromKey = crypto.createPublicKey(fs.readFileSync(KEY_FILE))
      .export({ type: 'spki', format: 'der' });
    const pubFromCert = x509.publicKey.export({ type: 'spki', format: 'der' });
    return pubFromKey.equals(pubFromCert);
  } catch {
    return false;
  }
}

function generate() {
  const openssl = findOpenssl();
  if (!openssl) {
    throw new Error('生成 HTTPS 自签名证书需要 openssl，但没找到。'
      + '请安装 Git for Windows（自带 openssl），或在 .env 里用 OPENSSL_BIN 指定 openssl.exe 的完整路径。');
  }
  fs.mkdirSync(TLS_DIR, { recursive: true });
  const san = ['DNS:localhost', ...['127.0.0.1', ...lanIPv4()].map((ip) => `IP:${ip}`)].join(',');
  execFileSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
    '-days', String(CERT_DAYS),
    '-keyout', KEY_FILE, '-out', CERT_FILE,
    '-subj', '/CN=xiaona-webui',
    '-addext', `subjectAltName=${san}`,
  ], { windowsHide: true, stdio: 'pipe' });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* Windows 上 chmod 基本是空操作 */ }
  logger.info(`🔑 已生成 WebUI 自签名证书（有效期 ${CERT_DAYS} 天）：${CERT_FILE}`);
  logger.info(`   SAN: ${san}`);
}

/** 确保证书可用，返回 https.createServer 需要的 key / cert */
export function ensureTls() {
  if (!certUsable()) generate();
  return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
}

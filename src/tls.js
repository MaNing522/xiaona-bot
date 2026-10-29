// ============================================================
// tls.js - WebUI 自签名 HTTPS 证书
// 首次启动用 openssl 生成本地根证书（CA）+ 服务器证书到 data/tls/，之后复用；
// 服务器证书临近过期 / 损坏时自动用同一 CA 重签，CA 到期才重生成。
// 生成的 CA 会自动装进 Windows「当前用户 → 受信任的根证书」，浏览器不再提示不安全。
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
const CA_CERT = path.join(TLS_DIR, 'ca.crt');
const CA_KEY = path.join(TLS_DIR, 'ca.key');

const CA_DAYS = 3650;       // 根证书 10 年
const SERVER_DAYS = 397;    // 服务器证书 ≤398 天（对齐 Chrome 限制）
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000; // 剩不到 30 天就重签
const CA_CN = 'Xiaona WebUI Local CA';

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

function sanList() {
  return ['DNS:localhost', ...['127.0.0.1', '::1', ...lanIPv4()].map((ip) => `IP:${ip}`)].join(',');
}

function run(openssl, args) {
  execFileSync(openssl, args, { windowsHide: true, stdio: 'pipe' });
}

/** 证书在有效期内且公钥与私钥匹配 */
function certValid(certFile, keyFile) {
  try {
    const x509 = new crypto.X509Certificate(fs.readFileSync(certFile));
    if (Date.parse(x509.validTo) - Date.now() < RENEW_BEFORE_MS) return false;
    const pubFromKey = crypto.createPublicKey(fs.readFileSync(keyFile))
      .export({ type: 'spki', format: 'der' });
    const pubFromCert = x509.publicKey.export({ type: 'spki', format: 'der' });
    return pubFromKey.equals(pubFromCert);
  } catch {
    return false;
  }
}

/** 服务器证书是否由本地 CA 签发（老版本自签叶子证书会走到这里被替换） */
function issuedByCa() {
  try {
    return new crypto.X509Certificate(fs.readFileSync(CERT_FILE))
      .checkIssued(new crypto.X509Certificate(fs.readFileSync(CA_CERT)));
  } catch {
    return false;
  }
}

/** 生成 CA（不存在或快过期）+ 用 CA 签发服务器证书 */
function generate(openssl) {
  fs.mkdirSync(TLS_DIR, { recursive: true });
  if (!certValid(CA_CERT, CA_KEY)) {
    run(openssl, [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-days', String(CA_DAYS),
      '-keyout', CA_KEY, '-out', CA_CERT,
      '-subj', `/CN=${CA_CN}`,
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-addext', 'subjectKeyIdentifier=hash',
    ]);
    logger.info(`🔑 已生成本地根证书（${CA_DAYS} 天）：${CA_CERT}`);
  }

  const san = sanList();
  const csr = path.join(TLS_DIR, 'server.csr');
  const ext = path.join(TLS_DIR, 'server.ext');
  const srl = path.join(TLS_DIR, 'ca.srl');
  for (const f of [csr, ext, srl]) { try { fs.unlinkSync(f); } catch { /* 不存在就算了 */ } }
  try {
    run(openssl, [
      'req', '-new', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', KEY_FILE, '-out', csr,
      '-subj', '/CN=xiaona-webui',
      '-addext', `subjectAltName=${san}`,
    ]);
    fs.writeFileSync(ext, [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${san}`,
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid,issuer',
      '',
    ].join('\n'));
    run(openssl, [
      'x509', '-req', '-in', csr, '-CA', CA_CERT, '-CAkey', CA_KEY,
      '-CAcreateserial', '-CAserial', srl,
      '-out', CERT_FILE, '-days', String(SERVER_DAYS), '-sha256', '-extfile', ext,
    ]);
  } finally {
    for (const f of [csr, ext, srl]) { try { fs.unlinkSync(f); } catch { /* 清理失败不影响 */ } }
  }
  try { fs.chmodSync(KEY_FILE, 0o600); fs.chmodSync(CA_KEY, 0o600); } catch { /* Windows 上 chmod 基本是空操作 */ }
  logger.info(`🔑 已签发 WebUI 服务器证书（${SERVER_DAYS} 天）：${CERT_FILE}`);
  logger.info(`   SAN: ${san}`);
}

/** 这个 CA 是否已在 Windows 当前用户的「受信任的根证书颁发机构」里 */
function caTrusted() {
  try {
    const thumb = new crypto.X509Certificate(fs.readFileSync(CA_CERT))
      .fingerprint.replace(/:/g, '');
    execFileSync('certutil.exe', ['-user', '-verifystore', 'Root', thumb], {
      windowsHide: true, stdio: 'ignore', timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/** 把 CA 装进当前用户的受信任根证书（Chrome / Edge 会直接用，Firefox 需手动导入） */
function trustCa() {
  if (process.platform !== 'win32') return;
  if (String(process.env.WEBUI_TLS_TRUST || '').toLowerCase() === 'false') return;
  if (caTrusted()) return;
  try {
    execFileSync('certutil.exe', ['-addstore', '-user', '-f', 'Root', CA_CERT], {
      windowsHide: true, stdio: 'ignore', timeout: 15000,
    });
    logger.info('✅ 已将本地根证书加入 Windows「受信任的根证书」，Chrome / Edge 不再提示不安全');
    logger.info('   Firefox 使用独立证书库，首次访问仍会提示，可在设置里导入 data/tls/ca.crt');
  } catch (e) {
    logger.warn(`⚠️  本地根证书自动信任失败（${e.code || e.message}），可在浏览器提示页点「高级 → 继续访问」`);
  }
}

/** 确保证书可用且已受信任，返回 https.createServer 需要的 key / cert */
export function ensureTls() {
  const needGen = !certValid(CERT_FILE, KEY_FILE) || !issuedByCa() || !certValid(CA_CERT, CA_KEY);
  if (needGen) {
    const openssl = findOpenssl();
    if (!openssl) {
      throw new Error('生成 HTTPS 证书需要 openssl，但没找到。'
        + '请安装 Git for Windows（自带 openssl），或在 .env 里用 OPENSSL_BIN 指定 openssl.exe 的完整路径。');
    }
    generate(openssl);
  }
  trustCa();
  return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) };
}

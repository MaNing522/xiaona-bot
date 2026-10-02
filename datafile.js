// ============================================================
// datafile.js - 数据文件读写小工具
// 落盘一律「先写 .tmp 再改名」：同目录改名是原子操作，
// 进程被杀 / 断电时不会留下半截 JSON 把整份数据写坏。
// 读取失败会记日志（而不是静默当成空数据，避免"数据悄悄没了"）。
// ============================================================
import fs from 'fs';
import path from 'path';

/** 原子写入 JSON */
export function writeJsonAtomic(file, value) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    // 写盘失败不能让机器人崩掉，但必须留下痕迹
    console.error(`⚠️ 数据落盘失败：${path.basename(file)} — ${e.message}`);
    return false;
  }
}

/** 读 JSON：不存在返回 fallback；解析失败记日志后返回 fallback */
export function readJsonSafe(file, fallback, label = '') {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`⚠️ 数据文件读取失败，已按默认值处理：${label || path.basename(file)} — ${e.message}`);
    return fallback;
  }
}

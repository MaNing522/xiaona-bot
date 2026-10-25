// ============================================================
// paths.js - 项目根目录
// 本文件在 src/ 下，向上一级就是项目根（.env、config.json、data/、logs/ 等所在）。
// 所有运行时资源统一从 ROOT 拼接，不写死盘符 —— 整个项目目录复制到别处也能直接跑。
// ============================================================
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

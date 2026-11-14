// ============================================================
// aiProviders.js - 网页可管理的 AI 接口（供应商）
// 存在 data/ai-providers.json（data/ 已被 .gitignore 忽略，密钥不会进仓库）：
//   { "active": "id / '' / 'fallback'", "list": [{ id, name, url, model, key }] }
// active：'' = 按 .env 主接口（掉线自动切备用）；'fallback' = 强制用 .env 备用；
//         其它 = list 里的接口 id。
// 每次请求现读文件（带 mtime 缓存），网页改完下一条消息就生效。
// ============================================================
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ROOT } from './paths.js';
import { readJsonSafe, writeJsonAtomic } from './datafile.js';

const FILE = path.join(ROOT, 'data', 'ai-providers.json');
const EMPTY = { active: '', list: [] };

let cache = EMPTY;
let mtime = 0;
let loaded = false;

function load() {
    try {
        const st = fs.statSync(FILE);
        if (!loaded || st.mtimeMs !== mtime) {
            const raw = readJsonSafe(FILE, null, 'ai-providers.json');
            const data = raw && typeof raw === 'object' ? raw : {};
            cache = {
                active: String(data.active || ''),
                list: Array.isArray(data.list) ? data.list.filter((p) => p && typeof p === 'object').map((p) => ({
                    id: String(p.id || ''),
                    name: String(p.name || ''),
                    url: String(p.url || ''),
                    model: String(p.model || ''),
                    key: String(p.key || ''),
                })).filter((p) => p.id && p.url && p.model) : [],
            };
            mtime = st.mtimeMs;
            loaded = true;
        }
    } catch {
        // 文件不存在（还没配过自定义接口）：保持当前缓存
    }
    return cache;
}

function persist(data) {
    if (!writeJsonAtomic(FILE, data)) return false;
    cache = data;
    loaded = true;
    mtime = 0; // 下一轮强制重读，避免 mtime 精度问题
    return true;
}

/** 全部自定义接口（含密钥，仅供服务端内部使用） */
export function listProviders() {
    return load().list.map((p) => ({ ...p }));
}

/** 当前选中的接口 id：''=自动，'fallback'=官方备用，其它=自定义接口 */
export function getActiveId() {
    return load().active;
}

/** 当前选中的自定义接口；没选/找不到返回 null */
export function activeProvider() {
    const c = load();
    if (!c.active || c.active === 'fallback') return null;
    return c.list.find((p) => p.id === c.active) || null;
}

/** 切换当前接口 */
export function setActive(id) {
    const c = load();
    const v = String(id || '').trim();
    if (v && v !== 'fallback' && !c.list.some((p) => p.id === v)) {
        return { ok: false, error: '接口不存在' };
    }
    return persist({ active: v, list: c.list }) ? { ok: true } : { ok: false, error: '写入失败' };
}

/** 新增/更新一个接口（更新时 key 留空表示保持原密钥） */
export function saveProvider({ id, name, url, model, key }) {
    const c = load();
    const p = {
        id: String(id || '').trim() || crypto.randomBytes(4).toString('hex'),
        name: String(name || '').trim(),
        url: String(url || '').trim().replace(/\/+$/, ''),
        model: String(model || '').trim(),
        key: String(key || '').trim(),
    };
    if (!/^https?:\/\//i.test(p.url)) return { ok: false, error: '接口地址要以 http:// 或 https:// 开头' };
    if (!p.model) return { ok: false, error: '模型名不能为空' };
    const idx = c.list.findIndex((x) => x.id === p.id);
    if (idx >= 0) {
        if (!p.key) p.key = c.list[idx].key;
        if (!p.name) p.name = c.list[idx].name;
        c.list[idx] = p;
    } else {
        if (!p.key) return { ok: false, error: '新接口必须填密钥' };
        if (!p.name) p.name = p.model;
        c.list.push(p);
    }
    return persist({ active: c.active, list: c.list }) ? { ok: true, id: p.id } : { ok: false, error: '写入失败' };
}

/** 删除接口；如果删的正是当前选中的，自动切回自动模式 */
export function deleteProvider(id) {
    const c = load();
    const v = String(id || '').trim();
    const list = c.list.filter((p) => p.id !== v);
    if (list.length === c.list.length) return { ok: false, error: '接口不存在' };
    const active = c.active === v ? '' : c.active;
    return persist({ active, list }) ? { ok: true } : { ok: false, error: '写入失败' };
}


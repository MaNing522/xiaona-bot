// ============================================================
// edgeDrm.js - Edge 朗读服务的 Sec-MS-GEC 令牌（v2 格式）
//
// 逐位移植自 edge-tts 7.3.1 的 drm.py。微软新版服务要求 Sec-MS-GEC 为
//     "<16 位 CS64 十六进制>-<64 位 SHA256 十六进制>"
// 而不是老版本那种「纯 64 位 SHA256」——发老格式会被直接拒（403）。
//
// 这里的两段哈希都是微软魔改过的：SHA256 用的是改过常量的变体，
// CS64 更是自研混淆算法，所以不能用 Node 自带的 crypto 直接算。
// 全部用 BigInt 复刻 Python 的任意精度取模运算，保证输出逐字节一致。
//
// 对外只暴露一个函数：generateSecMsGec(unixSeconds)。
// ============================================================

const MASK = 0xFFFFFFFFn;
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EPOCH = 11644473600;

// ---------- SHA256 变体（常量取自 edge-tts） ----------
const SHA256_INITIAL = [
    0x6A09E667n, 0xBB67AE85n, 0x3C6EF372n, 0xA54FF53An,
    0x510E527Fn, 0x9B05688Cn, 0x1F83D9ABn, 0x5BE0CD19n,
];
const SHA256_STATE = [
    0xFD9FBEA2n, 0x91243CE7n, 0xBE499094n, 0xCD2E1E0An,
    0x6C006F49n, 0x04BD35ABn, 0xFEB0A7E4n, 0x03EFFBD2n,
];
const SHA256_SCHEDULE = [
    0xEB24BF9En, 0x1558691Fn, 0xA0C09EE2n, 0x0CFA32BAn,
    0xA622EE8Cn, 0xD1DD9491n, 0xC0DD25A0n, 0xF9E70AB6n,
    0xF0C31573n, 0x7058CE4En, 0x7188E606n, 0x00E5AB33n,
    0xD258B060n, 0x72766564n,
];
const SHA256_ROUND_CONSTANTS = [
    0x428A2F98n, 0x71374491n, 0xB5C0FBCFn, 0xE9B5DBA5n,
    0x3956C25Bn, 0x59F111F1n, 0x923F82A4n, 0xAB1C5ED5n,
    0xD807AA98n, 0x12835B01n, 0x243185BEn, 0x550C7DC3n,
    0x72BE5D74n, 0x80DEB1FEn, 0x9BDC06A7n, 0xC19BF174n,
    0xE49B69C1n, 0xEFBE4786n, 0x0FC19DC6n, 0x240CA1CCn,
    0x2DE92C6Fn, 0x4A7484AAn, 0x5CB0A9DCn, 0x76F988DAn,
    0x983E5152n, 0xA831C66Dn, 0xB00327C8n, 0xBF597FC7n,
    0xC6E00BF3n, 0xD5A79147n, 0x06CA6351n, 0x14292967n,
    0x27B70A85n, 0x2E1B2138n, 0x4D2C6DFCn, 0x53380D13n,
    0x650A7354n, 0x766A0ABBn, 0x81C2C92En, 0x92722C85n,
    0xA2BFE8A1n, 0xA81A664Bn, 0xC24B8B70n, 0xC76C51A3n,
    0xD192E819n, 0xD6990624n, 0xF40E3585n, 0x106AA070n,
    0x19A4C116n, 0x1E376C08n, 0x2748774Cn, 0x34B0BCB5n,
    0x391C0CB3n, 0x4ED8AA4An, 0x5B9CCA4Fn, 0x682E6FF3n,
    0x748F82EEn, 0x78A5636Fn, 0x84C87814n, 0x8CC70208n,
    0x90BEFFFAn, 0xA4506CEBn, 0xBEF9A3F7n, 0xC67178F2n,
];
const SHA256_ADJUSTMENT = 0xC9DC06A7n;
// 第 14 号轮常量被替换掉，用于从 state 常量接着往下算（前 14 轮已预折进 state）
const SHA256_BLOCK_CONSTANTS = [
    ...SHA256_ROUND_CONSTANTS.slice(0, 14),
    SHA256_ADJUSTMENT,
    ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80n;
const SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0n;

// ---------- CS64 混淆算法常量 ----------
const CS64_COEFFICIENTS = [
    [0xE82E91B1n, 0xB32700D0n], [0x44DE24C6n, 0x88DFF51Dn],
    [0x3BEB65BCn, 0x29514038n], [0xC89C5933n, 0xB328CBDFn],
    [0x8D1EC211n, 0xD405B4D5n], [0x314EF5D5n, 0x26E55F3Cn],
    [0xE92491B1n, 0x607801C6n], [0xF0A5B9D5n, 0x82B2C1FBn],
    [0x06064CF3n, 0xFA51A3DAn], [0xDA79FA60n, 0x207CC464n],
    [0xBED20560n, 0x3C3C74F3n], [0x89F9C9F8n, 0xD2D14B61n],
    [0x35FA38C6n, 0xBB04A2C1n], [0xCB49E3C6n, 0xC5626167n],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJUSTMENT0 = 0xF2F90B1An;
const CS64_ADJUSTMENT1 = 0x0B1A0000n;

/** 32 位左循环移位 16 位 */
function rol16(value) {
    value &= MASK;
    return ((value << 16n) | (value >> 16n)) & MASK;
}

/** SHA256 的 σ0（合并旋转后一次性截断） */
function sigma0(value) {
    return ((value >> 7n) ^ (value << 25n) ^ (value >> 18n) ^ (value << 14n) ^ (value >> 3n)) & MASK;
}
/** SHA256 的 σ1 */
function sigma1(value) {
    return ((value >> 17n) ^ (value << 15n) ^ (value >> 19n) ^ (value << 13n) ^ (value >> 10n)) & MASK;
}

/** 跑若干轮 SHA256（可从第一个块的第 14 轮接着跑） */
function sha256Rounds(state, words, firstRound = 0) {
    let [a, b, c, d, e, f, g, h] = state;
    const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
    const aligned = Math.min(64, Math.floor((firstRound + 7) / 8) * 8);
    for (let index = firstRound; index < aligned; index++) {
        const rotE = e * 0x100000001n;
        const rotA = a * 0x100000001n;
        const t1 = h
            + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n))
            + (g ^ (e & (f ^ g)))
            + constants[index] + words[index];
        const t2 = ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n))
            + ((a & b) | (c & (a | b)));
        [a, b, c, d, e, f, g, h] = [
            (t1 + t2) & MASK, a, b, c, (d + t1) & MASK, e, f, g,
        ];
    }
    // 每 8 轮一组的展开写法：只更新两个寄存器，其余靠变量角色轮转
    for (let index = aligned; index < 64; index += 8) {
        let rotE = e * 0x100000001n;
        let rotA = a * 0x100000001n;
        let t1 = h + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (g ^ (e & (f ^ g))) + constants[index] + words[index];
        d = (d + t1) & MASK;
        h = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((a & b) | (c & (a | b)))) & MASK;

        rotE = d * 0x100000001n;
        rotA = h * 0x100000001n;
        t1 = g + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (f ^ (d & (e ^ f))) + constants[index + 1] + words[index + 1];
        c = (c + t1) & MASK;
        g = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((h & a) | (b & (h | a)))) & MASK;

        rotE = c * 0x100000001n;
        rotA = g * 0x100000001n;
        t1 = f + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (e ^ (c & (d ^ e))) + constants[index + 2] + words[index + 2];
        b = (b + t1) & MASK;
        f = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((g & h) | (a & (g | h)))) & MASK;

        rotE = b * 0x100000001n;
        rotA = f * 0x100000001n;
        t1 = e + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (d ^ (b & (c ^ d))) + constants[index + 3] + words[index + 3];
        a = (a + t1) & MASK;
        e = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((f & g) | (h & (f | g)))) & MASK;

        rotE = a * 0x100000001n;
        rotA = e * 0x100000001n;
        t1 = d + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (c ^ (a & (b ^ c))) + constants[index + 4] + words[index + 4];
        h = (h + t1) & MASK;
        d = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((e & f) | (g & (e | f)))) & MASK;

        rotE = h * 0x100000001n;
        rotA = d * 0x100000001n;
        t1 = c + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (b ^ (h & (a ^ b))) + constants[index + 5] + words[index + 5];
        g = (g + t1) & MASK;
        c = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((d & e) | (f & (d | e)))) & MASK;

        rotE = g * 0x100000001n;
        rotA = c * 0x100000001n;
        t1 = b + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (a ^ (g & (h ^ a))) + constants[index + 6] + words[index + 6];
        f = (f + t1) & MASK;
        b = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((c & d) | (e & (c | d)))) & MASK;

        rotE = f * 0x100000001n;
        rotA = b * 0x100000001n;
        t1 = a + ((rotE >> 6n) ^ (rotE >> 11n) ^ (rotE >> 25n)) + (h ^ (f & (g ^ h))) + constants[index + 7] + words[index + 7];
        e = (e + t1) & MASK;
        a = (t1 + ((rotA >> 2n) ^ (rotA >> 13n) ^ (rotA >> 22n)) + ((b & c) | (d & (b | c)))) & MASK;
    }
    return [a, b, c, d, e, f, g, h];
}

/** 扩展消息字表，旋转结果先留着高位、最后统一取模相加 */
function expandSha256Schedule(words, firstWord = 16) {
    for (let index = firstWord; index < 64; index++) {
        const x = words[index - 2];
        const y = words[index - 15];
        const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
        const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
        words.push((s1 + words[index - 7] + s0 + words[index - 16]) & MASK);
    }
}

/** 前 7 字节参与构建初始 state，其余在 digest 里续上 */
function sha256Init(data) {
    const words = new Array(14).fill(0n);
    words.push(BigInt(data.readUIntBE(0, 3)));
    words.push(BigInt(data.readUInt32BE(3)));
    for (let index = 16; index < 30; index++) {
        let value = SHA256_SCHEDULE[index - 16];
        if (index - 2 >= 14) {
            value += index === 16
                ? (sigma1(words[index - 2]) ^ SHA256_SIGMA1_ADJUSTMENT)
                : sigma1(words[index - 2]);
        }
        if (index - 7 >= 14) value += words[index - 7];
        if (index - 15 >= 14) {
            value += index === 29
                ? (sigma0(words[index - 15]) ^ SHA256_SIGMA0_ADJUSTMENT)
                : sigma0(words[index - 15]);
        }
        words.push(value & MASK);
    }
    words.push((sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14]
        + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) & MASK);
    expandSha256Schedule(words, 31);
    const working = sha256Rounds([...SHA256_STATE], words, 14);
    return SHA256_INITIAL.map((x, i) => (x + working[i]) & MASK);
}

/** 变体 SHA256 摘要（返回 32 字节 Buffer） */
function sha256Digest(data) {
    if (data.length < 7) throw new Error('token 盐值至少需要 7 字节');
    const length = 57 + data.length;
    const zeroCount = ((55 - length) % 64 + 64) % 64;
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64BE(BigInt(length) * 8n);
    const padded = Buffer.concat([
        data.subarray(7),
        Buffer.from([0x80]),
        Buffer.alloc(zeroCount),
        lenBuf,
    ]);
    let state = sha256Init(data.subarray(0, 7));
    for (let offset = 0; offset < padded.length; offset += 64) {
        const words = [];
        for (let i = 0; i < 16; i++) words.push(BigInt(padded.readUInt32BE(offset + i * 4)));
        expandSha256Schedule(words, 16);
        const working = sha256Rounds(state, words, 0);
        state = state.map((s, i) => (s + working[i]) & MASK);
    }
    const out = Buffer.alloc(32);
    state.forEach((s, i) => out.writeUInt32BE(Number(s), i * 4));
    return out;
}

/** 拆成小端 32 位字，必要时补一个 0 让个数为偶数 */
function wordsLe4Even(data) {
    const pad = (-data.length % 4 + 4) % 4;
    const padded = Buffer.concat([data, Buffer.alloc(pad)]);
    if (!padded.length) return [];
    const words = [];
    for (let i = 0; i < padded.length; i += 4) words.push(BigInt(padded.readUInt32LE(i)));
    if (words.length % 2) words.push(0n);
    return words;
}

/** CS64 混淆摘要（返回两个 32 位值） */
function cs64Digest(data, digestBytes) {
    let keyA = BigInt(digestBytes.readUInt32LE(0));
    let keyB = BigInt(digestBytes.readUInt32LE(4));
    keyA |= 1n;
    keyB |= 1n;
    const factors = [(keyA * CS64_FACTOR) & MASK, (keyB * CS64_FACTOR) & MASK];
    const terms = CS64_COEFFICIENTS.map((c, i) => (c[0] * factors[i % 2]) & MASK);
    const offsets = CS64_COEFFICIENTS.map((c) => c[1]);

    for (const [index, word] of wordsLe4Even(Buffer.concat([Buffer.from([0x00]), data])).entries()) {
        let term = word * (index % 2 === 0 ? keyA : keyB);
        let offset = rol16(word) * (index % 2 === 0 ? 0xEF0569FBn : 0xC31713DBn);
        if (index === 0) {
            term += CS64_ADJUSTMENT0 * factors[0];
            offset += CS64_ADJUSTMENT1;
        }
        terms.push(term & MASK);
        offsets.push(offset & MASK);
    }

    let swapAcc = 0n;
    let swapLast = 0n;
    let state = 0n;
    let acc = 0n;
    for (let index = 0; index < terms.length; index += 2) {
        const x = terms[index];
        const y = terms[index + 1];
        let t = rol16((offsets[index] + x) & MASK);
        let q = (t * 0x76F50F34n) & MASK;
        swapAcc += (rol16(q) * 0xC3EFEA97n + q) & MASK;
        t = rol16((offsets[index + 1] + y) & MASK);
        q = (t * 0x1881CE3Cn) & MASK;
        swapLast = (rol16(q) * 0x35BD1EC9n + q) & MASK;
        swapAcc = (swapAcc + swapLast) & MASK;

        state = (state * keyA + x) & MASK;
        state = (rol16(state) * 0xCF98B111n) & MASK;
        state = (rol16(state) * 0x87085B9Fn) & MASK;
        state = (rol16(state) * 0x12CEB96Dn) & MASK;
        state = (rol16(state) * 0x257E1D83n) & MASK;
        acc += state;
        t = (state * keyB + y) & MASK;
        t = (rol16(t) * 0xA27416F5n) & MASK;
        t = (rol16(t) * 0xD38396FFn) & MASK;
        state = (rol16((rol16(t) * 0x7C932B89n) & MASK) * 0xBFA49F69n) & MASK;
        acc = (acc + state) & MASK;
    }
    return [swapLast ^ state, swapAcc ^ acc];
}

/**
 * 生成 v2 版 Sec-MS-GEC：`<CS64 16 位>-<SHA256 64 位>`（均大写十六进制）。
 * @param {number} unixSeconds 当前 Unix 时间（秒，可带小数）
 */
export function generateSecMsGec(unixSeconds) {
    let ticks = unixSeconds + WIN_EPOCH;   // 换算到 Windows 文件时间（秒）
    ticks -= ticks % 300;                  // 向下取整到 5 分钟一档
    ticks *= 1e7;                          // 换算成 100 纳秒（与 edge-tts 一致的浮点算法）
    const data = Buffer.from(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
    const digest = sha256Digest(data);
    const [a, b] = cs64Digest(data, digest);
    const cs64 = Buffer.alloc(8);
    cs64.writeUInt32LE(Number(a), 0);
    cs64.writeUInt32LE(Number(b), 4);
    return `${cs64.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

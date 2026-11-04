// ============================================================
// screenshot.js - 本机屏幕截图 + 指定网址截图
// ============================================================
import { execFile, execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const IS_WIN = process.platform === 'win32';

// Windows 用 Edge；Linux 服务器用 Chrome / Chromium（装了哪个用哪个）
const EDGE_CANDIDATES = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

/** 找一个能用来做网址截图的浏览器；找不到返回 '' */
function findBrowser() {
    if (IS_WIN) return EDGE_CANDIDATES.find((p) => fs.existsSync(p)) || '';
    for (const name of LINUX_BROWSERS) {
        try {
            execFileSync('which', [name], { stdio: 'ignore', timeout: 3000 });
            return name;
        } catch { /* 换下一个 */ }
    }
    return '';
}

function run(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: timeoutMs || 60000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                err.stderr = String(stderr || '');   // 带上浏览器输出，失败时能看出原因
                reject(err);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等截图文件落盘（浏览器退出时可能还没写完） */
async function waitFile(p, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try {
            if (fs.statSync(p).size > 0) return true;
        } catch { /* 还没生成 */ }
        await sleep(200);
    }
    return false;
}

// 将 PS 脚本写入临时文件再以 -File 执行（避免 -Command 方式下引号被二次解析破坏）
function runPs(script, timeoutMs) {
    const psFile = path.join(os.tmpdir(), `qqbot-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    fs.writeFileSync(psFile, script, 'utf8');
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile], timeoutMs)
        .finally(() => fs.unlink(psFile, () => {}));
}

function uniqueName(dir, ext) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(dir, `${ts}${ext}`).replace(/\\/g, '/');
}

// 截取本机主屏幕（DPI 感知 + 超大图等比缩小，避免尺寸错误）
export async function captureScreen(saveDir) {
    // 服务器（Linux）一般没有桌面环境：截图必然失败，直接给一句人话，别抛 PowerShell 的报错
    if (!IS_WIN) throw new Error('当前系统没有可截取的桌面（服务器无桌面环境），请改用 #shot <网址>');
    const out = uniqueName(path.resolve(saveDir), '.png');
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiHelper { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[DpiHelper]::SetProcessDPIAware() | Out-Null
$out = '${out}'
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw '无法获取屏幕尺寸' }
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$max = 2560
if ($bounds.Width -gt $max -or $bounds.Height -gt $max) {
  $scale = [Math]::Min($max / $bounds.Width, $max / $bounds.Height)
  $nw = [int]($bounds.Width * $scale); $nh = [int]($bounds.Height * $scale)
  $bmp2 = New-Object System.Drawing.Bitmap $nw, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $nw, $nh)
  $bmp2.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g2.Dispose(); $bmp2.Dispose()
} else {
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
}
$g.Dispose(); $bmp.Dispose()
`;
    await runPs(ps);
    return out;
}

// 用浏览器无头模式给网址截图
// Edge 有时候会「正常退出但没写出截图」（比如被转交给已开着的浏览器实例、链接是下载文件、
// 或者截图还没落盘），所以这里重试两种 headless 参数并等文件出现，失败时带上浏览器输出。
export async function captureUrl(url, saveDir) {
    const browser = findBrowser();
    if (!browser) throw new Error(IS_WIN ? '未找到 Edge，无法进行网址截图'
        : '未找到 Chrome/Chromium，无法进行网址截图（apt install -y chromium-browser）');
    const out = uniqueName(path.resolve(saveDir), '.png');
    fs.rmSync(out, { force: true });
    const common = [
        '--disable-gpu', '--no-first-run', '--no-sandbox',
        '--disable-features=msEdgeFirstRunExperience',
        '--window-size=1280,800', '--virtual-time-budget=8000',
        `--screenshot=${out}`, url,
    ];
    let lastLog = '';
    for (const headless of ['--headless=new', '--headless']) {
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-edge-'));
        try {
            try {
                const r = await run(browser, [headless, `--user-data-dir=${profile}`, ...common], 60000);
                lastLog = String((r && r.stderr) || '').trim();
            } catch (e) {
                lastLog = String((e && (e.stderr || e.message)) || e).trim();
            }
            if (await waitFile(out, 5000)) return out;
            fs.rmSync(out, { force: true });
        } finally {
            try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 临时目录删不掉就算了 */ }
        }
    }
    const tail = lastLog.split(/\r?\n/).filter(Boolean).pop() || '';
    throw new Error(`浏览器没有生成截图${tail ? `（${tail.slice(0, 120)}）` : '，可能该链接是下载文件或被拦截'}`);
}

/** 找 ImageMagick 的命令（Linux 上用来裁剪头像；Windows 走 PowerShell） */
function findMagick() {
    for (const [bin, args] of [['magick', ['-version']], ['convert', ['-version']], ['gm', ['version']]]) {
        try {
            execFileSync(bin, args, { stdio: 'ignore', timeout: 3000 });
            return bin;
        } catch { /* 换下一个 */ }
    }
    return '';
}

// 居中裁剪为正方形（QQ 头像要求），输出 PNG；outPath 提供时写入该路径（用于缓存复用）
export async function cropSquare(srcPath, outDir, outPath = null) {
    const out = outPath || uniqueName(path.resolve(outDir), '.png');
    if (outPath && fs.existsSync(outPath)) return outPath;
    if (outPath) fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // Linux 没有 System.Drawing，用 ImageMagick 做同样的居中裁剪
    if (!IS_WIN) {
        const magick = findMagick();
        if (!magick) throw new Error('服务器换头像需要 ImageMagick（apt install -y imagemagick）');
        const prefix = magick === 'gm' ? ['convert'] : [];
        const dims = execFileSync(magick, [...prefix, 'identify', '-format', '%w %h', srcPath], { encoding: 'utf8' });
        const [w, h] = dims.trim().split(/\s+/).map(Number);
        if (!w || !h) throw new Error('读取图片尺寸失败');
        const size = Math.min(w, h);
        execFileSync(magick, [...prefix, 'convert', srcPath, '-gravity', 'center', '-crop', `${size}x${size}+0+0`, '+repage', out]);
        return out;
    }
    const safeSrc = String(srcPath).replace(/'/g, "''");
    const safeOut = out.replace(/'/g, "''");
    const ps = `
Add-Type -AssemblyName System.Drawing
$src = '${safeSrc}'
$out = '${safeOut}'
$img = [System.Drawing.Image]::FromFile($src)
$size = [Math]::Min($img.Width, $img.Height)
$x = [int](($img.Width - $size) / 2)
$y = [int](($img.Height - $size) / 2)
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($img, (New-Object System.Drawing.Rectangle 0,0,$size,$size), (New-Object System.Drawing.Rectangle $x,$y,$size,$size), [System.Drawing.GraphicsUnit]::Pixel)
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $img.Dispose()
`;
    await runPs(ps);
    return out;
}
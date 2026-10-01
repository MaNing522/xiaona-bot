// ============================================================
// screenshot.js - 本机屏幕截图 + 指定网址截图
// ============================================================
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const EDGE_CANDIDATES = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function run(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: timeoutMs || 60000, windowsHide: true }, (err, stdout, stderr) => {
            if (err) reject(err); else resolve(stdout);
        });
    });
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

// 用 Edge 无头模式给网址截图
export async function captureUrl(url, saveDir) {
    const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
    if (!edge) throw new Error('未找到 Edge，无法进行网址截图');
    const out = uniqueName(path.resolve(saveDir), '.png');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-edge-'));
    await run(edge, [
        '--headless', '--disable-gpu', '--no-first-run',
        '--disable-features=msEdgeFirstRunExperience',
        `--user-data-dir=${profile}`, '--window-size=1280,800',
        `--screenshot=${out}`, url,
    ]);
    return out;
}

// 居中裁剪为正方形（QQ 头像要求），输出 PNG；outPath 提供时写入该路径（用于缓存复用）
export async function cropSquare(srcPath, outDir, outPath = null) {
    const out = outPath || uniqueName(path.resolve(outDir), '.png');
    if (outPath && fs.existsSync(outPath)) return outPath;
    if (outPath) fs.mkdirSync(path.dirname(outPath), { recursive: true });
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
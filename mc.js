// ============================================================
// mc.js - Minecraft 服务器状态查询（mcsrvstat.us 公共API，无需Key）
// ============================================================

export async function queryServer(address) {
  const host = String(address || '').trim().replace(/^(mcs?:\/\/)/i, '');
  if (!host) return { error: '地址为空' };
  const url = `https://api.mcsrvstat.us/3/${encodeURIComponent(host)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return { error: `查询失败 HTTP ${res.status}` };
  const d = await res.json();
  if (!d.online) return { online: false, host };

  const motd = Array.isArray(d.motd?.clean) ? d.motd.clean.join('\n').trim() : '';
  const proto = d.protocol && typeof d.protocol === 'object'
    ? (d.protocol.version ?? d.protocol.versionId ?? '')
    : d.protocol;
  return {
    online: true,
    host,
    version: d.version || '未知',
    protocol: proto,
    playersOnline: d.players?.online ?? 0,
    playersMax: d.players?.max ?? 0,
    motd,
    sample: Array.isArray(d.players?.list) ? d.players.list.slice(0, 10) : [],
  };
}

export function formatServer(r) {
  if (r.error) return '❌ ' + r.error;
  if (!r.online) return `🔴 ${r.host} 当前离线，或地址/端口不正确。`;
  const lines = [
    `🟢 ${r.host} 在线`,
    `版本: ${r.version}${r.protocol ? `（协议 ${r.protocol}）` : ''}`,
    `玩家: ${r.playersOnline}/${r.playersMax}`,
  ];
  if (r.motd) lines.push(`MOTD:\n${r.motd}`);
  if (r.sample && r.sample.length) lines.push(`在线玩家: ${r.sample.join('、')}`);
  return lines.join('\n');
}
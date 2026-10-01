package com.xiaona;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 桥的请求签名校验。
 *
 * 设计要点：**密钥永不上网**。客户端发的是
 *     X-Xiaona-Ts / X-Xiaona-Nonce / X-Xiaona-Sig
 * 其中 Sig = HMAC-SHA256(secret, ts + "\n" + nonce + "\n" + body)，body 在 GET 时为空串。
 * 这样即使流量被被动嗅探，也拿不到 secret；时间戳容差 + nonce 去重则挡住重放。
 */
public class BridgeAuth {
    /** secret 最短长度，太短容易被爆破 */
    public static final int MIN_SECRET_LEN = 32;
    private static final int NONCE_CACHE_MAX = 4096;

    private final Config.Bridge cfg;
    /** nonce → 首次出现的时间（秒）；按插入顺序，便于从最旧开始淘汰 */
    private final Map<String, Long> seenNonces = new LinkedHashMap<>();

    public BridgeAuth(Config.Bridge cfg) {
        this.cfg = cfg;
    }

    /** secret 是否合格（不合格时桥必须拒绝启动，不能放行） */
    public boolean secretValid() {
        return cfg != null && cfg.secret != null && cfg.secret.trim().length() >= MIN_SECRET_LEN;
    }

    /**
     * 校验一次请求。
     * @return null = 通过；否则返回失败原因（可直接回给客户端）
     */
    public String verify(String ip, String ts, String nonce, String sig, String body) {
        if (cfg == null) return "桥未启用";

        if (cfg.allowFrom != null && !cfg.allowFrom.isEmpty() && !allowedIp(ip)) {
            return "来源 IP 不在白名单";
        }

        long t;
        try {
            t = Long.parseLong(ts == null ? "" : ts.trim());
        } catch (Exception e) {
            return "时间戳缺失或格式错误";
        }
        long now = System.currentTimeMillis() / 1000L;
        int window = Math.max(30, cfg.timestampWindowSec);
        if (Math.abs(now - t) > window) return "时间戳超出容差（请检查本机时钟）";

        if (nonce == null || nonce.trim().length() < 8) return "nonce 缺失或过短";
        if (sig == null || sig.isBlank()) return "签名缺失";

        String expect = hmac(ts.trim() + "\n" + nonce.trim() + "\n" + (body == null ? "" : body));
        if (!MessageDigest.isEqual(expect.getBytes(StandardCharsets.UTF_8),
                                  sig.trim().toLowerCase().getBytes(StandardCharsets.UTF_8))) {
            return "签名不匹配";
        }

        synchronized (seenNonces) {
            if (seenNonces.containsKey(nonce.trim())) return "nonce 已被使用（疑似重放）";
            seenNonces.put(nonce.trim(), now);

            long cutoff = now - window * 2L;
            seenNonces.entrySet().removeIf(e -> e.getValue() < cutoff);
            if (seenNonces.size() > NONCE_CACHE_MAX) {
                Iterator<Map.Entry<String, Long>> it = seenNonces.entrySet().iterator();
                while (it.hasNext() && seenNonces.size() > NONCE_CACHE_MAX) {
                    it.next();
                    it.remove();
                }
            }
        }
        return null;
    }

    private boolean allowedIp(String ip) {
        if (ip == null) return false;
        for (String a : cfg.allowFrom) {
            if (a == null) continue;
            String v = a.trim();
            if (v.isEmpty()) continue;
            if (v.equals(ip)) return true;
            // 允许 "1.2.3." 这样的前缀写法，便于按网段放行
            if (v.endsWith(".") && ip.startsWith(v)) return true;
            if ("127.0.0.1".equals(ip) || "::1".equals(ip) || "0:0:0:0:0:0:0:1".equals(ip)) {
                if ("localhost".equalsIgnoreCase(v)) return true;
            }
        }
        return false;
    }

    private String hmac(String data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(cfg.secret.trim().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] out = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(out.length * 2);
            for (byte b : out) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
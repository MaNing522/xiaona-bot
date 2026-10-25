package com.xiaona;

import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.ModContainer;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Plan 是否可用。
 *
 * <p>规则按用户要求：**没装 Plan 就禁用玩家数据查询**，装了保持现状。
 * 检测两道保险：
 * <ol>
 *   <li>FabricLoader 里找 mod id / 名称（Plan 的 Fabric 版；不硬编码单一 id）；</li>
 *   <li>没找到时探活 {@code {url}/v1/server}：200/401/403 都算面板在线（Plan 可能要求登录）。</li>
 * </ol>
 * 结果缓存 60 秒，避免网页轮询 /bridge/status 时反复请求 Plan。
 */
final class PlanAvailability {
    private static final long CACHE_MS = 60_000L;
    private static final int PROBE_TIMEOUT_MS = 1500;

    private final Config.Plan cfg;
    private final boolean modLoaded;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(2))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private long checkedAt = 0;
    private boolean cachedAvailable = false;
    private String cachedReason = "";

    PlanAvailability(Config.Plan cfg, boolean modLoaded) {
        this.cfg = cfg == null ? new Config.Plan() : cfg;
        this.modLoaded = modLoaded;
    }

    static PlanAvailability create(Config.Plan cfg) {
        return new PlanAvailability(cfg, detectModLoaded());
    }

    /** Plan 的 Fabric 版 mod id 可能变化，按 id + 名称宽容匹配；测试环境没有 FabricLoader → false */
    static boolean detectModLoaded() {
        try {
            for (ModContainer m : FabricLoader.getInstance().getAllMods()) {
                String id = m.getMetadata().getId().toLowerCase(Locale.ROOT);
                String name = m.getMetadata().getName().toLowerCase(Locale.ROOT);
                if (id.equals("plan") || id.equals("planfabric") || name.contains("player analytics")) {
                    return true;
                }
            }
        } catch (Throwable ignore) {
            // 单测 / 非 Fabric 环境
        }
        return false;
    }

    boolean modLoaded() {
        return modLoaded;
    }

    synchronized boolean available() {
        if (!cfg.enabled) {
            return false;
        }
        if (modLoaded) {
            return true;
        }
        long now = System.currentTimeMillis();
        if (checkedAt > 0 && now - checkedAt < CACHE_MS) {
            return cachedAvailable;
        }
        probe();
        checkedAt = System.currentTimeMillis();
        return cachedAvailable;
    }

    synchronized Map<String, Object> status() {
        boolean ok = available();
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("available", ok);
        m.put("modLoaded", modLoaded);
        m.put("reason", cfg.enabled ? reason() : "plan.enabled=false");
        return m;
    }

    private String reason() {
        if (modLoaded) return "已安装 Plan";
        if (!cfg.enabled) return "plan.enabled=false";
        return cachedReason.isBlank() ? "未检测到 Plan" : cachedReason;
    }

    private void probe() {
        if (!cfg.enabled) {
            cachedAvailable = false;
            cachedReason = "plan.enabled=false";
            return;
        }
        String base = cfg.url == null ? "" : cfg.url.trim().replaceAll("/+$", "");
        if (base.isEmpty()) {
            cachedAvailable = false;
            cachedReason = "未配置 plan.url";
            return;
        }
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + "/v1/server"))
                    .timeout(Duration.ofMillis(PROBE_TIMEOUT_MS))
                    .header("Accept", "application/json")
                    .header("Accept-Encoding", "identity")
                    .GET();
            if (cfg.user != null && !cfg.user.isBlank()) {
                String token = Base64.getEncoder().encodeToString(
                        (cfg.user + ":" + (cfg.password == null ? "" : cfg.password)).getBytes(StandardCharsets.UTF_8));
                b.header("Authorization", "Basic " + token);
            }
            HttpResponse<Void> r = http.send(b.build(), HttpResponse.BodyHandlers.discarding());
            int code = r.statusCode();
            // 只要 HTTP 有响应就说明"这个地址上有服务在跑"：200 正常、401/403 要登录、
            // 404 可能是旧版 Plan 没有 /v1/server。真正的取数错误交给 /v1/player 去报，
            // 这里只负责回答"装没装/连不连得上"，不能因为探测路径不对就误禁功能。
            cachedAvailable = true;
            cachedReason = "Plan 面板在线（HTTP " + code + "）";
        } catch (Exception e) {
            cachedAvailable = false;
            cachedReason = "连不上 Plan 面板 " + base + "：" + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
    }
}

package com.xiaona;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 桥的 HTTP 宿主。经 {@link PortMux} 与 Minecraft 共用同一个对外端口。
 *
 * 接口（全部要求签名头，见 {@link BridgeAuth}）：
 *   GET  /bridge/stream   SSE 事件流（公聊 / /xn 私聊 / 进出服 / 死亡 / 成就）
 *   POST /bridge/send     把文本注入游戏（全服广播 / 单个玩家 / 一批玩家）
 *   GET  /bridge/players  在线玩家 + 是否 OP
 *   POST /bridge/player   取 Plan 面板里某个玩家的数据（靠本机去取，面板端口不对外开放）
 *   POST /bridge/bindcheck 本机回"某个玩家是否已绑定"（决定这名玩家显不显示计分板）
 *   POST /bridge/whitelist 本机推"谁绑定了游戏ID"（白名单模式：单人变更 / 整张名单）
 *   POST /bridge/whitelist_response 本机回答"某玩家在不在绑定名单里"（白名单模式进服时的实时询问）
 *   GET  /bridge/status   版本、玩家数、开关状态
 *
 * 注意：这里**不提供**任意服务器命令执行接口 —— 桥只能往聊天里发文本。
 */
public class BridgeServer {
    /**
     * 心跳间隔。它同时决定了"客户端断线多久才被发现"——HttpExchange 无法主动感知对端断开，
     * 只能靠下一次写入失败来判断，所以这里取 10 秒（既满足 NAT 保活，又不会让失效连接长期占用名额）。
     */
    private static final long HEARTBEAT_MS = 10_000L;
    private static final int MAX_BODY = 64 * 1024;
    private static final int MAX_TEXT = 2000;
    /** 一次投递的最大目标数，防止有人塞一个超大数组把主线程卡住 */
    private static final int MAX_TARGETS = 64;
    /** Plan 面板原始返回的长度上限（裁过之后才交给本机，这里只防极端情况） */
    private static final int MAX_PLAN_BODY = 8 * 1024 * 1024;
    /**
     * 这些键夹着成串的分布/时序数据，是体积大头：一个玩了很久的玩家实测能到 550KB+，
     * 而显示只用到 info 里的标量。传回本机纯属浪费带宽和内存，直接裁掉。
     */
    private static final java.util.List<String> PLAN_HEAVY_KEYS = java.util.List.of(
            "gm_series", "world_series", "world_pie_series", "server_pie_series", "server_pie_colors",
            "ping_graph", "calendar_series", "punchcard_series", "player_deaths", "player_kills",
            "extensions", "connections");
    /** 会话只留最近这么多条（另附总数），够看"最近在玩什么" */
    private static final int PLAN_MAX_SESSIONS = 5;
    private static final Gson GSON = new Gson();
    /** 调 Plan 面板用的 HTTP 客户端（复用连接；Plan 就在本机，开销很小） */
    private static final HttpClient PLAN_HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(3))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();
    /** Plan config.yml 里的服务器名（就一行 ServerName: xxx） */
    private static final java.util.regex.Pattern PLAN_SERVER_NAME =
            java.util.regex.Pattern.compile("^\\s*ServerName:\\s*(.+?)\\s*$");

    private final Config.Bridge bcfg;
    private final Config.Plan pcfg;
    private final McEvents events;
    private final RuntimeToggles toggles;
    private final BridgeAuth auth;
    /** 未绑定玩家的侧边栏计分板；绑定判定由本机逐个玩家告知（白名单模式下为 null） */
    private final BindBoard board;
    /** 白名单模式的判定闸门：接收本机推来的绑定名单 */
    private final WhitelistGate whitelistGate;

    private volatile HttpServer server;
    private volatile int sharePort = 0;      // 复用端口（0 = 未启用复用）
    private final AtomicInteger windowCount = new AtomicInteger();
    private volatile long windowStart = System.currentTimeMillis();

    public BridgeServer(Config cfg, McEvents events, RuntimeToggles toggles, BindBoard board,
                        WhitelistGate whitelistGate) {
        this.bcfg = cfg.bridge;
        this.pcfg = cfg.plan == null ? new Config.Plan() : cfg.plan;
        this.events = events;
        this.toggles = toggles;
        this.board = board;
        this.whitelistGate = whitelistGate;
        this.auth = new BridgeAuth(cfg.bridge);
    }

    public boolean isRunning() { return server != null; }

    public int boundPort() {
        HttpServer s = server;
        return s == null ? 0 : s.getAddress().getPort();
    }

    public void setSharePort(int p) { this.sharePort = p; }

    /**
     * 启动桥监听。
     * @param host 监听地址：端口复用模式下传 127.0.0.1（仅本机），否则用配置里的对外地址
     * @param port 监听端口：0 = 随机；被占用会自动退到随机端口
     * @return 是否成功（失败原因已写入日志）
     */
    public boolean start(String host, int port) {
        if (server != null) return true;

        if (bcfg == null || !bcfg.enabled) {
            BotState.log("桥已关闭（config.json 的 bridge.enabled=false），未启动监听。");
            return false;
        }
        // fail-closed：密钥不合格绝不启动，不能像旧的网页面板那样在空密码时放行
        if (!auth.secretValid()) {
            BotState.error("桥未启动：bridge.secret 未配置或短于 " + BridgeAuth.MIN_SECRET_LEN + " 个字符。");
            BotState.log("👉 生成一个 48 位随机密钥，例如：");
            BotState.log("   pwsh -c \"-join((48..57)+(65..90)+(97..122)|Get-Random -Count 48)\"");
            BotState.log("👉 把同一串填进 config.json 的 bridge.secret 和本机 .env 的 MC_BRIDGE_SECRET。");
            return false;
        }
        // 小包延迟（ServerConfig 在类初始化时静态读取，必须赶在 HttpServer 创建前设置）
        try { System.setProperty("sun.net.httpserver.nodelay", "true"); } catch (Exception ignored) {}

        String h = host == null || host.isBlank() ? "0.0.0.0" : host.trim();
        int p = Math.max(port, 0);
        HttpServer hs;
        try {
            hs = HttpServer.create(new InetSocketAddress(h, p), 0);
        } catch (IOException e) {
            BotState.error("桥监听 " + h + ":" + p + " 失败（" + e.getMessage() + "），改用随机端口。");
            try {
                hs = HttpServer.create(new InetSocketAddress(h, 0), 0);
            } catch (IOException e2) {
                BotState.error("桥启动失败：" + e2.getMessage());
                return false;
            }
        }

        hs.createContext("/bridge/stream", ex -> route(ex, this::handleStream));
        hs.createContext("/bridge/send", ex -> route(ex, this::handleSend));
        hs.createContext("/bridge/players", ex -> route(ex, this::handlePlayers));
        hs.createContext("/bridge/player", ex -> route(ex, this::handlePlanPlayer));
        hs.createContext("/bridge/bindcheck", ex -> route(ex, this::handleBindCheck));
        hs.createContext("/bridge/whitelist", ex -> route(ex, this::handleWhitelist));
        hs.createContext("/bridge/whitelist_response", ex -> route(ex, this::handleWhitelistResponse));
        hs.createContext("/bridge/status", ex -> route(ex, this::handleStatus));
        hs.createContext("/", ex -> route(ex, this::handleNotFound));
        hs.setExecutor(new ThreadPoolExecutor(4, 32, 60L, TimeUnit.SECONDS, new SynchronousQueue<>(),
                r -> {
                    Thread t = new Thread(r, "xiaona-bridge");
                    t.setDaemon(true);
                    return t;
                }));
        hs.start();
        this.server = hs;

        if (isLoopback(h)) {
            BotState.log("🌉 桥已就绪（仅本机 127.0.0.1:" + hs.getAddress().getPort() + "），对外入口见端口复用");
        } else {
            BotState.log("🌉 桥已就绪: http://服务器IP:" + hs.getAddress().getPort());
        }
        return true;
    }

    public void stop() {
        HttpServer s = server;
        server = null;
        if (s != null) s.stop(0);
    }

    // ---------- 路由 ----------
    private interface Handler { void handle(HttpExchange ex, String body) throws IOException; }

    private void route(HttpExchange ex, Handler h) {
        try {
            String ip = clientIp(ex);
            String body = readBody(ex);
            String err = auth.verify(ip, header(ex, "X-Xiaona-Ts"), header(ex, "X-Xiaona-Nonce"),
                    header(ex, "X-Xiaona-Sig"), body);
            if (err != null) {
                BotState.error("[桥] 拒绝来自 " + ip + " 的 " + ex.getRequestURI().getPath() + "：" + err);
                sendJson(ex, 401, Map.of("ok", false, "error", err));
                return;
            }
            h.handle(ex, body);
        } catch (Exception e) {
            try { sendJson(ex, 500, Map.of("ok", false, "error", String.valueOf(e.getMessage()))); } catch (Exception ignored) {}
        } finally {
            try { ex.close(); } catch (Exception ignored) {}
        }
    }

    private void handleNotFound(HttpExchange ex, String body) throws IOException {
        sendJson(ex, 404, Map.of("ok", false, "error", "unknown endpoint"));
    }

    private void handleStatus(HttpExchange ex, String body) throws IOException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        m.put("version", modVersion());
        m.put("players", events.playerCount());
        m.put("streamClients", events.streamClients());
        m.put("lastSeq", events.lastSeq());
        m.put("enabled", toggles.enabled);
        m.put("chatToBridge", toggles.chatToBridge);
        m.put("bridgeToChat", toggles.bridgeToChat);
        m.put("privateCommand", bcfg.privateCommand);
        m.put("chatPrefix", bcfg.chatPrefix);
        if (sharePort > 0) m.put("sharePort", sharePort);
        m.put("localPort", boundPort());
        sendJson(ex, 200, m);
    }

    private void handlePlayers(HttpExchange ex, String body) throws IOException {
        List<Map<String, Object>> list = new ArrayList<>();
        for (String[] p : events.players()) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("name", p[0]);
            o.put("op", Boolean.parseBoolean(p[1]));
            list.add(o);
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        m.put("players", list);
        sendJson(ex, 200, m);
    }

    /**
     * 本机对"某个玩家是否已绑定"的判定：{@code {"player":"Steve","bound":false,"group":"12345678"}}。
     * 玩家上线时逐人问一次，服务端只为这名玩家渲染计分板 —— 不需要整张绑定表。
     */
    private void handleBindCheck(HttpExchange ex, String body) throws IOException {
        JsonObject o;
        try {
            o = JsonParser.parseString(body == null || body.isBlank() ? "{}" : body).getAsJsonObject();
        } catch (Exception e) {
            sendJson(ex, 400, Map.of("ok", false, "error", "请求体不是合法 JSON"));
            return;
        }
        String player = opt(o, "player").trim();
        if (player.isBlank()) {
            sendJson(ex, 400, Map.of("ok", false, "error", "player 不能为空"));
            return;
        }
        boolean bound = o.has("bound") && !o.get("bound").isJsonNull() && o.get("bound").getAsBoolean();
        String group = opt(o, "group").trim();
        if (board != null) board.checkBound(player, bound, group);

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        m.put("player", player);
        m.put("bound", bound);
        sendJson(ex, 200, m);
    }

    /**
     * 本机推来"谁绑定了游戏ID"，供白名单模式使用。两种形态：
     *   {"player":"Steve","bound":true}   单个玩家的绑定状态变化（绑定/解绑时推）
     *   {"players":["Steve","Alex"]}      整张绑定名单（本机连接上桥时推，全量替换）
     *
     * 白名单模式没开时也照收（只更新缓存，不判定、不动白名单），这样开关切换后立刻就有数据。
     */
    private void handleWhitelist(HttpExchange ex, String body) throws IOException {
        JsonObject o;
        try {
            o = JsonParser.parseString(body == null || body.isBlank() ? "{}" : body).getAsJsonObject();
        } catch (Exception e) {
            sendJson(ex, 400, Map.of("ok", false, "error", "请求体不是合法 JSON"));
            return;
        }
        if (whitelistGate == null) {
            sendJson(ex, 503, Map.of("ok", false, "error", "白名单闸门未就绪"));
            return;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        if (o.has("players") && o.get("players").isJsonArray()) {
            List<String> names = strList(o, "players", 1000);
            whitelistGate.setAll(names);
            m.put("ok", true);
            m.put("players", names.size());
        } else {
            String player = opt(o, "player").trim();
            if (player.isBlank()) {
                sendJson(ex, 400, Map.of("ok", false, "error", "需要 player，或 players 数组"));
                return;
            }
            boolean bound = o.has("bound") && !o.get("bound").isJsonNull() && o.get("bound").getAsBoolean();
            whitelistGate.setBound(player, bound);
            m.put("ok", true);
            m.put("player", player);
            m.put("bound", bound);
        }
        m.put("mode", whitelistGate.enabled());
        m.put("count", whitelistGate.size());
        sendJson(ex, 200, m);
    }

    /**
     * 白名单模式：本机对"这名玩家在不在绑定名单里"的回答。
     * 服务端在玩家进服时顺着 SSE 推 {@code whitelist_query} 询问，本机查完绑定表回这里。
     * 参数：{@code {id, player, bound}}（{@code id} 是询问里带回的请求 id）。
     */
    private void handleWhitelistResponse(HttpExchange ex, String body) throws IOException {
        if (whitelistGate == null) {
            sendJson(ex, 503, Map.of("ok", false, "error", "白名单闸门未就绪"));
            return;
        }
        JsonObject o;
        try {
            o = JsonParser.parseString(body == null || body.isBlank() ? "{}" : body).getAsJsonObject();
        } catch (Exception e) {
            sendJson(ex, 400, Map.of("ok", false, "error", "请求体不是合法 JSON"));
            return;
        }
        String player = opt(o, "player").trim();
        boolean bound = o.has("bound") && !o.get("bound").isJsonNull() && o.get("bound").getAsBoolean();
        whitelistGate.answer(opt(o, "id").trim(), player, bound);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        m.put("player", player);
        m.put("bound", bound);
        sendJson(ex, 200, m);
    }

    private void handleSend(HttpExchange ex, String body) throws IOException {
        if (!toggles.enabled) { sendJson(ex, 403, Map.of("ok", false, "error", "整机已关闭")); return; }
        if (!toggles.bridgeToChat) { sendJson(ex, 403, Map.of("ok", false, "error", "本机→游戏 已关闭")); return; }

        JsonObject o;
        try {
            o = JsonParser.parseString(body == null || body.isBlank() ? "{}" : body).getAsJsonObject();
        } catch (Exception e) {
            sendJson(ex, 400, Map.of("ok", false, "error", "请求体不是合法 JSON")); return;
        }
        String text = opt(o, "text");
        if (text.isBlank()) { sendJson(ex, 400, Map.of("ok", false, "error", "text 不能为空")); return; }
        if (text.length() > MAX_TEXT) text = text.substring(0, MAX_TEXT);

        String prefix = opt(o, "prefix");
        String full = prefix + text;

        if (!allowRate()) {
            sendJson(ex, 429, Map.of("ok", false, "error", "超过每分钟注入上限")); return;
        }

        String target = opt(o, "target");
        Map<String, Object> m = new LinkedHashMap<>();
        if ("player".equalsIgnoreCase(target)) {
            String who = opt(o, "player");
            if (who.isBlank()) { sendJson(ex, 400, Map.of("ok", false, "error", "target=player 时必须给 player")); return; }
            boolean ok = events.sendToPlayer(who, full);
            m.put("ok", ok);
            m.put("to", who);
            if (!ok) m.put("error", "未找到该玩家或服务器未就绪");
        } else if ("players".equalsIgnoreCase(target)) {
            List<String> who = strList(o, "players", MAX_TARGETS);
            if (who.isEmpty()) { sendJson(ex, 400, Map.of("ok", false, "error", "target=players 时必须给非空 players 数组")); return; }
            int delivered = events.sendToPlayers(who, full);
            m.put("ok", delivered > 0);
            m.put("to", who.size());
            m.put("delivered", delivered);
            if (delivered == 0) m.put("error", "名单里没有在线玩家，或服务器未就绪");
        } else if (target.isBlank() || "all".equalsIgnoreCase(target)) {
            boolean ok = events.broadcast(full);
            m.put("ok", ok);
            m.put("to", "all");
            if (!ok) m.put("error", "服务器未就绪");
        } else {
            // 未知 target 一律拒绝：否则会退化成广播，把本该私发给某人的内容发给全服
            sendJson(ex, 400, Map.of("ok", false, "error", "未知 target: " + target));
            return;
        }
        sendJson(ex, 200, m);
    }

    /**
     * 从 Plan 面板取某个玩家的数据。
     *
     * Plan 的面板端口（默认 8804）一般不对外开放 —— 服务商通常只放行 MC 那一个端口，
     * 所以只能由桥在服务器本机去取。玩家名走签名请求体（GET 的查询串不在签名范围内）。
     */
    private void handlePlanPlayer(HttpExchange ex, String body) throws IOException {
        if (pcfg == null || !pcfg.enabled) {
            sendJson(ex, 403, Map.of("ok", false, "error", "Plan 查询未启用（config.json 的 plan.enabled=false）"));
            return;
        }
        String name;
        try {
            JsonObject o = JsonParser.parseString(body == null || body.isBlank() ? "{}" : body).getAsJsonObject();
            name = opt(o, "name").trim();
        } catch (Exception e) {
            sendJson(ex, 400, Map.of("ok", false, "error", "请求体不是合法 JSON"));
            return;
        }
        if (!name.matches("[A-Za-z0-9_]{3,16}")) {
            sendJson(ex, 400, Map.of("ok", false, "error", "玩家名不合法（应为 3-16 位字母/数字/下划线）"));
            return;
        }

        String base = pcfg.url + "/v1/player?player=" + URLEncoder.encode(name, StandardCharsets.UTF_8);
        // Plan 单服模式下 server 参数可有可无，各版本还不一致：先按"带服务器名"试，
        // 400/404 再不带它试一次，省得让用户为了这个参数重启服务器。
        String srv = planServerName();
        List<String> urls = new ArrayList<>();
        if (!srv.isBlank()) {
            urls.add(base + "&server=" + URLEncoder.encode(srv, StandardCharsets.UTF_8));
            urls.add(base);
        } else {
            urls.add(base);
        }

        String lastErr = "";
        for (String url : urls) {
            int code;
            String t;
            PlanResp resp;
            try {
                resp = fetchPlan(url);
                code = resp.status;
                t = resp.text == null ? "" : resp.text;
            } catch (java.net.http.HttpTimeoutException e) {
                sendJson(ex, 200, Map.of("ok", false, "error",
                        "Plan 面板响应超时（" + pcfg.timeoutMs + "ms）：" + pcfg.url));
                return;
            } catch (Exception e) {
                String msg = String.valueOf(e.getMessage());
                String low = msg.toLowerCase(java.util.Locale.ROOT);
                // HttpClient 有时把"连接被拒"包在别的异常里，这里按消息兜一下，保证提示能定位
                boolean refused = e instanceof java.net.ConnectException
                        || low.contains("refused") || low.contains("failed to connect");
                sendJson(ex, 200, Map.of("ok", false, "error", refused
                        ? "连不上 Plan 面板 " + pcfg.url + "：Plan 没在跑？端口不对？或面板只监听了别的地址"
                        : "取 Plan 数据失败：" + e.getClass().getSimpleName() + " " + msg));
                return;
            }

            if (code == 401 || code == 403) {
                sendJson(ex, 200, Map.of("ok", false, "error", "Plan 面板要求登录（HTTP " + code + "）："
                        + "Plan 的登录需要 HTTPS，纯本机 HTTP 登不了；请在 Plan 里放开 API 访问，"
                        + "或在 config.json 填 plan.user / plan.password"));
                return;
            }
            if (code == 400 || code == 404) {
                // 多半是 server 参数这件事，留着换下一种写法再试
                lastErr = "Plan 返回 HTTP " + code + " " + head(t.trim(), 120);
                continue;
            }
            if (code != 200) {
                sendJson(ex, 200, Map.of("ok", false, "error",
                        "Plan 返回 HTTP " + code + " " + head(t.trim(), 120)));
                return;
            }
            if (t.isBlank()) {
                sendJson(ex, 200, Map.of("ok", false, "error", "Plan 返回了空内容"));
                return;
            }
            if (t.length() > MAX_PLAN_BODY) {
                sendJson(ex, 200, Map.of("ok", false, "error",
                        "Plan 返回内容过大（" + t.length() + " 字符），已放弃"));
                return;
            }

            JsonElement parsed;
            try {
                parsed = JsonParser.parseString(t);
            } catch (Exception e) {
                // 把响应头与头几个字节一起报出来：一眼能看出是被压缩了、还是压根不是 JSON 接口
                sendJson(ex, 200, Map.of("ok", false, "error",
                        "Plan 返回的不是 JSON。HTTP " + resp.status
                        + "，Content-Type=" + resp.contentType
                        + "，Content-Encoding=" + resp.contentEncoding
                        + "，开头字节 " + bytesPreview(resp.raw, 16)));
                return;
            }
            // Gson 是宽松模式：一段乱码也能被它解析成"字符串"，所以必须确认拿到的确实是玩家对象
            if (parsed.isJsonArray() && !parsed.getAsJsonArray().isEmpty()) {
                parsed = parsed.getAsJsonArray().get(0);
            }
            if (!parsed.isJsonObject()) {
                if (parsed.isJsonArray()) {
                    sendJson(ex, 200, Map.of("ok", false, "error",
                            "Plan 里没有玩家 " + name + "（可能从没进过服）"));
                } else {
                    sendJson(ex, 200, Map.of("ok", false, "error",
                            "Plan 返回的不是玩家数据（拿到的是" + jsonKind(parsed) + "）。HTTP " + resp.status
                            + "，Content-Type=" + resp.contentType
                            + "，开头字节 " + bytesPreview(resp.raw, 16)));
                }
                return;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            JsonObject slim = slimPlan(parsed.getAsJsonObject());
            int after = GSON.toJson(slim).length();
            m.put("ok", true);
            m.put("player", slim);
            if (after < t.length() - 64) {   // 明显变小了才说"裁过"，小数据本来就原样
                m.put("trimmed", true);
                m.put("rawSize", t.length());
                BotState.log("[Plan] " + name + " 的数据已裁剪：" + t.length() + " → " + after + " 字符");
            }
            sendJson(ex, 200, m);
            return;
        }
        sendJson(ex, 200, Map.of("ok", false, "error", lastErr.isBlank() ? "取 Plan 数据失败" : lastErr));
    }

    private static String head(String s, int n) {
        return s.length() <= n ? s : s.substring(0, n);
    }

    /** 报告"解析出来到底是什么"，便于判断对面返回的是什么东西 */
    static String jsonKind(JsonElement e) {
        if (e == null || e.isJsonNull()) return "null";
        if (e.isJsonArray()) return "数组";
        if (e.isJsonObject()) return "对象";
        if (e.getAsJsonPrimitive().isString()) return "字符串";
        if (e.getAsJsonPrimitive().isNumber()) return "数字";
        return "布尔值";
    }

    /**
     * 把 Plan 返回体里的大数组裁掉再带回本机。
     *
     * 只删这些已知的"分布/时序"键，其余字段**原样保留** —— 这样以后想多显示点什么，
     * 只要不用到被删的那几坨，bot 侧改就行，不用再换 jar。
     */
    static JsonObject slimPlan(JsonObject src) {
        JsonObject out = src.deepCopy();
        for (String k : PLAN_HEAVY_KEYS) out.remove(k);
        for (String arrKey : new String[]{"sessions", "servers"}) {
            JsonElement el = out.get(arrKey);
            if (el == null || !el.isJsonArray()) continue;
            com.google.gson.JsonArray items = el.getAsJsonArray();
            com.google.gson.JsonArray kept = new com.google.gson.JsonArray();
            int n = 0;
            for (JsonElement item : items) {
                if ("sessions".equals(arrKey) && n >= PLAN_MAX_SESSIONS) break;
                n++;
                if (!item.isJsonObject()) continue;
                JsonObject o = item.getAsJsonObject().deepCopy();
                for (String k : PLAN_HEAVY_KEYS) o.remove(k);
                kept.add(o);
            }
            out.add(arrKey, kept);
            if ("sessions".equals(arrKey)) out.addProperty("sessions_total", items.size());
        }
        return out;
    }

    /**
     * 按签名配置去 Plan 面板发一次 GET（带可选 Basic 认证）；响应体已尽力解压并解码。
     *
     * 注意 `Accept-Encoding: identity`：Plan 的面板会按需压缩响应体，而 HttpClient 的
     * ofString() **不会自动解压**，解出来就是一串乱码（"Plan 返回的不是 JSON" 就是这么来的）。
     * 明确不要压缩，再用魔数兜底解一次，两道保险。
     */
    private PlanResp fetchPlan(String url) throws Exception {
        HttpRequest.Builder rb = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofMillis(pcfg.timeoutMs))
                .header("Accept", "application/json")
                .header("Accept-Encoding", "identity")
                .GET();
        if (!pcfg.user.isBlank()) {
            String token = Base64.getEncoder().encodeToString(
                    (pcfg.user + ":" + pcfg.password).getBytes(StandardCharsets.UTF_8));
            rb.header("Authorization", "Basic " + token);
        }
        HttpResponse<byte[]> r = PLAN_HTTP.send(rb.build(), HttpResponse.BodyHandlers.ofByteArray());
        byte[] raw = r.body() == null ? new byte[0] : r.body();
        String enc = r.headers().firstValue("Content-Encoding").orElse("");
        byte[] body = decodeBody(raw, enc);
        return new PlanResp(r.statusCode(), new String(body, StandardCharsets.UTF_8),
                r.headers().firstValue("Content-Type").orElse(""), enc, raw);
    }

    /** 压缩体解码：按 Content-Encoding 判，再用 gzip 魔数兜底（有些反代不写这个头） */
    private static byte[] decodeBody(byte[] b, String enc) {
        String e = enc == null ? "" : enc.toLowerCase(java.util.Locale.ROOT).trim();
        boolean gz = e.contains("gzip") || (b.length > 2 && (b[0] & 0xFF) == 0x1F && (b[1] & 0xFF) == 0x8B);
        try {
            if (gz) {
                try (java.util.zip.GZIPInputStream in =
                             new java.util.zip.GZIPInputStream(new java.io.ByteArrayInputStream(b))) {
                    return in.readAllBytes();
                }
            }
            if (e.contains("deflate")) {
                try (java.util.zip.InflaterInputStream in =
                             new java.util.zip.InflaterInputStream(new java.io.ByteArrayInputStream(b))) {
                    return in.readAllBytes();
                }
            }
        } catch (Exception ignored) {
            // 解不开就当没压（后面报错时会带上原始字节，足以定位）
        }
        return b;
    }

    /** 「这到底返回了什么」：前 n 字节的十六进制 + 可打印预览 */
    static String bytesPreview(byte[] b, int n) {
        if (b == null || b.length == 0) return "len=0";
        int len = Math.min(n, b.length);
        StringBuilder hex = new StringBuilder();
        StringBuilder asc = new StringBuilder();
        for (int i = 0; i < len; i++) {
            hex.append(String.format("%02x ", b[i]));
            int c = b[i] & 0xFF;
            asc.append(c >= 32 && c < 127 ? (char) c : '.');
        }
        return "len=" + b.length + " hex=[" + hex.toString().trim() + "] ascii=[" + asc + "]";
    }

    /** 一次 Plan 请求的结果 */
    private static final class PlanResp {
        final int status;
        final String text;
        final String contentType;
        final String contentEncoding;
        final byte[] raw;

        PlanResp(int status, String text, String contentType, String contentEncoding, byte[] raw) {
            this.status = status;
            this.text = text;
            this.contentType = contentType;
            this.contentEncoding = contentEncoding;
            this.raw = raw;
        }
    }

    /**
     * Plan 的 ServerName：优先取配置，其次直接读 Plan 自己的 config.yml。
     * 面板地址和服务器名都在那个文件里，能自动认出来就别再让用户抄一遍。
     */
    private String planServerName() {
        if (pcfg.server != null && !pcfg.server.isBlank()) return pcfg.server.trim();
        try {
            java.nio.file.Path root = FabricLoader.getInstance().getGameDir();
            // Bukkit/混合端在 plugins/Plan 下，Fabric 原生在 config/plan 下
            for (String rel : new String[]{"plugins/Plan/config.yml", "config/plan/config.yml"}) {
                java.nio.file.Path f = root.resolve(rel);
                if (!java.nio.file.Files.isRegularFile(f)) continue;
                String s = serverNameFrom(String.join("\n", java.nio.file.Files.readAllLines(f, StandardCharsets.UTF_8)));
                if (!s.isBlank()) return s;
            }
        } catch (Exception ignored) {
            // 读不到（测试环境没有 FabricLoader、路径不同、没权限）就退化成"不带 server"
        }
        return "";
    }

    /** 从 Plan 的 config.yml 文本里抠出 ServerName（只认这一行，Plan 的配置很规整） */
    static String serverNameFrom(String yaml) {
        if (yaml == null) return "";
        for (String line : yaml.split("\r?\n")) {
            java.util.regex.Matcher m = PLAN_SERVER_NAME.matcher(line);
            if (m.find()) {
                String v = m.group(1).trim();
                if (v.length() >= 2 && (v.startsWith("\"") && v.endsWith("\"") || v.startsWith("'") && v.endsWith("'"))) {
                    v = v.substring(1, v.length() - 1).trim();
                }
                return v;
            }
        }
        return "";
    }

    /** SSE 事件流 */
    private void handleStream(HttpExchange ex, String body) throws IOException {
        long since = sinceOf(ex);
        if (!events.addStreamClient(bcfg.maxStreamClients)) {
            sendJson(ex, 503, Map.of("ok", false, "error", "事件流连接数已达上限 "
                    + bcfg.maxStreamClients + "，请检查是否有多个客户端在连"));
            return;
        }
        ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.getResponseHeaders().set("X-Accel-Buffering", "no");
        ex.sendResponseHeaders(200, 0); // 0 = chunked，便于逐条推送

        boolean announced = false;
        try (OutputStream os = ex.getResponseBody()) {
            os.write(("retry: 3000\n\n").getBytes(StandardCharsets.UTF_8));
            Map<String, Object> hello = new LinkedHashMap<>();
            hello.put("ok", true);
            hello.put("lastSeq", events.lastSeq());
            hello.put("chatPrefix", bcfg.chatPrefix);
            hello.put("privateCommand", bcfg.privateCommand);
            writeSse(os, -1, "hello", GSON.toJson(hello));
            os.flush();
            announced = true;

            long last = since;
            while (server != null) {
                McEvents.Batch b = events.await(last, HEARTBEAT_MS);
                if (b.gap) {
                    writeSse(os, -1, "gap", "{\"gap\":true}");
                }
                for (McEvents.Event e : b.events) {
                    writeSse(os, e.seq, e.type, GSON.toJson(eventJson(e)));
                    last = e.seq;
                }
                if (b.events.isEmpty() && !b.gap) {
                    os.write(": hb\n\n".getBytes(StandardCharsets.UTF_8));
                }
                os.flush();
            }
        } catch (Exception e) {
            // 客户端断开是常态，不当作错误
        } finally {
            events.removeStreamClient();
            if (announced) BotState.log("🔌 事件流已断开");
        }
    }

    private static Map<String, Object> eventJson(McEvents.Event e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("seq", e.seq);
        m.put("type", e.type);
        m.put("player", e.player);
        m.put("text", e.text);
        m.put("time", e.time);
        m.put("op", e.op);
        // 进服事件才有：真实客户端 IP（端口复用下 MC 侧只看到 127.0.0.1，这里给还原出来的）
        if (e.ip != null && !e.ip.isEmpty()) m.put("ip", e.ip);
        return m;
    }

    private void writeSse(OutputStream os, long id, String type, String json) throws IOException {
        StringBuilder sb = new StringBuilder();
        if (id >= 0) sb.append("id: ").append(id).append('\n');
        sb.append("event: ").append(type).append('\n');
        sb.append("data: ").append(json).append('\n');
        sb.append('\n');
        os.write(sb.toString().getBytes(StandardCharsets.UTF_8));
    }

    // ---------- 工具 ----------
    private long sinceOf(HttpExchange ex) {
        String lei = header(ex, "Last-Event-ID");
        String q = null;
        String query = ex.getRequestURI().getRawQuery();
        if (query != null) {
            for (String kv : query.split("&")) {
                int i = kv.indexOf('=');
                if (i > 0 && "since".equals(kv.substring(0, i))) q = kv.substring(i + 1);
            }
        }
        long cur = events.lastSeq();
        String v = (q != null && !q.isBlank()) ? q : lei;
        if (v != null && !v.isBlank()) {
            try {
                long n = Long.parseLong(v.trim());
                // 客户端的光标可能来自"上一次服务器运行"——McEvents 的序号是进程内的，
                // 服务器一重启就从 1 重新开始，而客户端还记着上一轮的序号（可能上万）。
                // 若原样采信，await() 永远等不到 e.seq > since：SSE 连着、心跳正常、事件一条都不来。
                // 这只能是"服务端重启过"，按新连接处理，从当前末尾续推。
                if (n > cur) {
                    BotState.log("[桥] 客户端事件序号 " + n + " 大于服务端当前 " + cur
                            + "（服务端重启过），已从当前位置重新对齐。");
                    return cur;
                }
                return n;
            } catch (Exception ignored) {}
        }
        // 新连接默认只推新事件，不补发历史
        return cur;
    }

    private static String header(HttpExchange ex, String name) {
        return ex.getRequestHeaders().getFirst(name);
    }

    private static String opt(JsonObject o, String key) {
        try {
            if (o.has(key) && !o.get(key).isJsonNull()) {
                String v = o.get(key).getAsString();
                return v == null ? "" : v;
            }
        } catch (Exception ignored) {}
        return "";
    }

    /** 读 JSON 里的字符串数组（去空、去重、截断） */
    private static List<String> strList(JsonObject o, String key, int max) {
        List<String> out = new ArrayList<>();
        try {
            if (!o.has(key) || o.get(key).isJsonNull() || !o.get(key).isJsonArray()) return out;
            for (com.google.gson.JsonElement el : o.getAsJsonArray(key)) {
                if (out.size() >= max) break;
                if (el == null || el.isJsonNull()) continue;
                String v = el.getAsString();
                if (v == null) continue;
                v = v.trim();
                if (v.isEmpty() || out.contains(v)) continue;
                out.add(v);
            }
        } catch (Exception ignored) {}
        return out;
    }

    private boolean allowRate() {
        int limit = bcfg.rateLimitPerMinute;
        if (limit <= 0) return true;
        long now = System.currentTimeMillis();
        if (now - windowStart >= 60_000L) {
            windowStart = now;
            windowCount.set(0);
        }
        return windowCount.incrementAndGet() <= limit;
    }

    private static String readBody(HttpExchange ex) {
        try (InputStream in = ex.getRequestBody()) {
            byte[] buf = in.readNBytes(MAX_BODY);
            return new String(buf, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private static void sendJson(HttpExchange ex, int code, Object obj) throws IOException {
        byte[] data = GSON.toJson(obj).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.sendResponseHeaders(code, data.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(data);
        }
    }

    /**
     * 真实客户端 IP。端口复用下所有请求都来自 127.0.0.1，此时采信客户端声明的
     * X-Xiaona-From —— 该请求已通过 HMAC 认证，伪造它需要先拿到密钥。
     */
    private static String clientIp(HttpExchange ex) {
        String peer = "unknown";
        try {
            SocketAddress sa = ex.getRemoteAddress();
            if (sa instanceof InetSocketAddress isa && isa.getAddress() != null) {
                peer = isa.getAddress().getHostAddress();
            }
        } catch (Exception ignored) {}
        if (isLoopback(peer)) {
            String fwd = ex.getRequestHeaders().getFirst("X-Xiaona-From");
            if (fwd != null && !fwd.isBlank()) return fwd.trim();
        }
        return peer;
    }

    private static boolean isLoopback(String h) {
        return "127.0.0.1".equals(h) || "localhost".equals(h)
                || "::1".equals(h) || "0:0:0:0:0:0:0:1".equals(h);
    }

    private static String modVersion() {
        try {
            return FabricLoader.getInstance().getModContainer("xiaona")
                    .map(c -> c.getMetadata().getVersion().getFriendlyString()).orElse("?");
        } catch (Exception e) {
            return "?";
        }
    }
}
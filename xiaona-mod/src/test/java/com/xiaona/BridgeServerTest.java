package com.xiaona;

import org.junit.jupiter.api.Test;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 桥的真实 HTTP 行为：签名校验、SSE 事件推送、连接数上限。
 * 不需要 MinecraftServer —— 事件队列与 HTTP 层都是纯 Java，可独立验证。
 */
public class BridgeServerTest {
    private static final String SECRET = "0123456789abcdef0123456789abcdef";

    private static Config newConfig() {
        Config c = new Config();
        c.bridge.secret = SECRET;
        c.bridge.queueSize = 32;
        c.bridge.maxStreamClients = 2;
        c.http.sharePort = 0;
        return c;
    }

    private static String signature(String ts, String nonce, String body) throws Exception {
        String b = body == null ? "" : body;   // GET 时 body 为空串，不能拼成 "null"
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        byte[] out = mac.doFinal((ts + "\n" + nonce + "\n" + b).getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder(out.length * 2);
        for (byte b1 : out) sb.append(String.format("%02x", b1));
        return sb.toString();
    }

    private static String ts() { return String.valueOf(System.currentTimeMillis() / 1000L); }

    private static int statusOf(int port, String path, String ts, String nonce, String body) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) URI.create("http://127.0.0.1:" + port + path).toURL().openConnection();
        conn.setConnectTimeout(3000);
        conn.setReadTimeout(5000);
        if (ts != null) {
            conn.setRequestProperty("X-Xiaona-Ts", ts);
            conn.setRequestProperty("X-Xiaona-Nonce", nonce);
            conn.setRequestProperty("X-Xiaona-Sig", signature(ts, nonce, body));
        }
        if (body != null) {
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        return conn.getResponseCode();
    }

    /** 带签名 POST 一个 JSON，返回 [状态码, 响应体] */
    private static String[] postJson(int port, String path, String body) throws Exception {
        String t = ts(), n = UUID.randomUUID().toString().replace("-", "");
        HttpURLConnection conn = (HttpURLConnection) URI.create("http://127.0.0.1:" + port + path).toURL().openConnection();
        conn.setConnectTimeout(3000);
        conn.setReadTimeout(10000);
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("X-Xiaona-Ts", t);
        conn.setRequestProperty("X-Xiaona-Nonce", n);
        conn.setRequestProperty("X-Xiaona-Sig", signature(t, n, body));
        try (OutputStream os = conn.getOutputStream()) {
            os.write(body.getBytes(StandardCharsets.UTF_8));
        }
        int code = conn.getResponseCode();
        String resp;
        try (var in = code >= 400 ? conn.getErrorStream() : conn.getInputStream()) {
            resp = in == null ? "" : new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        return new String[]{String.valueOf(code), resp};
    }

    /** 打开一条 SSE 连接并返回已读到的内容（读到 mustContain 或超时） */
    private static String readStream(int port, long millis, String mustContain) throws Exception {
        return readStream(port, millis, mustContain, null);
    }

    /**
     * 同上，但可带上 Last-Event-ID（模拟客户端断线重连时按旧光标续读）。
     * @param lastEventId null = 不带该头
     */
    private static String readStream(int port, long millis, String mustContain, Long lastEventId) throws Exception {
        String t = ts(), n = UUID.randomUUID().toString().replace("-", "");
        Socket sock = new Socket("127.0.0.1", port);
        sock.setSoTimeout(10_000);
        String req = "GET /bridge/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                + "X-Xiaona-Ts: " + t + "\r\n"
                + "X-Xiaona-Nonce: " + n + "\r\n"
                + "X-Xiaona-Sig: " + signature(t, n, "") + "\r\n"
                + (lastEventId == null ? "" : "Last-Event-ID: " + lastEventId + "\r\n")
                + "\r\n";
        sock.getOutputStream().write(req.getBytes(StandardCharsets.UTF_8));
        sock.getOutputStream().flush();

        StringBuilder all = new StringBuilder();
        long deadline = System.currentTimeMillis() + millis;
        try (BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8))) {
            while (System.currentTimeMillis() < deadline) {
                String line = in.readLine();
                if (line == null) break;
                all.append(line).append('\n');
                if (mustContain != null && all.indexOf(mustContain) >= 0) break;
            }
        } catch (Exception ignored) {
            // 读超时视为结束
        } finally {
            try { sock.close(); } catch (Exception ignored) {}
        }
        return all.toString();
    }

    @Test
    public void testRejectsUnsignedAndWrongSignature() throws Exception {
        Config c = newConfig();
        BridgeServer srv = new BridgeServer(c, new McEvents(32), new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0), "桥应能正常启动");
        try {
            int port = srv.boundPort();
            assertEquals(401, statusOf(port, "/bridge/status", null, null, null), "无签名必须拒绝");

            String t = ts(), n = UUID.randomUUID().toString().replace("-", "");
            String bad = signature(t, n, "").substring(0, 60) + "ff";
            HttpURLConnection conn = (HttpURLConnection) URI.create("http://127.0.0.1:" + port + "/bridge/status").toURL().openConnection();
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(5000);
            conn.setRequestProperty("X-Xiaona-Ts", t);
            conn.setRequestProperty("X-Xiaona-Nonce", n);
            conn.setRequestProperty("X-Xiaona-Sig", bad);
            assertEquals(401, conn.getResponseCode(), "签名被篡改必须拒绝");

            // 正确签名放行
            String t2 = ts(), n2 = UUID.randomUUID().toString().replace("-", "");
            assertEquals(200, statusOf(port, "/bridge/status", t2, n2, null));
        } finally {
            srv.stop();
        }
    }

    /** 白名单模式：本机推来的绑定名单要落到闸门缓存（单个变更 / 整张名单替换） */
    @Test
    public void testWhitelistPushUpdatesGate() throws Exception {
        Config c = newConfig();
        WhitelistGate gate = new WhitelistGate(c.whitelist);
        BridgeServer srv = new BridgeServer(c, new McEvents(32), new RuntimeToggles(c), null, gate);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            int port = srv.boundPort();

            String[] r1 = postJson(port, "/bridge/whitelist", "{\"player\":\"Steve\",\"bound\":true}");
            assertEquals("200", r1[0], r1[1]);
            assertTrue(r1[1].contains("\"count\":1"), r1[1]);

            // 整张名单全量替换
            String[] r2 = postJson(port, "/bridge/whitelist", "{\"players\":[\"Alex\",\"Steve\"]}");
            assertEquals("200", r2[0], r2[1]);
            assertTrue(r2[1].contains("\"count\":2"), r2[1]);

            // 解绑后缓存缩小
            String[] r3 = postJson(port, "/bridge/whitelist", "{\"player\":\"Alex\",\"bound\":false}");
            assertEquals("200", r3[0], r3[1]);
            assertTrue(r3[1].contains("\"count\":1"), r3[1]);

            // 既没 player 也没 players → 400
            assertEquals("400", postJson(port, "/bridge/whitelist", "{}")[0]);
        } finally {
            srv.stop();
        }
    }

    @Test
    public void testEventsAreDeliveredOverSse() throws Exception {
        Config c = newConfig();
        McEvents events = new McEvents(32);
        BridgeServer srv = new BridgeServer(c, events, new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            int port = srv.boundPort();
            String t = ts(), n = UUID.randomUUID().toString().replace("-", "");
            Socket sock = new Socket("127.0.0.1", port);
            sock.setSoTimeout(10_000);
            String req = "GET /bridge/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                    + "X-Xiaona-Ts: " + t + "\r\nX-Xiaona-Nonce: " + n + "\r\n"
                    + "X-Xiaona-Sig: " + signature(t, n, "") + "\r\n\r\n";
            sock.getOutputStream().write(req.getBytes(StandardCharsets.UTF_8));
            sock.getOutputStream().flush();

            Thread pusher = new Thread(() -> {
                try { Thread.sleep(400); } catch (InterruptedException ignored) {}
                events.chat("Steve", "HELLO_BRIDGE_MARKER", false);
                events.join("Alex", true, "203.0.113.7");
                events.death("", "Steve 被僵尸杀死了");
                events.advancement("Steve", "Steve 取得了进度 [石器时代]");
            });
            pusher.start();

            StringBuilder all = new StringBuilder();
            long deadline = System.currentTimeMillis() + 8000;
            try (BufferedReader in = new BufferedReader(
                    new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8))) {
                while (System.currentTimeMillis() < deadline) {
                    String line = in.readLine();
                    if (line == null) break;
                    all.append(line).append('\n');
                    // 必须等到 join 的数据行落地再停（只看到 "event: join" 就停会读到半截）
                    if (all.indexOf("event: join") >= 0 && all.indexOf("HELLO_BRIDGE_MARKER") >= 0
                            && all.indexOf("\"op\":true") >= 0 && all.indexOf("event: advancement") >= 0
                            && all.indexOf("石器时代") >= 0 && all.indexOf("203.0.113.7") >= 0) break;
                }
            } catch (Exception ignored) {
            } finally {
                try { sock.close(); } catch (Exception ignored) {}
            }
            pusher.join(2000);

            String got = all.toString();
            assertTrue(got.contains("event: hello"), "应先收到 hello 握手: \n" + got);
            assertTrue(got.contains("event: chat"), "应收到 chat 事件: \n" + got);
            assertTrue(got.contains("HELLO_BRIDGE_MARKER"), "事件体应含文本: \n" + got);
            assertTrue(got.contains("\"player\":\"Steve\""), "事件体应含玩家名: \n" + got);
            assertTrue(got.contains("event: join"), "应收到 join 事件: \n" + got);
            assertTrue(got.contains("\"op\":true"), "join 应带 OP 标记: \n" + got);
            assertTrue(got.contains("\"ip\":\"203.0.113.7\""), "join 应带真实客户端 IP: \n" + got);
            assertTrue(got.contains("id: "), "每条事件应带 seq id: \n" + got);
            // 死亡消息与成就播报也要能原样推出去
            assertTrue(got.contains("event: death") && got.contains("被僵尸杀死了"), "应收到 death 事件: \n" + got);
            assertTrue(got.contains("event: advancement") && got.contains("石器时代"), "应收到 advancement 事件: \n" + got);
        } finally {
            srv.stop();
        }
    }

    @Test
    public void testBindCheckAcceptsPlayerVerdict() throws Exception {
        Config c = newConfig();
        BridgeServer srv = new BridgeServer(c, new McEvents(32), new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            int port = srv.boundPort();
            // 已绑定：bound=true
            String[] r = postJson(port, "/bridge/bindcheck",
                    "{\"player\":\"Steve\",\"bound\":true,\"group\":\"12345678\"}");
            assertEquals("200", r[0], r[1]);
            assertTrue(r[1].contains("\"player\":\"Steve\""), "应回显玩家名: " + r[1]);
            assertTrue(r[1].contains("\"bound\":true"), "应回显判定结果: " + r[1]);

            // 未绑定：bound=false
            String[] r2 = postJson(port, "/bridge/bindcheck", "{\"player\":\"Alex\",\"bound\":false}");
            assertEquals("200", r2[0], r2[1]);
            assertTrue(r2[1].contains("\"bound\":false"), r2[1]);

            // 缺 player 必须被拒（否则会拿空名去渲染）
            String[] noName = postJson(port, "/bridge/bindcheck", "{\"bound\":true}");
            assertEquals("400", noName[0], noName[1]);

            // 非法 JSON 必须被拒
            String[] bad = postJson(port, "/bridge/bindcheck", "{oops");
            assertEquals("400", bad[0], bad[1]);
        } finally {
            srv.stop();
        }
    }

    @Test
    public void testStreamClientCapIsEnforced() throws Exception {
        Config c = newConfig();
        c.bridge.maxStreamClients = 1;
        McEvents events = new McEvents(32);
        BridgeServer srv = new BridgeServer(c, events, new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            int port = srv.boundPort();
            Thread first = new Thread(() -> {
                try { readStream(port, 5000, "event: hello"); } catch (Exception ignored) {}
            });
            first.start();
            // 等第一条流确实建立
            long deadline = System.currentTimeMillis() + 3000;
            while (System.currentTimeMillis() < deadline && events.streamClients() == 0) Thread.sleep(50);
            assertEquals(1, events.streamClients(), "第一条流应已建立");

            String t = ts(), n = UUID.randomUUID().toString().replace("-", "");
            assertEquals(503, statusOf(port, "/bridge/stream", t, n, null), "超过上限应返回 503");

            first.join(8000);
            // 服务端无法主动感知对端断开，只能靠写心跳失败来判断；
            // TCP 下"关闭后第一次写"往往仍会成功，所以实际要 1~2 个心跳周期才释放（这里给足 25 秒）。
            deadline = System.currentTimeMillis() + 25_000;
            while (System.currentTimeMillis() < deadline && events.streamClients() != 0) Thread.sleep(100);
            assertEquals(0, events.streamClients(), "断开后连接数应在若干心跳周期内回落（否则名额会被永久占用）");
        } finally {
            srv.stop();
        }
    }

    @Test
    public void testSendRejectsWhenToggleOff() throws Exception {
        Config c = newConfig();
        RuntimeToggles toggles = new RuntimeToggles(c);
        BridgeServer srv = new BridgeServer(c, new McEvents(32), toggles, null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            int port = srv.boundPort();
            String body = "{\"target\":\"all\",\"text\":\"hi\"}";
            assertNotEquals(403, statusOf(port, "/bridge/send", ts(), UUID.randomUUID().toString().replace("-", ""), body));

            toggles.bridgeToChat = false;
            assertEquals(403, statusOf(port, "/bridge/send", ts(), UUID.randomUUID().toString().replace("-", ""), body),
                    "关闭 本机→游戏 后必须拒绝注入");

            toggles.bridgeToChat = true;
            toggles.enabled = false;
            assertEquals(403, statusOf(port, "/bridge/send", ts(), UUID.randomUUID().toString().replace("-", ""), body),
                    "整机关闭后必须拒绝注入");
        } finally {
            srv.stop();
        }
    }

    @Test
    public void testSecretTooShortRefusesToStart() {
        Config c = new Config();
        c.bridge.secret = "tooshort";
        BridgeServer srv = new BridgeServer(c, new McEvents(32), new RuntimeToggles(c), null, null);
        assertFalse(srv.start("127.0.0.1", 0), "密钥不合格时桥必须拒绝启动（fail-closed）");
        assertFalse(srv.isRunning());
    }

    /** target=players 批量投递：空名单/未知 target 必须拒绝，不能退化成广播 */
    @Test
    public void testPlayersTargetValidation() throws Exception {
        Config c = newConfig();
        BridgeServer srv = new BridgeServer(c, new McEvents(32), new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            int port = srv.boundPort();
            String s1 = UUID.randomUUID().toString().replace("-", "");
            String s2 = UUID.randomUUID().toString().replace("-", "");
            String s3 = UUID.randomUUID().toString().replace("-", "");

            assertEquals(400, statusOf(port, "/bridge/send", ts(), s1,
                    "{\"target\":\"players\",\"players\":[],\"text\":\"hi\"}"), "空名单必须拒绝");
            assertEquals(400, statusOf(port, "/bridge/send", ts(), s2,
                    "{\"target\":\"players\",\"players\":[\"  \"],\"text\":\"hi\"}"), "全是空白的名单必须拒绝");
            assertEquals(400, statusOf(port, "/bridge/send", ts(), s3,
                    "{\"target\":\"bogus\",\"text\":\"hi\"}"), "未知 target 必须拒绝（否则会误广播）");

            // 服务器未就绪（无 MinecraftServer）→ 200 但 delivered=0，且不能抛异常
            HttpURLConnection conn = (HttpURLConnection) URI.create("http://127.0.0.1:" + port + "/bridge/send").toURL().openConnection();
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(8000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            String t = ts(), n = UUID.randomUUID().toString().replace("-", "");
            String body = "{\"target\":\"players\",\"players\":[\"Steve\",\"Alex\"],\"text\":\"[QQ] hi\"}";
            conn.setRequestProperty("X-Xiaona-Ts", t);
            conn.setRequestProperty("X-Xiaona-Nonce", n);
            conn.setRequestProperty("X-Xiaona-Sig", signature(t, n, body));
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }
            assertEquals(200, conn.getResponseCode());
            String resp;
            try (var in = conn.getInputStream()) {
                resp = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            }
            assertTrue(resp.contains("\"delivered\":0"), "未就绪时应回报 0 送达: " + resp);
            assertTrue(resp.contains("\"to\":2"), "应回报目标个数: " + resp);
        } finally {
            srv.stop();
        }
    }

    /**
     * POST /bridge/player：桥在服务器本机去 Plan 面板取数据。
     * 面板端口对外不通，所以这条全靠 mod 代取 —— 成功、陌生玩家、面板不通、要求登录 都要有明确结果。
     */
    @Test
    public void testPlanPlayerProxy() throws Exception {
        // 假 Plan 面板
        com.sun.net.httpserver.HttpServer plan = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        plan.createContext("/v1/player", ex -> {
            String q = ex.getRequestURI().getQuery() == null ? "" : ex.getRequestURI().getQuery();
            String auth = ex.getRequestHeaders().getFirst("Authorization");
            String resp, code = "200";
            if (q.contains("player=Steve")) {
                resp = "{\"playerName\":\"Steve\",\"playtime\":3600000,\"lastSeen\":1690000000000,\"auth\":\""
                        + auth + "\",\"server\":\"" + q + "\"}";
            } else if (q.contains("player=Ghost")) {
                resp = "[]";                                   // Plan 查不到人时回空数组
            } else {
                resp = "{\"error\":\"unauthorized\"}";
                code = "401";
            }
            byte[] b = resp.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(Integer.parseInt(code), b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        plan.start();

        Config c = newConfig();
        c.plan.url = "http://127.0.0.1:" + plan.getAddress().getPort();
        c.plan.user = "paneluser";
        c.plan.password = "panelpass";
        c.plan.server = "main";
        BridgeServer srv = new BridgeServer(c, new McEvents(32), new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            int port = srv.boundPort();

            // 正常取到：字段原样带回，且带上了 Basic 认证、带上了 server 参数
            String[] ok = postJson(port, "/bridge/player", "{\"name\":\"Steve\"}");
            assertEquals("200", ok[0]);
            assertTrue(ok[1].contains("\"ok\":true"), "应回报成功: " + ok[1]);
            assertTrue(ok[1].contains("\"playerName\":\"Steve\""), "应带回 Plan 的玩家数据: " + ok[1]);
            // Basic 认证头与 server 参数由假 Plan 回显在数据里；Gson 会把 = & 转义，所以解析后再断言
            var player = com.google.gson.JsonParser.parseString(ok[1]).getAsJsonObject().getAsJsonObject("player");
            assertTrue(player.get("auth").getAsString().startsWith("Basic "),
                    "配了账号时应带 Basic 认证头: " + ok[1]);
            assertTrue(player.get("server").getAsString().contains("server=main"),
                    "配了服务器名时应带上 server 参数: " + ok[1]);

            // Plan 查不到这个人：不能当成查到了
            String[] ghost = postJson(port, "/bridge/player", "{\"name\":\"Ghost\"}");
            assertEquals("200", ghost[0]);
            assertTrue(ghost[1].contains("\"ok\":false") && ghost[1].contains("没有玩家 Ghost"),
                    "空数组应报「没有该玩家」: " + ghost[1]);

            // 非法玩家名：直接 400，不去骚扰 Plan
            assertEquals("400", postJson(port, "/bridge/player", "{\"name\":\"a b\"}")[0]);
            assertEquals("400", postJson(port, "/bridge/player", "{\"name\":\"\u5c0f\u94a0\"}")[0]);

            // 未签名：必须 401
            HttpURLConnection raw = (HttpURLConnection) URI.create("http://127.0.0.1:" + port + "/bridge/player").toURL().openConnection();
            raw.setRequestMethod("POST");
            raw.setDoOutput(true);
            try (OutputStream os = raw.getOutputStream()) { os.write("{\"name\":\"Steve\"}".getBytes(StandardCharsets.UTF_8)); }
            assertEquals(401, raw.getResponseCode(), "取玩家数据也必须签名");

            // 面板不通（换成一个没人监听的端口）：给出可定位的原因
            BridgeServer dead = new BridgeServer(deadPlanConfig(), new McEvents(32), new RuntimeToggles(c), null, null);
            assertTrue(dead.start("127.0.0.1", 0));
            try {
                String[] fail = postJson(dead.boundPort(), "/bridge/player", "{\"name\":\"Steve\"}");
                assertEquals("200", fail[0]);
                assertTrue(fail[1].contains("\"ok\":false") && fail[1].contains("连不上 Plan 面板"),
                        "面板不通应说清原因: " + fail[1]);
            } finally {
                dead.stop();
            }
        } finally {
            srv.stop();
            plan.stop(0);
        }
    }

    /** 指向一个没人监听的端口（面板没跑/端口填错） */
    private static Config deadPlanConfig() throws Exception {
        Config c = newConfig();
        c.plan.url = "http://127.0.0.1:1";
        c.plan.timeoutMs = 2000;
        return c;
    }

    /**
     * 有的 Plan 版本/单服模式不接受 server 参数（回 400/404）。
     * 这时必须自动换成"不带 server"再试一次，否则用户会以为功能坏了。
     */
    @Test
    public void testPlanFallsBackWhenServerParamRejected() throws Exception {
        com.sun.net.httpserver.HttpServer plan = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        plan.createContext("/v1/player", ex -> {
            String q = ex.getRequestURI().getQuery() == null ? "" : ex.getRequestURI().getQuery();
            String resp;
            int code;
            if (q.contains("server=")) {           // 这个 Plan 不要 server 参数
                resp = "{\"error\":\"invalid server\"}";
                code = 400;
            } else {
                resp = "{\"playerName\":\"Steve\",\"playtime\":120000}";
                code = 200;
            }
            byte[] b = resp.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(code, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        plan.start();

        Config c = newConfig();
        c.plan.url = "http://127.0.0.1:" + plan.getAddress().getPort();
        c.plan.server = "MyServer";               // 明明配了名字，但对面不接受
        BridgeServer srv = new BridgeServer(c, new McEvents(32), new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            String[] r = postJson(srv.boundPort(), "/bridge/player", "{\"name\":\"Steve\"}");
            assertEquals("200", r[0]);
            assertTrue(r[1].contains("\"ok\":true") && r[1].contains("playerName"),
                    "带 server 被拒后应自动不带 server 重试: " + r[1]);
        } finally {
            srv.stop();
            plan.stop(0);
        }
    }

    /**
     * Plan 面板会 gzip 压缩响应体，而 HttpClient 的 ofString() 不会自动解压。
     * 要求：① 明确声明 Accept-Encoding: identity；② 对方强行压缩时自己也能解开。
     */
    @Test
    public void testPlanHandlesGzipResponse() throws Exception {
        final String[] sawEncoding = new String[1];
        com.sun.net.httpserver.HttpServer plan = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        plan.createContext("/v1/player", ex -> {
            sawEncoding[0] = ex.getRequestHeaders().getFirst("Accept-Encoding");
            String json = "{\"playerName\":\"Steve\",\"playtime\":1800000}";
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            try (java.util.zip.GZIPOutputStream gz = new java.util.zip.GZIPOutputStream(bo)) {
                gz.write(json.getBytes(StandardCharsets.UTF_8));
            }
            byte[] b = bo.toByteArray();
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.getResponseHeaders().set("Content-Encoding", "gzip");   // 无视请求头，强行压缩
            ex.sendResponseHeaders(200, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        plan.start();

        Config c = newConfig();
        c.plan.url = "http://127.0.0.1:" + plan.getAddress().getPort();
        BridgeServer srv = new BridgeServer(c, new McEvents(32), new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            String[] r = postJson(srv.boundPort(), "/bridge/player", "{\"name\":\"Steve\"}");
            assertEquals("200", r[0]);
            assertTrue(r[1].contains("\"ok\":true") && r[1].contains("playerName"),
                    "压缩的响应体必须能解开拿到数据: " + r[1]);
            assertEquals("identity", sawEncoding[0], "必须明确告诉面板不要压缩");
        } finally {
            srv.stop();
            plan.stop(0);
        }
    }

    /** 真收到二进制（不是 JSON 也解不开）时，错误里要带上响应头和开头几个字节，便于定位 */
    @Test
    public void testPlanBinaryBodyReportsDiagnostics() throws Exception {
        com.sun.net.httpserver.HttpServer plan = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        plan.createContext("/v1/player", ex -> {
            byte[] b = new byte[]{0x7f, 0x45, 0x4c, 0x46, (byte) 0x80, (byte) 0xff, 0x00, 0x01};
            ex.getResponseHeaders().set("Content-Type", "application/octet-stream");
            ex.sendResponseHeaders(200, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        plan.start();

        Config c = newConfig();
        c.plan.url = "http://127.0.0.1:" + plan.getAddress().getPort();
        BridgeServer srv = new BridgeServer(c, new McEvents(32), new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            String[] r = postJson(srv.boundPort(), "/bridge/player", "{\"name\":\"Steve\"}");
            assertEquals("200", r[0]);
            // Gson 会把消息里的 = 转义成 \u003d，解析后再断言
            String err = com.google.gson.JsonParser.parseString(r[1]).getAsJsonObject().get("error").getAsString();
            assertTrue(err.contains("Content-Type=application/octet-stream"), "要报出响应头: " + err);
            assertTrue(err.contains("hex=[7f 45 4c 46"), "要报出开头字节的十六进制: " + err);
            assertTrue(err.contains("len=8"), "要报出长度: " + err);
            assertFalse(err.contains("登录页"), "别乱猜是登录页: " + err);
        } finally {
            srv.stop();
            plan.stop(0);
        }
    }

    /**
     * 玩了很久的玩家，Plan 会返回 550KB+（大半是会话里的分布序列）。
     * 桥必须能把没用的大数组裁掉再带回本机，否则会撞上长度上限、整条查询失败。
     */
    @Test
    public void testPlanSlimsHugeResponse() throws Exception {
        // 造一份"像真的一样"的大响应：info + kill_data + 100 条会话（每条带巨大的 gm_series/world_series）
        StringBuilder sb = new StringBuilder();
        sb.append("{\"info\":{\"name\":\"Heavy\",\"playtime\":1385625,\"last_seen\":1790410126771,")
          .append("\"death_count\":6,\"best_ping\":18,\"average_ping\":76.7,\"worst_ping\":175,")
          .append("\"activity_index\":0.91,\"session_count\":36,\"uuid\":\"u-1\"},")
          .append("\"kill_data\":{\"deaths_total\":6,\"player_kills_total\":0},")
          .append("\"sessions\":[");
        for (int i = 0; i < 100; i++) {
            if (i > 0) sb.append(',');
            sb.append("{\"server_name\":\"MyServer\",\"start\":1790400000000,\"length\":332677,")
              .append("\"most_used_world\":\"minecraft:overworld (97.23%)\",\"deaths\":1,")
              .append("\"gm_series\":[");
            for (int j = 0; j < 300; j++) {            // 每会话塞 300 个点，凑出 500KB+
                if (j > 0) sb.append(',');
                sb.append("{\"data\":[[\"SURVIVAL\",323478],[\"CREATIVE\",0]],\"name\":\"minecraft:overworld\",\"id\":\"w")
                  .append(j).append("\"}");
            }
            sb.append("]}");
        }
        sb.append("],\"servers\":[{\"server_name\":\"MyServer\",\"playtime\":1385625,\"world_pie_series\":[{\"name\":\"a\"}]}]}");
        final String huge = sb.toString();
        assertTrue(huge.length() > 512 * 1024, "造的样本要够大才有意义，实际 " + huge.length());

        com.sun.net.httpserver.HttpServer plan = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        plan.createContext("/v1/player", ex -> {
            byte[] b = huge.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().set("Content-Type", "application/json");
            ex.sendResponseHeaders(200, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        plan.start();

        Config c = newConfig();
        c.plan.url = "http://127.0.0.1:" + plan.getAddress().getPort();
        BridgeServer srv = new BridgeServer(c, new McEvents(32), new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            String[] r = postJson(srv.boundPort(), "/bridge/player", "{\"name\":\"Heavy\"}");
            assertEquals("200", r[0]);
            assertTrue(r[1].contains("\"ok\":true"), "大响应也该成功: " + r[1].substring(0, Math.min(200, r[1].length())));
            assertTrue(r[1].length() < 20_000, "裁完应该很小，实际 " + r[1].length() + " 字符");
            assertTrue(r[1].contains("\"trimmed\":true"), "应标明裁过: " + r[1].substring(0, Math.min(200, r[1].length())));
            // 显示要用的标量必须留着
            assertTrue(r[1].contains("\"playtime\":1385625"), "info 里的字段必须保留");
            assertTrue(r[1].contains("\"kill_data\""), "kill_data 要保留");
            assertTrue(r[1].contains("\"sessions_total\":100"), "应带上会话总数");
            assertTrue(r[1].contains("most_used_world"), "最近会话的关键信息要留一条");
            // 体积大头必须删掉
            assertFalse(r[1].contains("gm_series"), "会话里的分布序列必须删掉");
            assertFalse(r[1].contains("world_pie_series"), "servers 里的分布序列必须删掉");
        } finally {
            srv.stop();
            plan.stop(0);
        }
    }

    /** 从 Plan 的 config.yml 文本里认 ServerName（用户那份配置的真实片段） */
    @Test
    public void testPlanServerNameParsing() {
        String yaml = "# -----------------------------------------------------\n"
                + "# Plan Bukkit Configuration file\n"
                + "# -----------------------------------------------------\n"
                + "Server:\n"
                + "    # 服务器名称（可自定义）\n"
                + "    ServerName: MyServer\n"
                + "# -----------------------------------------------------\n"
                + "Webserver:\n"
                + "    Port: 8804\n";
        assertEquals("MyServer", BridgeServer.serverNameFrom(yaml), "应认出 ServerName");
        assertEquals("My Server", BridgeServer.serverNameFrom("ServerName: \"My Server\"\n"), "去掉引号");
        assertEquals("", BridgeServer.serverNameFrom("Webserver:\n    Port: 8804\n"), "没有这一行就返回空");
        assertEquals("", BridgeServer.serverNameFrom(null));
        // 不能被别的键误伤（比如 ServerName 出现在注释里）
        assertEquals("", BridgeServer.serverNameFrom("    # ServerName: 注释里的不算\n"), "注释行不该认");
    }

    /**
     * 服务器重启后，客户端的光标来自"上一次运行"（seq 远大于本进程的 lastSeq）。
     * 旧行为：since 被原样采信 → await() 永远等不到 e.seq > since → SSE 连着、心跳正常、
     * 事件一条都推不过来（用户报的"重启后无法转发、日志正常"就是这个）。
     */
    @Test
    public void testStaleLastEventIdFromPreviousRunStillReceivesEvents() throws Exception {
        Config c = newConfig();
        McEvents events = new McEvents(32);
        BridgeServer srv = new BridgeServer(c, events, new RuntimeToggles(c), null, null);
        assertTrue(srv.start("127.0.0.1", 0));
        try {
            int port = srv.boundPort();
            long stale = 5000L; // 模拟上一次服务器运行攒下的光标
            Thread pusher = new Thread(() -> {
                try { Thread.sleep(400); } catch (InterruptedException ignored) {}
                events.chat("Steve", "AFTER_RESTART_MARKER", false);
            });
            pusher.start();

            String got = readStream(port, 6000, "AFTER_RESTART_MARKER", stale);
            pusher.join(2000);

            assertTrue(got.contains("event: hello"), "应先收到握手包: \n" + got);
            assertTrue(got.contains("\"lastSeq\":"), "握手包必须带上服务端当前序号（客户端据此识别重启）: \n" + got);
            assertTrue(got.contains("AFTER_RESTART_MARKER"),
                    "服务端重启后，客户端带着旧光标重连也必须能收到新事件: \n" + got);
        } finally {
            srv.stop();
        }
    }
}
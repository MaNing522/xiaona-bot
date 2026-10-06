package com.xiaona;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 配置：config/xiaona/config.json
 * 只保留"服务器侧桥"需要的项 —— QQ 登录、AI、命令、面板全部在本机运行。
 */
public class Config {
    public boolean enabled = true; // 总开关：false 时整个 mod 不启动
    public Bridge bridge = new Bridge();
    public Http http = new Http();
    public Plan plan = new Plan();
    public Board board = new Board();
    public Whitelist whitelist = new Whitelist();

    /**
     * 未绑定玩家的侧边栏计分板：进服时若还没绑定游戏ID，就给一条"进QQ群发 #绑定"的指引，
     * 绑定成功后（本机机器人推送最新绑定表）立即撤掉。绑定表与群号都由本机推送。
     */
    public static class Board {
        public boolean enabled = true;
        public String title = "小钠 · QQ 绑定";
    }

    /**
     * 白名单模式：开启后**弃用计分板**，改用服务器白名单把门。
     *
     * 已在原版白名单里（或 OP）的玩家照常进；其余玩家由**本机机器人推来的绑定名单**决定：
     * 在名单里 → 补进原版白名单并放行；不在 → 按 kickMessage 踢出。
     * 机器人侧在"有人绑定/解绑"时和"连接上桥时"都会把名单推给服务端，见 /bridge/whitelist。
     */
    public static class Whitelist {
        public boolean enabled = false;
        /** 踢出提示里展示的 QQ 群号（{group} 会被替换成它） */
        public String group = "714965699";
        /** 踢出时显示的文案；{group} 会被替换成群号 */
        public String kickMessage = "你还未绑定游戏ID。\n请加入 QQ 群 {group}，发送 #绑定 <游戏ID> 完成绑定后再进服。";
    }

    /** MC 服务器侧的桥：向本机机器人推送游戏事件、接收它投递的文本 */
    public static class Bridge {
        public boolean enabled = true;
        public String secret = "";            // 必填，至少 32 字符；为空则桥不启动（fail-closed）
        public List<String> allowFrom = new ArrayList<>(); // 允许来源 IP，空 = 不限制
        public int timestampWindowSec = 300;  // 签名时间戳容差（秒）
        public String chatPrefix = "[MC]";    // 事件里游戏聊天的前缀，供本机识别
        public String privateCommand = "xn";  // 游戏内私聊命令：/xn <内容>
        /** 注入文本开头 [标签] 的颜色（如 [QQ] 黄色）：gold/yellow/#RRGGBB；none = 不染色 */
        public String prefixColor = "gold";
        public int queueSize = 200;           // 事件回放缓冲条数（断线重连可补）
        public int maxStreamClients = 4;      // 同时允许的 SSE 连接数
        public int rateLimitPerMinute = 120;  // 注入文本每分钟上限，0 = 不限
    }

    /** 桥的监听方式：优先与 MC 共用一个端口（端口复用） */
    public static class Http {
        public String host = "0.0.0.0"; // 未启用端口复用时的独立监听地址
        public int port = 8080;         // 未启用端口复用时的独立端口（被占用会自动退到随机端口）
        public int sharePort = 43733;   // 复用端口，0 = 关闭复用
        public int mcPort = 0;          // MC 实际端口，0 = 自动读取
        /**
         * 内部备用端口：当服务商把 MC 端口固定在复用端口上（例如只放行 43733、且 server-port 被写死 43733）时，
         * 会把 MC 的实际绑定挪到这个端口，对外仍旧统一走 sharePort。
         */
        public int internalPort = 25565;
    }

    /**
     * Plan 玩家分析插件：面板端口通常不对外开放（服务商只放行 MC 那一个端口），
     * 所以由桥在服务器**本机**去取，再经已有的签名接口带回本机机器人。
     */
    public static class Plan {
        public boolean enabled = true;
        public String url = "http://127.0.0.1:8804"; // Plan 面板地址（服务器本机）
        public String user = "";                     // 面板要求登录时填（Basic 认证）；空 = 匿名
        public String password = "";
        public String server = "";                   // Plan 里的服务器名（多服/网络模式填）；空 = 不带该参数
        public int timeoutMs = 8000;                 // 等面板响应的时间上限
    }

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    public static Config load(Path dir) {
        try {
            Path file = dir.resolve("config.json");
            Config cfg;
            if (Files.exists(file)) {
                String raw = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
                JsonObject obj = JsonParser.parseString(raw).getAsJsonObject();
                cfg = GSON.fromJson(obj, Config.class);
            } else {
                cfg = new Config();
            }
            cfg.normalize();
            cfg.save(dir);
            return cfg;
        } catch (Exception e) {
            throw new RuntimeException("加载配置失败", e);
        }
    }

    /** 写回 config/xiaona/config.json（写盘前先 normalize，避免把非法值落盘） */
    public void save(Path dir) {
        try {
            Files.createDirectories(dir);
            normalize();
            Files.write(dir.resolve("config.json"), GSON.toJson(this).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new RuntimeException("保存配置失败", e);
        }
    }

    /** 防止 json 中显式写 null / 非法值导致后续出错 */
    private void normalize() {
        if (bridge == null) bridge = new Bridge();
        if (bridge.secret == null) bridge.secret = "";
        bridge.secret = bridge.secret.trim();
        if (bridge.allowFrom == null) bridge.allowFrom = new ArrayList<>();
        if (bridge.chatPrefix == null) bridge.chatPrefix = "[MC]";
        if (bridge.privateCommand == null || bridge.privateCommand.isBlank()) bridge.privateCommand = "xn";
        bridge.privateCommand = bridge.privateCommand.trim().toLowerCase();
        if (bridge.prefixColor == null) bridge.prefixColor = "gold";
        bridge.prefixColor = bridge.prefixColor.trim();
        if (bridge.timestampWindowSec < 30) bridge.timestampWindowSec = 300;
        if (bridge.queueSize < 16) bridge.queueSize = 200;
        if (bridge.maxStreamClients < 1) bridge.maxStreamClients = 4;
        if (bridge.rateLimitPerMinute < 0) bridge.rateLimitPerMinute = 120;

        if (http == null) http = new Http();
        if (http.host == null || http.host.isBlank()) http.host = "0.0.0.0";
        http.host = http.host.trim();
        if (http.port <= 0) http.port = 8080;
        if (http.sharePort < 0) http.sharePort = 0;
        if (http.internalPort <= 0) http.internalPort = 25565;

        if (plan == null) plan = new Plan();
        if (plan.url == null || plan.url.isBlank()) plan.url = "http://127.0.0.1:8804";
        plan.url = plan.url.trim().replaceAll("/+$", "");   // 末尾斜杠会让拼出来的路径变成 //v1/player
        if (plan.user == null) plan.user = "";
        plan.user = plan.user.trim();
        if (plan.password == null) plan.password = "";
        if (plan.server == null) plan.server = "";
        plan.server = plan.server.trim();
        if (plan.timeoutMs < 1000) plan.timeoutMs = 8000;

        if (board == null) board = new Board();
        if (board.title == null || board.title.isBlank()) board.title = "小钠 · QQ 绑定";
        board.title = board.title.trim();

        if (whitelist == null) whitelist = new Whitelist();
        if (whitelist.group == null) whitelist.group = "";
        whitelist.group = whitelist.group.trim();
        if (whitelist.kickMessage == null || whitelist.kickMessage.isBlank()) {
            whitelist.kickMessage = "你还未绑定游戏ID。\n请加入 QQ 群 {group}，发送 #绑定 <游戏ID> 完成绑定后再进服。";
        }
    }
}
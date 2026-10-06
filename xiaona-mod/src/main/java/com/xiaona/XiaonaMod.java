package com.xiaona;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.entity.event.v1.ServerPlayerEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.command.argument.MessageArgumentType;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayNetworkHandler;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;

import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.nio.file.Path;

/**
 * 小钠桥 mod 入口。
 *
 * 分工：**QQ 登录、AI、命令、控制面板全部在本机**（Node + NapCat）；
 * 本 mod 只做"MC 服务器侧的桥"——把游戏内的聊天/进出服事件推给本机，
 * 并接收本机投递的文本注入游戏。所有通信走与 Minecraft 相同的端口（{@link PortMux}）。
 */
public class XiaonaMod implements ModInitializer {
    private Config config;
    private RuntimeToggles toggles;
    private McEvents events;
    private BridgeServer bridge;
    private BindBoard bindBoard;
    private WhitelistGate whitelistGate;
    private PortMux portMux;
    /** 提前占住的对外端口；只有拿到了才允许把 MC 挪到内部端口 */
    private java.net.ServerSocket reservedShare = null;

    @Override
    public void onInitialize() {
        BotState.log("小钠桥 mod 初始化中 ...");
        try {
            Path cfgDir = FabricLoader.getInstance().getConfigDir().resolve("xiaona");
            config = Config.load(cfgDir);
            if (!config.enabled) {
                BotState.log("总开关已关闭（config.json 的 enabled=false），小钠桥 mod 已跳过启动。");
                return;
            }
            toggles = new RuntimeToggles(config);
            events = new McEvents(config.bridge.queueSize);
            events.setTagColor(config.bridge.prefixColor);
            // 白名单模式：弃用计分板（改用服务器白名单把门），所以不再创建计分板
            boolean whitelistMode = config.whitelist != null && config.whitelist.enabled;
            bindBoard = whitelistMode ? null : new BindBoard(config.board);
            whitelistGate = new WhitelistGate(config.whitelist);
            whitelistGate.setEvents(events);   // 进服时顺着事件流向本机实时询问绑定状态
            bridge = new BridgeServer(config, events, toggles, bindBoard, whitelistGate);
            preparePortRelocation();
        } catch (Throwable e) {
            BotState.error("初始化失败: " + e.getMessage());
            throw new RuntimeException("小钠桥 mod 初始化失败", e);
        }

        registerCommands();

        ServerLifecycleEvents.SERVER_STARTED.register(server -> {
            events.setServer(server);
            if (bindBoard != null) bindBoard.setServer(server);
            if (whitelistGate != null) {
                whitelistGate.setServer(server);
                whitelistGate.onServerStarted();
            }
            startListen(server);
        });

        ServerLifecycleEvents.SERVER_STOPPING.register(server -> {
            if (portMux != null) portMux.stop();
            if (bridge != null) bridge.stop();
            releaseReserved();
        });

        // 游戏公聊 → 事件入队（broadcast 不会再次触发本事件，无回环）
        ServerMessageEvents.CHAT_MESSAGE.register((message, sender, params) -> {
            try {
                if (!pushEnabled()) return;
                events.chat(sender.getName().getString(), message.getContent().getString(), events.isOp(sender));
            } catch (Exception e) {
                BotState.error("[聊天] " + e.getMessage());
            }
        });

        // 进服/退服 → 事件入队
        ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> {
            try {
                ServerPlayerEntity p = handler.getPlayer();
                // 计分板不看桥的开关：没绑定就提示去绑定
                if (bindBoard != null) bindBoard.onJoin(p);
                if (!pushEnabled()) return;
                events.join(p.getName().getString(), events.isOp(p), realIpOf(handler));
            } catch (Exception ignored) {
            }
        });

        // 复活/换维度后客户端会重建界面，按上次判定重新下发一次侧边栏
        ServerPlayerEvents.AFTER_RESPAWN.register((oldPlayer, newPlayer, alive) -> {
            try {
                if (bindBoard != null) bindBoard.onRespawn(newPlayer);
            } catch (Exception ignored) {
            }
        });
        ServerPlayConnectionEvents.DISCONNECT.register((handler, server) -> {
            try {
                if (!pushEnabled()) return;
                ServerPlayerEntity p = handler.getPlayer();
                events.leave(p.getName().getString(), events.isOp(p));
            } catch (Exception ignored) {
            }
        });

        // 服务器广播的系统消息 → 挑出死亡消息与成就播报转发（其余忽略；自己注入的 literal 不会被误判）
        ServerMessageEvents.GAME_MESSAGE.register((server, message, overlay) -> {
            try {
                if (!pushEnabled()) return;
                String kind = GameMessages.classify(message);
                if (kind == null) return;
                // 服务端只会按 en_us 解析，这里自己按官方中文语言表渲染
                String text = ZhText.render(message);
                String who = GameMessages.whoOf(message);
                if ("death".equals(kind)) events.death(who, text);
                else events.advancement(who, text);
            } catch (Exception ignored) {
            }
        });

        BotState.log("小钠桥 mod 加载完成。配置文件: " + FabricLoader.getInstance().getConfigDir().resolve("xiaona"));
        int zh = ZhText.size();
        BotState.log(zh > 0
                ? "🌏 中文语言表已就绪（" + zh + " 条）：死亡消息与成就播报会以中文推送到 QQ。"
                : "⚠️ 中文语言表未加载：死亡消息与成就播报将保持英文。");
    }

    private boolean pushEnabled() {
        return toggles != null && toggles.enabled && toggles.chatToBridge;
    }

    // ---------- 命令 ----------
    private void registerCommands() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            // /<privateCommand> <内容>：游戏内私聊小钠（事件转给本机，由本机 AI 应答后注入回来）
            String pm = config.bridge.privateCommand;
            dispatcher.register(CommandManager.literal(pm)
                .then(CommandManager.argument("msg", MessageArgumentType.message())
                    .executes(ctx -> {
                        ServerPlayerEntity p = ctx.getSource().getPlayer();
                        if (p == null) {
                            ctx.getSource().sendError(Text.literal("该命令仅玩家可用。"));
                            return 0;
                        }
                        String text = MessageArgumentType.getMessage(ctx, "msg").getString().trim();
                        if (!pushEnabled()) {
                            p.sendMessage(Text.literal("小钠当前已关闭。"), false);
                            return 1;
                        }
                        if (events.streamClients() == 0) {
                            p.sendMessage(Text.literal("小钠当前不在线（本机机器人未连接服务器）。"), false);
                            return 1;
                        }
                        events.privateMsg(p.getName().getString(), text, events.isOp(p));
                        return 1;
                    })));

            // /xiaona ...：仅 OP 可用的管理命令
            dispatcher.register(CommandManager.literal("xiaona")
                .requires(XiaonaMod::isOpSource)
                .executes(ctx -> {
                    ctx.getSource().sendFeedback(() -> Text.literal(statusLine()), false);
                    return 1;
                })
                .then(CommandManager.literal("list").executes(ctx -> {
                    ctx.getSource().sendFeedback(() -> Text.literal(toggles.status()), false);
                    return 1;
                }))
                .then(CommandManager.literal("on").executes(ctx -> {
                    toggles.enabled = true;
                    ctx.getSource().sendFeedback(() -> Text.literal("✅ 整机已开启。"), false);
                    return 1;
                }))
                .then(CommandManager.literal("off").executes(ctx -> {
                    toggles.enabled = false;
                    ctx.getSource().sendFeedback(() -> Text.literal("⛔ 整机已关闭。"), false);
                    return 1;
                })));

            // /xiaona <item> on|off：字面量子命令（1.21.11 无 StringArgumentType 的可用替代）
            String[] items = {"mcto", "tomc"};
            for (String item : items) {
                final String it = item;
                dispatcher.register(CommandManager.literal("xiaona")
                    .requires(XiaonaMod::isOpSource)
                    .then(CommandManager.literal(it)
                        .then(CommandManager.literal("on").executes(ctx -> {
                            ctx.getSource().sendFeedback(() -> Text.literal("✅ " + toggles.toggle(it, true)), false);
                            return 1;
                        }))
                        .then(CommandManager.literal("off").executes(ctx -> {
                            ctx.getSource().sendFeedback(() -> Text.literal("✅ " + toggles.toggle(it, false)), false);
                            return 1;
                        }))));
            }
        });
    }

    /**
     * 真实客户端 IP。
     *
     * 启用端口复用后，玩家连的是 {@link PortMux}，MC 实际是从 {@code 127.0.0.1:<上游端口>}
     * 收到连接，普通写法只会拿到 127.0.0.1；这里用该端口回 PortMux 反查真实地址。
     * 没启用复用时，MC 拿到的本来就是真实地址，直接用。
     */
    private String realIpOf(ServerPlayNetworkHandler handler) {
        try {
            SocketAddress sa = handler.getConnectionAddress();
            if (sa instanceof InetSocketAddress isa) {
                String host = isa.getAddress() != null ? isa.getAddress().getHostAddress() : "";
                if (!isLoopback(host)) return host;
                PortMux mux = portMux;
                if (mux != null) {
                    String real = mux.realIpOf(isa.getPort());
                    if (real != null) return real;
                }
                return host;
            }
        } catch (Exception ignored) {
        }
        return "";
    }

    private static boolean isLoopback(String h) {
        return "127.0.0.1".equals(h) || "localhost".equals(h)
                || "::1".equals(h) || "0:0:0:0:0:0:0:1".equals(h);
    }

    /** OP 判定：控制台放行，玩家以服务器 OP 名单为准 */
    private static boolean isOpSource(ServerCommandSource source) {
        ServerPlayerEntity p = source.getPlayer();
        if (p == null) return true;
        MinecraftServer srv = source.getServer();
        return srv != null && McEvents.isOp(srv, p);
    }

    private String statusLine() {
        String net;
        if (portMux != null && portMux.isRunning()) {
            net = "复用端口 " + config.http.sharePort;
        } else if (bridge != null && bridge.isRunning()) {
            net = "独立端口 " + bridge.boundPort();
        } else {
            net = "未启动";
        }
        return "[小钠桥] 整机: " + (toggles.enabled ? "开" : "关")
                + " | 监听: " + net
                + " | 在线: " + events.playerCount()
                + " | 本机连接: " + (events.streamClients() > 0 ? "已连接" : "未连接")
                + " | 私聊命令: /" + config.bridge.privateCommand;
    }

    // ---------- 端口复用：MC 端口被固定时的腾挪 ----------
    /**
     * 有些服务商把 MC 端口写死成唯一对外开放的那个端口（只放行一个端口），
     * 此时 PortMux 无法再监听同一端口。
     *
     * 关键顺序：**先**把对外端口占住，**再**允许把 MC 挪到内部端口。
     * 否则一旦"MC 已挪走、PortMux 却没拿到端口"，服务器就彻底连不上了。
     */
    private void preparePortRelocation() {
        if (config.http.sharePort <= 0) return;

        try {
            java.net.ServerSocket s = new java.net.ServerSocket();
            s.setReuseAddress(true);
            s.bind(new java.net.InetSocketAddress(config.http.sharePort), 64);
            reservedShare = s;
        } catch (Exception e) {
            BotState.error("❌ 对外端口 " + config.http.sharePort + " 无法占用（" + e.getMessage()
                    + "），本次不启用端口复用；MC 保持原端口不受影响。");
            return;
        }

        int free = PortRelocator.findFreePort(config.http.internalPort);
        if (free <= 0 || free == config.http.sharePort) {
            BotState.error("❌ 在 " + config.http.internalPort + " 附近找不到可用的内部端口，"
                    + "无法把 MC 从 " + config.http.sharePort + " 挪开，本次不启用端口复用。");
            releaseReserved();
            return;
        }
        PortRelocator.configure(config.http.sharePort, free);
        BotState.log("🔀 已占住对外端口 " + config.http.sharePort + "、预备内部端口 " + free
                + "：若 MC 端口被固定在 " + config.http.sharePort + "，会自动把 MC 改绑到 " + free
                + "，玩家照旧用原地址进服。");
    }

    /** 释放提前占住的端口（桥没起来时不能白占着，否则端口开着却没人应答） */
    private void releaseReserved() {
        java.net.ServerSocket s = reservedShare;
        reservedShare = null;
        if (s != null) {
            try { s.close(); } catch (Exception ignored) {}
        }
    }

    // ---------- 监听：优先与 MC 共用端口 ----------
    private void startListen(MinecraftServer server) {
        Config.Http h = config.http;
        int share = h.sharePort;
        // mcPort 取 MC 的"实际"绑定端口：端口被挪走时 getServerPort() 仍是配置值，直接用会自我转发成环
        int requested = h.mcPort > 0 ? h.mcPort : server.getServerPort();
        int mcPort = PortRelocator.map(requested);

        if (share <= 0) {
            bridge.start(h.host, h.port);
            return;
        }
        if (share == mcPort) {
            BotState.error("❌ 无法启用端口复用：复用端口 " + share + " 与 MC 端口相同，且无法把 MC 挪走。");
            BotState.log("👉 请把 config.json 里 http.internalPort 换一个没被占用的备用端口，"
                    + "或把 http.sharePort 设为 0 放弃端口复用。");
            releaseReserved();
            bridge.start(h.host, h.port);
            return;
        }
        if (reservedShare == null) {
            BotState.error("端口复用未启用（对外端口未占用成功），桥改走独立端口。");
            bridge.start(h.host, h.port);
            return;
        }

        // 桥内部只监听本机，对外统一从复用端口进
        if (!bridge.start("127.0.0.1", 0)) {
            releaseReserved();
            return;
        }
        PortMux mux = new PortMux(reservedShare, share, bridge.boundPort(), mcPort);
        if (mux.start()) {
            portMux = mux;
            reservedShare = null; // 所有权已交给 PortMux
            bridge.setSharePort(share);
            BotState.log("👉 同一端口 " + share + "：玩家用 MC 客户端填 服务器IP:" + share + " 进服游玩；"
                    + "本机机器人的 MC_BRIDGE_URL 也填 http://服务器IP:" + share
                    + "（MC 实际监听 " + mcPort + "）");
        } else {
            releaseReserved();
            bridge.stop();
            BotState.log("👉 端口复用不可用，桥改走独立端口：");
            bridge.start(h.host, h.port);
        }
    }
}
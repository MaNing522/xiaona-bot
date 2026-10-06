package com.xiaona;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.PlayerConfigEntry;
import net.minecraft.server.WhitelistEntry;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;

import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 白名单模式的判定闸门（config.json 的 {@code whitelist.enabled=true} 时生效）。
 *
 * 谁绑定了游戏ID只有本机（QQ 侧）知道，而本机是**作为客户端**连到服务端桥的，
 * 服务端没法反向问它 —— 所以改由本机**主动推**：有人绑定/解绑时推单人变更、
 * 连上桥时推整张绑定名单（见 {@code POST /bridge/whitelist}）。这里把名单缓存下来，
 * 玩家进服时用它判定，等价于"向 bot 询问是否在绑定名单中"。
 *
 * 判定发生在原版"能不能进服"的时刻：{@link com.xiaona.mixin.PlayerManagerMixin}
 * 拦下 {@code PlayerManager#checkCanJoin}（原版就是在这里查白名单、查不到就回
 * {@code multiplayer.disconnect.not_whitelisted}）。规则：
 * <ul>
 *   <li>白名单模式关 / 原版白名单没开 / 玩家已在白名单或 OP → 交还原版（照常进）</li>
 *   <li>否则：在绑定名单里 → 把他的真实档案补进原版白名单并放行</li>
 *   <li>否则：用配置的 kickMessage（含 QQ 群号）踢出</li>
 * </ul>
 */
public class WhitelistGate {
    private static volatile WhitelistGate instance;

    private final Config.Whitelist cfg;
    /** 小写游戏ID → 是否在 QQ 绑定名单里 */
    private final Set<String> bound = ConcurrentHashMap.newKeySet();
    private volatile MinecraftServer server;

    public WhitelistGate(Config.Whitelist cfg) {
        this.cfg = cfg;
        instance = this;
    }

    /** 供 mixin 取用（未启用/未初始化时为 null） */
    public static WhitelistGate instance() { return instance; }

    public boolean enabled() { return cfg != null && cfg.enabled; }

    public void setServer(MinecraftServer s) { this.server = s; }

    public int size() { return bound.size(); }

    /** 服务器启动：白名单模式开 → 打开原版白名单（原版关着的话 checkCanJoin 根本不会拦） */
    public void onServerStarted() {
        MinecraftServer s = server;
        if (!enabled() || s == null) return;
        try {
            if (!s.getUseAllowlist()) {
                s.setUseAllowlist(true);
                BotState.log("🔐 白名单模式已开启：已启用服务器白名单，未在 QQ 绑定名单里的玩家将无法进服。");
            }
        } catch (Exception e) {
            BotState.error("[白名单] 启用服务器白名单失败: " + e.getMessage());
        }
    }

    /** 单个玩家的绑定状态变化：先更新缓存（判定只认缓存），再到主线程同步原版白名单 */
    public void setBound(String player, boolean isBound) {
        if (player == null || player.isBlank()) return;
        String key = player.toLowerCase(Locale.ROOT);
        if (isBound) bound.add(key);
        else bound.remove(key);
        MinecraftServer s = server;
        if (s == null || !enabled()) return;
        s.execute(() -> {
            try {
                if (isBound) grantByName(player);
                else revokeByName(player);
            } catch (Exception ignored) {
            }
        });
    }

    /**
     * 整张绑定名单（本机连接上桥时推来）：**只补不删** ——
     * 原版白名单里可能还有管理员手动加的人，无权替他们做删除。
     * 解绑的收回走单人变更 {@link #setBound}。
     */
    public void setAll(List<String> names) {
        bound.clear();
        if (names != null) {
            for (String n : names) if (n != null && !n.isBlank()) bound.add(n.toLowerCase(Locale.ROOT));
        }
        MinecraftServer s = server;
        if (s == null || !enabled()) return;
        s.execute(() -> {
            for (String n : names == null ? List.<String>of() : names) {
                try {
                    grantByName(n);
                } catch (Exception ignored) {
                }
            }
        });
    }

    /**
     * 是否由本闸门接管这次进服判定。
     * 只有"白名单模式开 + 原版会拒绝（白名单没开、或玩家不在白名单且不是 OP）"时才接管。
     */
    public boolean shouldGate(PlayerConfigEntry entry) {
        MinecraftServer s = server;
        if (!enabled() || s == null || entry == null) return false;
        try {
            if (!s.getUseAllowlist()) return false;
            return !s.getPlayerManager().isWhitelisted(entry);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 接管后的结论。
     * @return null = 放行（并已把该玩家补进白名单）；非 null = 用这段文本踢出
     */
    public Text gate(PlayerConfigEntry entry) {
        String name = entry == null ? null : entry.name();
        if (name != null && bound.contains(name.toLowerCase(Locale.ROOT))) {
            try {
                MinecraftServer s = server;
                if (s != null && !s.getPlayerManager().getWhitelist().isAllowed(entry)) {
                    s.getPlayerManager().getWhitelist().add(new WhitelistEntry(entry));
                    BotState.log("🔐 " + name + " 在 QQ 绑定名单内，已加入白名单并放行。");
                }
            } catch (Exception ignored) {
            }
            return null;
        }
        return kickText();
    }

    private Text kickText() {
        String tmpl = cfg == null || cfg.kickMessage == null ? "你还未绑定游戏ID" : cfg.kickMessage;
        String g = cfg == null || cfg.group == null ? "" : cfg.group;
        return Text.literal(tmpl.replace("{group}", g)).formatted(Formatting.YELLOW);
    }

    /** 把已绑定玩家补进原版白名单；拿不到真实档案（离线且从没进过服）就只留缓存，等进服时再补 */
    private void grantByName(String name) {
        MinecraftServer s = server;
        if (s == null || name == null || name.isBlank()) return;
        ServerPlayerEntity p = s.getPlayerManager().getPlayer(name);
        PlayerConfigEntry entry = p != null ? new PlayerConfigEntry(p.getGameProfile()) : findEntry(name);
        if (entry == null) return;   // 离线且不在白名单：没有 UUID 无法构造正确条目，交给进服时的 gate
        if (s.getPlayerManager().getWhitelist().isAllowed(entry)) return;
        s.getPlayerManager().getWhitelist().add(new WhitelistEntry(entry));
        BotState.log("🔐 已把 " + name + " 加入服务器白名单（QQ 已绑定）");
    }

    /** 从现有白名单里按名字找条目（解绑时要靠它拿到带真实 UUID 的 key） */
    private PlayerConfigEntry findEntry(String name) {
        MinecraftServer s = server;
        if (s == null || name == null) return null;
        try {
            for (WhitelistEntry e : s.getPlayerManager().getWhitelist().values()) {
                PlayerConfigEntry k = e.getKey();
                if (k != null && k.name() != null && k.name().equalsIgnoreCase(name)) return k;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private void revokeByName(String name) {
        PlayerConfigEntry entry = findEntry(name);
        MinecraftServer s = server;
        if (entry == null || s == null) return;
        if (s.getPlayerManager().getWhitelist().remove(entry)) {
            BotState.log("🔐 已把 " + name + " 移出服务器白名单（QQ 已解绑）");
        }
    }
}

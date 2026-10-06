package com.xiaona;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.PlayerConfigEntry;
import net.minecraft.server.WhitelistEntry;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * 白名单模式的判定闸门（config.json 的 {@code whitelist.enabled=true} 时生效）。
 *
 * 谁绑定了游戏ID只有本机（QQ 侧）知道。服务端是本机**连过来**的桥，但这条连接不是单向的：
 * 本机握着一条 SSE 长连接（{@code GET /bridge/stream}），服务端可以顺着它推一条"询问"事件，
 * 本机收到后再用普通的 HTTP POST 把答案回给服务端 —— 于是"进服时向 bot 询问"是真的往返查询：
 * <ol>
 *   <li>服务端推 {@code whitelist_query}（带请求 id）</li>
 *   <li>本机查绑定表，POST {@code /bridge/whitelist_response} 回答 bound 与否</li>
 *   <li>登录线程在 {@link #QUERY_TIMEOUT_MS} 内等这条回答</li>
 * </ol>
 * 为了不让每次进服都吃一次往返，先查**缓存**：本机在绑定/解绑时主动推单人变更、
 * 连上桥时推整张名单（{@code POST /bridge/whitelist}），命中就直接放行；
 * 未命中才发起上面的实时询问。询问超时（或本机没连着）则回退到缓存判定。
 *
 * 判定发生在原版"能不能进服"的时刻：{@link com.xiaona.mixin.PlayerManagerMixin}
 * 拦下 {@code PlayerManager#checkCanJoin}（原版就是在这里查白名单、查不到就回
 * {@code multiplayer.disconnect.not_whitelisted}）。规则：
 * <ul>
 *   <li>白名单模式关 / 原版白名单没开 / 玩家已在白名单或 OP → 交还原版（照常进）</li>
 *   <li>否则：在绑定名单里（缓存命中或询问得到"在"）→ 把他的真实档案补进原版白名单并放行</li>
 *   <li>否则：用配置的 kickMessage（含 QQ 群号）踢出</li>
 * </ul>
 *
 * <b>热加载 / 热写入</b>：本机推来的名单无需重启即可生效 —— {@link #setBound} 即时增减，
 * {@link #setAll} 是**权威整表同步**（补上绑定的、收回已解绑的），启动时也会把缓存里的名单
 * 一次性刷进服务器白名单；每次增删都通过原版 {@code Whitelist} 落盘（{@code whitelist.json}）。
 * 收回时只动"本闸门自己加过的人"，不会误删管理员手动加的白名单条目。
 */
public class WhitelistGate {
    /** 实时询问本机的等待上限：本机通常就在同机/同网，正常几毫秒就回；超时即回退缓存 */
    private static final long QUERY_TIMEOUT_MS = 3000L;
    private static volatile WhitelistGate instance;

    private final Config.Whitelist cfg;
    /** 小写游戏ID → 是否在 QQ 绑定名单里 */
    private final Set<String> bound = ConcurrentHashMap.newKeySet();
    /** 本闸门自己加进白名单的名字（小写）：整表同步/收回时只动这些，保护管理员手动加的人 */
    private final Set<String> managed = ConcurrentHashMap.newKeySet();
    /** 已发出、还在等本机回答的询问：请求 id → 结果 */
    private final Map<String, CompletableFuture<Boolean>> pending = new ConcurrentHashMap<>();
    private volatile McEvents events;
    private volatile MinecraftServer server;

    public WhitelistGate(Config.Whitelist cfg) {
        this.cfg = cfg;
        instance = this;
    }

    /** 事件流（用来把"询问"推给本机）；没接也能跑，只是退化成纯缓存判定 */
    public void setEvents(McEvents e) { this.events = e; }

    /** 供 mixin 取用（未启用/未初始化时为 null） */
    public static WhitelistGate instance() { return instance; }

    public boolean enabled() { return cfg != null && cfg.enabled; }

    public void setServer(MinecraftServer s) { this.server = s; }

    public int size() { return bound.size(); }

    /**
     * 服务器启动：白名单模式开 → 打开原版白名单（原版关着的话 checkCanJoin 根本不会拦），
     * 并把已缓存的绑定名单**热加载**进去、落盘。
     */
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
            return;
        }
        syncLive();   // 把启动前推来的名单一次性刷进服务器白名单
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
                saveQuiet(s);
            } catch (Exception ignored) {
            }
        });
    }

    /**
     * 整张绑定名单（本机连接上桥时推来）：**权威整表同步** —— 补上绑定的，
     * 并把"之前由我们加白名单、但现在已解绑"的人收回（只动自己加过的，
     * 管理员手动加的白名单条目不受影响）。即时生效并落盘。
     */
    public void setAll(List<String> names) {
        Set<String> next = new HashSet<>();
        if (names != null) {
            for (String n : names) if (n != null && !n.isBlank()) next.add(n.toLowerCase(Locale.ROOT));
        }
        bound.clear();
        bound.addAll(next);
        syncLive();
    }

    /**
     * 把当前绑定名单整体刷进服务器白名单：先收回已解绑的（仅限本闸门加过的），
     * 再补上绑定的，最后写盘。始终在主线程执行，可安全并发调用。
     */
    private void syncLive() {
        MinecraftServer s = server;
        if (s == null || !enabled()) return;
        s.execute(() -> {
            try {
                for (String key : new ArrayList<>(managed)) {
                    if (!bound.contains(key)) revokeByName(key);
                }
                for (String key : new ArrayList<>(bound)) grantByName(key);
                saveQuiet(s);
            } catch (Exception e) {
                BotState.error("[白名单] 热同步失败: " + e.getMessage());
            }
        });
    }

    /** 把原版白名单落盘（原版增删本来就会存，这里再显式存一次，失败时给条日志） */
    private void saveQuiet(MinecraftServer s) {
        try {
            s.getPlayerManager().getWhitelist().save();
        } catch (Exception e) {
            BotState.error("[白名单] 写入 whitelist.json 失败: " + e.getMessage());
        }
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
     * 接管后的结论。先看缓存，未命中再顺着事件流向本机**实时询问**一次。
     *
     * 注意：这里会阻塞调用它的登录线程最多 {@link #QUERY_TIMEOUT_MS} 毫秒 —— 原版
     * {@code checkCanJoin} 是同步方法，没有异步返回的口子。正常情况本机几毫秒就答，
     * 只有本机没连着/不理人时才会吃满这个上限。
     *
     * @return null = 放行（并已把该玩家补进白名单）；非 null = 用这段文本踢出
     */
    public Text gate(PlayerConfigEntry entry) {
        String name = entry == null ? null : entry.name();
        if (name == null) return kickText();
        String key = name.toLowerCase(Locale.ROOT);
        boolean isBound = bound.contains(key);
        if (!isBound) {
            Boolean live = queryBot(name);
            if (live != null) {
                isBound = live;
                if (live) bound.add(key); else bound.remove(key);
            }
        }
        if (isBound) {
            try {
                MinecraftServer s = server;
                if (s != null && !s.getPlayerManager().getWhitelist().isAllowed(entry)) {
                    s.getPlayerManager().getWhitelist().add(new WhitelistEntry(entry));
                    managed.add(key);
                    BotState.log("🔐 " + name + " 在 QQ 绑定名单内，已加入白名单并放行。");
                }
            } catch (Exception ignored) {
            }
            return null;
        }
        return kickText();
    }

    /**
     * 向本机实时询问"这名玩家在不在绑定名单里"：顺着 SSE 事件流推一条询问，
     * 然后等本机 POST 回答（见 {@link #answer}）。
     *
     * @return 本机的回答；本机没连着、或超时未答，返回 null（调用方回退到缓存判定）
     */
    private Boolean queryBot(String name) {
        McEvents ev = events;
        if (ev == null || ev.streamClients() <= 0) return null;   // 本机没连着，问也白问
        String reqId = UUID.randomUUID().toString().replace("-", "");
        CompletableFuture<Boolean> f = new CompletableFuture<>();
        pending.put(reqId, f);
        try {
            ev.whitelistQuery(name, reqId);
            return f.get(QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            BotState.log("🔐 向 QQ 侧询问 " + name + " 的绑定状态超时，按缓存判定。");
            return null;
        } finally {
            pending.remove(reqId);
        }
    }

    /** 本机（bot）对 {@link #queryBot} 的回答：顺手把缓存校正成最新 */
    public void answer(String reqId, String player, boolean isBound) {
        if (player != null && !player.isBlank()) {
            String key = player.toLowerCase(Locale.ROOT);
            if (isBound) bound.add(key); else bound.remove(key);
        }
        if (reqId == null) return;
        CompletableFuture<Boolean> f = pending.remove(reqId);
        if (f != null) f.complete(isBound);
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
        if (s.getPlayerManager().getWhitelist().isAllowed(entry)) {
            managed.add(name.toLowerCase(Locale.ROOT));
            return;
        }
        s.getPlayerManager().getWhitelist().add(new WhitelistEntry(entry));
        managed.add(name.toLowerCase(Locale.ROOT));
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
        if (s == null || name == null) return;
        managed.remove(name.toLowerCase(Locale.ROOT));
        if (entry == null) return;
        if (s.getPlayerManager().getWhitelist().remove(entry)) {
            BotState.log("🔐 已把 " + name + " 移出服务器白名单（QQ 已解绑）");
        }
    }
}

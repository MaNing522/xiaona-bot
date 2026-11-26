package com.xiaona;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;

import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * carpet 假人（{@code /player <名字> spawn}）的数量限制。
 *
 * <p>规则：非 OP 玩家最多同时拥有 {@code carpet.maxFakePlayersPerPlayer} 个假人（默认 5），
 * OP 和后台不限。服务端**没装 carpet 时整段逻辑不介入**，因为 {@code /player} 命令根本不存在。
 *
 * <p>carpet 不记录"这个假人是谁召唤的"，所以这里自己记账：命令放行时把假人名字记到执行者名下，
 * 每次判定前把已经下线的名字剔掉（假人 leave / 被杀 / 掉线都会从玩家列表消失），
 * 所以名额会被自动回收；服务端重启后假人也不会存活，记账从头开始，不会出现"永久占位"。
 *
 * <p>拦的是所有命令的统一入口（1.21.11 的 {@code CommandManager#parseAndExecute}，
 * 1.21.1/1.21.8 的 {@code executeWithPrefix}），见 {@code mixin/CommandManagerMixin}。
 */
public final class FakePlayerLimit {
    private FakePlayerLimit() {}

    /** 执行者 UUID → 他召唤的假人名字 */
    private static final Map<UUID, Set<String>> OWNED = new ConcurrentHashMap<>();

    private static Config.Carpet cfg;

    public static void init(Config.Carpet carpet) {
        cfg = carpet;
    }

    /**
     * 命令入口调用：返回 true 表示拦下这条命令（并已给执行者发提示），false 表示放行。
     *
     * @param command 不带前导斜杠的原始命令
     */
    public static boolean blocked(MinecraftServer server, ServerCommandSource source, String command) {
        Config.Carpet c = cfg;
        if (c == null || !c.limitFakePlayers) return false;
        if (server == null || source == null || command == null) return false;
        // 没装 carpet：/player 不存在，这个功能整体禁用
        if (!FabricLoader.getInstance().isModLoaded("carpet")) return false;

        String[] tokens = tokenize(command);
        String name = spawnedName(tokens);
        if (name == null) return false;

        ServerPlayerEntity player = source.getPlayer();
        if (player == null) return false;                 // 后台/命令方块不限
        if (Compat.isOp(server, player)) return false;    // OP 不限

        Set<String> owned = OWNED.computeIfAbsent(player.getUuid(), k -> ConcurrentHashMap.newKeySet());
        // 已经下线的假人不再占名额
        owned.removeIf(n -> server.getPlayerManager().getPlayer(n) == null);

        int max = Math.max(1, c.maxFakePlayersPerPlayer);
        if (owned.size() >= max && !owned.contains(name)) {
            player.sendMessage(Text.literal("[小钠] 非 OP 最多同时召唤 " + max + " 个假人，"
                    + "先让一个假人下线（/player <名字> leave）再来。"));
            BotState.log("[假人限制] " + player.getName().getString() + " 想召唤 " + name
                    + "，已有 " + owned.size() + " 个，已拦截。");
            return true;
        }
        owned.add(name);
        return false;
    }

    private static String[] tokenize(String command) {
        String s = command.trim();
        if (s.startsWith("/")) s = s.substring(1).trim();
        return s.isEmpty() ? new String[0] : s.split("\\s+");
    }

    /**
     * 从命令里取出"要 spawn 的假人名字"：直接 {@code player <名> spawn}，
     * 也兼容 {@code execute ... run player <名> spawn} 这种包装写法。
     */
    private static String spawnedName(String[] t) {
        for (int i = 0; i + 2 < t.length; i++) {
            if (!t[i].equalsIgnoreCase("player")) continue;
            // 只有命令开头或 /execute 包装才算，避免 /say player x spawn 这类误伤
            if (i != 0 && !t[0].equalsIgnoreCase("execute")) continue;
            if (t[i + 2].equalsIgnoreCase("spawn")) return t[i + 1];
        }
        return null;
    }
}

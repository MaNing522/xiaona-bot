package com.xiaona;

import net.minecraft.network.packet.s2c.play.ScoreboardDisplayS2CPacket;
import net.minecraft.network.packet.s2c.play.ScoreboardObjectiveUpdateS2CPacket;
import net.minecraft.network.packet.s2c.play.ScoreboardScoreUpdateS2CPacket;
import net.minecraft.scoreboard.Scoreboard;
import net.minecraft.scoreboard.ScoreboardCriterion;
import net.minecraft.scoreboard.ScoreboardDisplaySlot;
import net.minecraft.scoreboard.ScoreboardObjective;
import net.minecraft.scoreboard.number.BlankNumberFormat;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.MutableText;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 未绑定玩家的计分板（侧边栏指引）。
 *
 * 原版计分板的侧边栏槽位是**全服共用**的，没有"只给部分人看"的接口，
 * 所以这里不走 {@code Scoreboard#setObjectiveSlot}，而是自己构造并发送计分板封包，
 * 只发给还没绑定游戏ID的玩家 —— 等于每人一块独立的侧边栏。
 *
 * 谁绑定了游戏ID只有本机（QQ 侧）知道，但服务端不需要整张绑定表：
 * 玩家**上线时**本机回一条"这名玩家是否已绑定"（{@code POST /bridge/bindcheck}），
 * 服务端只为这一名玩家渲染。拿不到答复时按"未绑定"显示 ——
 * 多显示一块提示板，总好过让已绑定的玩家一直看不到引导。
 */
public class BindBoard {
    private static final String OBJECTIVE = "xiaona_bind";
    /** 判定表的玩家数上限（只是为了别无限涨） */
    private static final int MAX_VERDICTS = 500;

    /** 小写玩家名 → 是否已绑定（记着是为了重生后原样恢复） */
    private final Map<String, Boolean> verdict = new ConcurrentHashMap<>();

    /** 桥接群号（本机告知），空 = 文案里不显示群号 */
    private volatile String group = "";

    private volatile MinecraftServer server;
    private volatile ScoreboardObjective objective;

    /**
     * 承载 objective 的"游离"记分板：只用来构造封包，不进服务端记分板。
     * 若把 objective 建在服务端记分板上，它会写进存档并随加入同步给所有人，
     * 重启后同名 objective 已存在 → 构造时直接抛 IllegalArgumentException。
     */
    private final Scoreboard localBoard = new Scoreboard();

    private final Config.Board cfg;

    public BindBoard(Config.Board cfg) {
        this.cfg = cfg;
    }

    public void setServer(MinecraftServer s) {
        this.server = s;
        // 清掉旧版本残留在服务端存档里的同名 objective（它会被同步给全服）
        try {
            ScoreboardObjective old = s.getScoreboard().getNullableObjective(OBJECTIVE);
            if (old != null) s.getScoreboard().removeObjective(old);
        } catch (Exception ignored) {
        }
    }

    /**
     * 本机对某个玩家的判定：只影响这一名玩家。
     * @param bound true = 已绑定（撤掉计分板）；false = 未绑定（显示引导）
     */
    public void checkBound(String player, boolean bound, String group) {
        if (player == null || player.isBlank()) return;
        if (group != null && !group.isBlank()) this.group = group.trim();
        remember(player, bound);
        MinecraftServer s = server;
        if (s == null) return;
        s.execute(() -> {
            try {
                ServerPlayerEntity p = s.getPlayerManager().getPlayer(player);
                if (p == null) return;   // 已经下线了；下次上线会重新判定
                if (bound || !enabled()) hide(p);
                else show(p);
            } catch (Exception ignored) {
            }
        });
    }

    /** 上线先按"未绑定"显示，等本机的答复；答复万一没来，板子上那行提示会告诉玩家重新进服 */
    public void onJoin(ServerPlayerEntity p) {
        if (!enabled()) return;
        show(p);
    }

    /** 重生后按上次判定恢复（客户端重生会重渲染侧边栏）；没有判定就按未绑定显示 */
    public void onRespawn(ServerPlayerEntity p) {
        if (p == null) return;
        if (!enabled()) { hide(p); return; }
        Boolean v = verdict.get(key(p.getName().getString()));
        if (v != null && v) hide(p);
        else show(p);
    }

    private boolean enabled() {
        return cfg != null && cfg.enabled;
    }

    private void remember(String name, boolean bound) {
        String k = key(name);
        if (!verdict.containsKey(k) && verdict.size() >= MAX_VERDICTS) {
            Iterator<String> it = verdict.keySet().iterator();
            if (it.hasNext()) { it.next(); it.remove(); }
        }
        verdict.put(k, bound);
    }

    private String key(String name) {
        return name == null ? "" : name.toLowerCase(Locale.ROOT);
    }

    private void show(ServerPlayerEntity p) {
        if (p == null) return;
        ScoreboardObjective obj = objective();
        List<Text> lines = lines();
        if (obj == null || lines.isEmpty()) return;
        try {
            // 先 REMOVE 再 ADD：客户端对同名 objective 的 ADD 不做判空会直接抛异常
            // （重生/换维度/旧版本残留都可能让客户端已经存在同名 objective），
            // REMOVE 分支客户端是判空后才删，重复发也安全 —— 这样 show() 变成幂等操作
            p.networkHandler.sendPacket(
                    new ScoreboardObjectiveUpdateS2CPacket(obj, ScoreboardObjectiveUpdateS2CPacket.REMOVE_MODE));
            p.networkHandler.sendPacket(
                    new ScoreboardObjectiveUpdateS2CPacket(obj, ScoreboardObjectiveUpdateS2CPacket.ADD_MODE));
            p.networkHandler.sendPacket(new ScoreboardDisplayS2CPacket(ScoreboardDisplaySlot.SIDEBAR, obj));
            int n = lines.size();
            for (int i = 0; i < n; i++) {
                // 行号当"记分 holder"保证唯一，真正的显示文字放 display；
                // 数字格式用空白，才不会在右侧露出分数
                p.networkHandler.sendPacket(new ScoreboardScoreUpdateS2CPacket(
                        "xna_" + i, OBJECTIVE, n - i,
                        Optional.of(lines.get(i)), Optional.of(BlankNumberFormat.INSTANCE)));
            }
        } catch (Exception ignored) {
        }
    }

    private void hide(ServerPlayerEntity p) {
        if (p == null) return;
        try {
            // 传 null = 让客户端把这个槽位清空（只影响这名玩家）
            p.networkHandler.sendPacket(new ScoreboardDisplayS2CPacket(ScoreboardDisplaySlot.SIDEBAR, null));
        } catch (Exception ignored) {
        }
    }

    /** 计分板对象只建一次，且建在游离记分板上 —— 不写存档、不同步给全服 */
    private synchronized ScoreboardObjective objective() {
        ScoreboardObjective o = objective;
        if (o != null) return o;
        try {
            // 先查再建：并发/重复调用时复用已有的，绝不重复创建
            o = localBoard.getNullableObjective(OBJECTIVE);
            if (o == null) {
                o = localBoard.addObjective(OBJECTIVE, ScoreboardCriterion.DUMMY,
                        Text.literal(cfg == null || cfg.title == null ? "小钠 · QQ 绑定" : cfg.title),
                        ScoreboardCriterion.RenderType.INTEGER, false, null);
            }
            objective = o;
        } catch (Exception e) {
            return null;
        }
        return o;
    }

    /** 侧边栏文案（侧边栏最多 15 行，这里 6 行） */
    private List<Text> lines() {
        List<Text> out = new ArrayList<>();
        out.add(Text.literal("你还没有绑定游戏ID").formatted(Formatting.YELLOW));
        out.add(Text.literal(" "));
        String g = group;
        if (g != null && !g.isEmpty()) {
            MutableText l = Text.literal("QQ群：").formatted(Formatting.WHITE);
            l.append(Text.literal(g).formatted(Formatting.AQUA));
            out.add(l);
            MutableText c = Text.literal("发送 ").formatted(Formatting.WHITE);
            c.append(Text.literal("#绑定 <游戏ID>").formatted(Formatting.GREEN));
            out.add(c);
        } else {
            out.add(Text.literal("请进 QQ 群发送 #绑定").formatted(Formatting.WHITE));
            out.add(Text.literal("（群号问服主要）").formatted(Formatting.DARK_GRAY));
        }
        out.add(Text.literal(" "));
        out.add(Text.literal("绑定后可与群里互通聊天").formatted(Formatting.GRAY));
        out.add(Text.literal("若状态未刷新，请重新进服").formatted(Formatting.DARK_GRAY));
        return out;
    }
}
package com.xiaona;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 玩家位置采样（供网页「位置热力图」）。
 *
 * 服务端每 {@code heatmap.sampleSec} 秒在 tick 线程采样一次在线玩家的 X/Z 与维度，
 * 只保留最近 {@code heatmap.retainMin} 分钟的数据；HTTP 线程通过 {@link #snapshot()} 读快照。
 * 数据只在内存里，重启即清空——热力图看的是"最近一段时间大家在哪活动"。
 */
public final class PositionHistory {
    /** 单个采样点：世界坐标（保留 1 位小数）与采样时间 */
    private static final class Sample {
        final double x;
        final double z;
        final long t;

        Sample(double x, double z, long t) {
            this.x = x;
            this.z = z;
            this.t = t;
        }
    }

    private final Object lock = new Object();
    /** key = 玩家名 + 分隔符 + 维度；一个玩家换维度会分成两条线 */
    private final Map<String, Deque<Sample>> hist = new HashMap<>();
    private final int sampleTicks;
    private final long retainMs;
    private final int maxPerSeries;
    /** 用 (char)1 做分隔，避免玩家名/维度里出现同名冲突（也绕开 Java 源码里不能写 NUL 的问题） */
    private static final char SEP = (char) 1;
    private int tick;

    public PositionHistory(int sampleSec, int retainMin, int maxPointsPerPlayer) {
        this.sampleTicks = Math.max(1, sampleSec) * 20;
        this.retainMs = Math.max(1, retainMin) * 60_000L;
        this.maxPerSeries = Math.max(60, maxPointsPerPlayer);
    }

    /** 服务端每个 tick 调用一次；内部按 sampleSec 降频 */
    public void onTick(MinecraftServer server) {
        if (server == null) return;
        if (++tick < sampleTicks) return;
        tick = 0;
        long now = System.currentTimeMillis();
        List<ServerPlayerEntity> players = server.getPlayerManager().getPlayerList();
        if (players.isEmpty()) {
            synchronized (lock) {
                prune(now);
            }
            return;
        }
        synchronized (lock) {
            for (ServerPlayerEntity p : players) {
                try {
                    String dim = Compat.worldOf(p).getRegistryKey().getValue().toString();
                    String key = p.getName().getString() + SEP + dim;
                    Deque<Sample> dq = hist.computeIfAbsent(key, k -> new ArrayDeque<>());
                    dq.addLast(new Sample(round(p.getX()), round(p.getZ()), now));
                    while (dq.size() > maxPerSeries) dq.removeFirst();
                } catch (Exception ignored) {
                    // 玩家正在跨维度/退服时读取位置可能失败，跳过这次采样即可
                }
            }
            prune(now);
        }
    }

    /**
     * HTTP 线程读快照：
     * {@code [{name, dim, pts:[[x,z],...], last:{x,z,t}}, ...]}
     */
    public List<Map<String, Object>> snapshot() {
        long now = System.currentTimeMillis();
        List<Map<String, Object>> out = new ArrayList<>();
        synchronized (lock) {
            prune(now);
            for (Map.Entry<String, Deque<Sample>> e : hist.entrySet()) {
                Deque<Sample> dq = e.getValue();
                if (dq.isEmpty()) continue;
                String key = e.getKey();
                int i = key.indexOf(SEP);
                String name = i < 0 ? key : key.substring(0, i);
                String dim = i < 0 ? "" : key.substring(i + 1);

                List<double[]> pts = new ArrayList<>(dq.size());
                for (Sample s : dq) pts.add(new double[]{s.x, s.z});
                Sample last = dq.peekLast();

                Map<String, Object> o = new LinkedHashMap<>();
                o.put("name", name);
                o.put("dim", dim);
                o.put("pts", pts);
                Map<String, Object> l = new LinkedHashMap<>();
                l.put("x", last.x);
                l.put("z", last.z);
                l.put("t", last.t);
                o.put("last", l);
                out.add(o);
            }
        }
        out.sort(Comparator.comparing(m -> String.valueOf(m.get("name"))));
        return out;
    }

    private void prune(long now) {
        long cutoff = now - retainMs;
        Iterator<Map.Entry<String, Deque<Sample>>> it = hist.entrySet().iterator();
        while (it.hasNext()) {
            Deque<Sample> dq = it.next().getValue();
            while (!dq.isEmpty() && dq.peekFirst().t < cutoff) dq.removeFirst();
            if (dq.isEmpty()) it.remove();
        }
    }

    private static double round(double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}

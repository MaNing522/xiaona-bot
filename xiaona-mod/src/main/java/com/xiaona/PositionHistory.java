package com.xiaona;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 玩家"加载过的区块"记录（网页「位置热力图」）。
 *
 * 不再按固定间隔记点：玩家每踏进一个新区块就记一条 <b>区块坐标</b>（同一区块只保留首次/最近时间），
 * 所以图上看到的是"他加载过哪些区块"，走多少画多少，不是按时间采样的轨迹点。
 * 数据永久保存在 {@code config/xiaona-heatmap.json}（定期落盘 + 停服时落盘），
 * HTTP 线程用 {@link #snapshot(long)} 按时间筛选读取。
 */
public final class PositionHistory {
    /** 一个玩家在某维度的记录：区块 key → [首次时间, 最近时间]，外加最后位置 */
    private static final class Series {
        final Map<Long, long[]> chunks = new HashMap<>();
        double lastX;
        double lastZ;
        long lastT;
    }

    private static final Gson GSON = new Gson();
    private final Object lock = new Object();
    /** 玩家名 → 维度 → 记录 */
    private final Map<String, Map<String, Series>> data = new HashMap<>();
    private final Path file = FabricLoader.getInstance().getConfigDir().resolve("xiaona-heatmap.json");
    private final long saveMs;
    private long lastSave = System.currentTimeMillis();

    public PositionHistory(int saveSec) {
        this.saveMs = Math.max(5, saveSec) * 1000L;
        load();
    }

    /** 服务端每个 tick 调用一次：只在新进入区块时记点，同一区块更新"最近时间" */
    public void onTick(MinecraftServer server) {
        if (server == null) return;
        long now = System.currentTimeMillis();
        List<ServerPlayerEntity> players = server.getPlayerManager().getPlayerList();
        synchronized (lock) {
            for (ServerPlayerEntity p : players) {
                try {
                    String name = p.getName().getString();
                    String dim = Compat.worldOf(p).getRegistryKey().getValue().toString();
                    double x = p.getX();
                    double z = p.getZ();
                    int cx = ((int) Math.floor(x)) >> 4;
                    int cz = ((int) Math.floor(z)) >> 4;
                    long key = key(cx, cz);
                    Series s = data.computeIfAbsent(name, k -> new HashMap<>())
                            .computeIfAbsent(dim, k -> new Series());
                    long[] rec = s.chunks.get(key);
                    if (rec == null) s.chunks.put(key, new long[]{now, now});
                    else rec[1] = now;
                    s.lastX = round(x);
                    s.lastZ = round(z);
                    s.lastT = now;
                } catch (Exception ignored) {
                    // 玩家正在跨维度/退服时读取位置可能失败，跳过这一次即可
                }
            }
        }
        if (now - lastSave >= saveMs) saveNow();
    }

    /** 停服前/定时落盘 */
    public void saveNow() {
        JsonObject root = new JsonObject();
        root.addProperty("version", 1);
        JsonObject players = new JsonObject();
        synchronized (lock) {
            for (Map.Entry<String, Map<String, Series>> pe : data.entrySet()) {
                JsonObject dims = new JsonObject();
                for (Map.Entry<String, Series> de : pe.getValue().entrySet()) {
                    JsonArray arr = new JsonArray();
                    for (Map.Entry<Long, long[]> ce : de.getValue().chunks.entrySet()) {
                        long k = ce.getKey();
                        JsonArray q = new JsonArray();
                        q.add((int) (k >> 32));
                        q.add((int) k);
                        q.add(ce.getValue()[0]);
                        q.add(ce.getValue()[1]);
                        arr.add(q);
                    }
                    dims.add(de.getKey(), arr);
                }
                players.add(pe.getKey(), dims);
            }
        }
        root.add("players", players);
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, GSON.toJson(root), StandardCharsets.UTF_8);
            lastSave = System.currentTimeMillis();
        } catch (Exception ignored) {
            // 写盘失败不影响在线采样，下次再试
        }
    }

    /**
     * HTTP 线程读快照（只返回"最近时间 >= since"的区块）：
     * {@code [{name, dim, pts:[[chunkX,chunkZ],...], last:{x,z,t}}]}
     */
    public List<Map<String, Object>> snapshot(long since) {
        List<Map<String, Object>> out = new ArrayList<>();
        synchronized (lock) {
            for (Map.Entry<String, Map<String, Series>> pe : data.entrySet()) {
                for (Map.Entry<String, Series> de : pe.getValue().entrySet()) {
                    Series s = de.getValue();
                    List<int[]> pts = new ArrayList<>();
                    for (Map.Entry<Long, long[]> ce : s.chunks.entrySet()) {
                        if (ce.getValue()[1] < since) continue;
                        long k = ce.getKey();
                        pts.add(new int[]{(int) (k >> 32), (int) k});
                    }
                    if (pts.isEmpty()) continue;
                    Map<String, Object> o = new LinkedHashMap<>();
                    o.put("name", pe.getKey());
                    o.put("dim", de.getKey());
                    o.put("pts", pts);
                    if (s.lastT > 0) {
                        Map<String, Object> l = new LinkedHashMap<>();
                        l.put("x", s.lastX);
                        l.put("z", s.lastZ);
                        l.put("t", s.lastT);
                        o.put("last", l);
                    }
                    out.add(o);
                }
            }
        }
        out.sort((a, b) -> String.valueOf(a.get("name")).compareTo(String.valueOf(b.get("name"))));
        return out;
    }

    private void load() {
        if (!Files.isRegularFile(file)) return;
        try {
            JsonObject root = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
            JsonElement pj = root.get("players");
            if (pj == null || !pj.isJsonObject()) return;
            for (Map.Entry<String, JsonElement> pe : pj.getAsJsonObject().entrySet()) {
                if (!pe.getValue().isJsonObject()) continue;
                Map<String, Series> dims = new HashMap<>();
                for (Map.Entry<String, JsonElement> de : pe.getValue().getAsJsonObject().entrySet()) {
                    if (!de.getValue().isJsonArray()) continue;
                    Series s = new Series();
                    for (JsonElement it : de.getValue().getAsJsonArray()) {
                        if (!it.isJsonArray()) continue;
                        JsonArray q = it.getAsJsonArray();
                        if (q.size() < 4) continue;
                        s.chunks.put(key(q.get(0).getAsInt(), q.get(1).getAsInt()),
                                new long[]{q.get(2).getAsLong(), q.get(3).getAsLong()});
                    }
                    if (!s.chunks.isEmpty()) dims.put(de.getKey(), s);
                }
                if (!dims.isEmpty()) data.put(pe.getKey(), dims);
            }
        } catch (Exception ignored) {
            // 文件损坏就当没有历史，下一次落盘会覆盖重建
        }
    }

    private static long key(int cx, int cz) {
        return (((long) cx) << 32) | (cz & 0xffffffffL);
    }

    private static double round(double v) {
        return Math.round(v * 10.0) / 10.0;
    }
}

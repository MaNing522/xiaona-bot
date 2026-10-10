package com.xiaona;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 只读查询 GriefLogger 的 SQLite 数据库。
 *
 * GriefLogger 默认把库放在 {@code <游戏目录>/config/grieflogger/database.db}，时间列是 epoch 毫秒。
 * 表结构（1.21.11 实测）：
 *   users(id, name, uuid) / levels(id, name) / materials(id, name) / entities(id, name)
 *   blocks(time, user, level, x, y, z, type, action)              type→materials.id（action=3/4 时是 entities.id）
 *   containers(time, user, level, x, y, z, type, data, amount, action)  type→materials.id
 *
 * action 是整数枚举（不存在 actions 表）：
 *   blocks:     0 BREAK_BLOCK / 1 PLACE_BLOCK / 2 INTERACT_BLOCK / 3 KILL_ENTITY / 4 INTERACT_ENTITY
 *   containers: 0 REMOVE_ITEM / 1 ADD_ITEM / 2 DROP_ITEM / 3 PICKUP_ITEM / 4 CRAFT_ITEM / 5 BREAK_ITEM
 *               6 CONSUME_ITEM / 7 THROW_ITEM / 8 SHOOT_ITEM / 9 ADD_ITEM_ENDER / 10 REMOVE_ITEM_ENDER
 *
 * 这里只跑 SELECT，绝不写库；打开失败才退化成普通连接（GriefLogger 用的是默认 journal，无 WAL）。
 */
public final class GriefQuery {
    /** 单次返回的硬上限，防止本机传个超大 limit 把内存吃满 */
    public static final int HARD_MAX_ROWS = 500;
    /** 时间范围硬上限（天），避免传个离谱的 hours 去扫全库 */
    private static final int MAX_HOURS = 24 * 30;

    private GriefQuery() {}

    /**
     * 查询方块/容器操作记录。
     *
     * @param gameDir 游戏根目录（用于定位默认数据库）
     * @param cfg     Grief 配置段（可为 null）
     * @param player  只查这名玩家（可空 = 全部玩家）
     * @param hours   往回查多少小时（<=0 用默认）
     * @param limit   返回条数上限（<=0 用默认）
     * @return {ok, db, hours, player, total, rows, error}
     */
    public static Map<String, Object> query(Path gameDir, Config.Grief cfg, String player, int hours, int limit) {
        Config.Grief c = cfg == null ? new Config.Grief() : cfg;
        String who = player == null ? "" : player.trim();
        int h = hours > 0 ? Math.min(hours, MAX_HOURS) : Math.max(1, c.defaultHours);
        int lim = limit > 0 ? Math.min(limit, HARD_MAX_ROWS) : Math.max(1, Math.min(c.maxRows, HARD_MAX_ROWS));

        Path db = resolveDb(gameDir, c);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("db", db == null ? "" : db.toString());
        out.put("hours", h);
        out.put("player", who);

        if (db == null || !Files.isRegularFile(db)) {
            out.put("ok", false);
            out.put("total", 0);
            out.put("rows", List.of());
            out.put("error", "未找到 GriefLogger 数据库：" + (db == null ? "?" : db));
            return out;
        }

        long since = System.currentTimeMillis() - (long) h * 3600_000L;
        try (Connection conn = open(db)) {
            List<Map<String, Object>> rows = new ArrayList<>();
            int total = 0;

            // 方块操作
            total += countBlocks(conn, since, who);
            rows.addAll(fetchBlocks(conn, since, who, lim));

            // 容器操作
            total += countContainers(conn, since, who);
            rows.addAll(fetchContainers(conn, since, who, lim));

            rows.sort(Comparator.comparingLong((Map<String, Object> r) -> ((Number) r.get("time")).longValue()).reversed());
            if (rows.size() > lim) rows = new ArrayList<>(rows.subList(0, lim));

            out.put("ok", true);
            out.put("total", total);
            out.put("rows", rows);
            return out;
        } catch (Exception e) {
            out.put("ok", false);
            out.put("total", 0);
            out.put("rows", List.of());
            out.put("error", "读取 GriefLogger 数据库失败：" + e.getClass().getSimpleName()
                    + " " + String.valueOf(e.getMessage()));
            return out;
        }
    }

    /** 解析数据库路径：配置为空时用 GriefLogger 的默认位置 */
    static Path resolveDb(Path gameDir, Config.Grief cfg) {
        if (cfg != null && cfg.dbFile != null && !cfg.dbFile.isBlank()) {
            return Path.of(cfg.dbFile.trim());
        }
        Path base = gameDir == null ? Path.of(".") : gameDir;
        return base.resolve("config").resolve("grieflogger").resolve("database.db");
    }

    /** 只读打开；失败（WAL/权限等）退化为普通连接，但依旧只跑 SELECT */
    private static Connection open(Path db) throws SQLException {
        try {
            Class.forName("org.sqlite.JDBC");
        } catch (Throwable ignored) {
            // 驱动一般由 ServiceLoader 自动注册，这里失败也不影响下面的 getConnection
        }
        try {
            org.sqlite.SQLiteConfig sc = new org.sqlite.SQLiteConfig();
            sc.setReadOnly(true);
            sc.setBusyTimeout(3000);
            return DriverManager.getConnection("jdbc:sqlite:" + db, sc.toProperties());
        } catch (SQLException e) {
            org.sqlite.SQLiteConfig sc = new org.sqlite.SQLiteConfig();
            sc.setBusyTimeout(3000);
            return DriverManager.getConnection("jdbc:sqlite:" + db, sc.toProperties());
        }
    }

    private static int countBlocks(Connection conn, long since, String who) throws SQLException {
        return count(conn, "SELECT COUNT(*) FROM blocks b JOIN users u ON b.user = u.id WHERE b.time >= ?"
                + playerClause(who), since, who);
    }

    private static int countContainers(Connection conn, long since, String who) throws SQLException {
        return count(conn, "SELECT COUNT(*) FROM containers c JOIN users u ON c.user = u.id WHERE c.time >= ?"
                + playerClause(who), since, who);
    }

    private static int count(Connection conn, String sql, long since, String who) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            int i = 1;
            ps.setLong(i++, since);
            if (!who.isBlank()) ps.setString(i, who);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next() ? rs.getInt(1) : 0;
            }
        }
    }

    /** 玩家过滤：大小写不敏感（MC 名字大小写混排，用户输入不该因大小写漏查） */
    private static String playerClause(String who) {
        return who.isBlank() ? "" : " AND u.name = ? COLLATE NOCASE";
    }

    private static List<Map<String, Object>> fetchBlocks(Connection conn, long since, String who, int limit)
            throws SQLException {
        // action=3/4（杀/交互实体）的 type 指向 entities，其余指向 materials
        String sql = "SELECT b.time, u.name, l.name AS level, b.x, b.y, b.z, b.action,"
                + " CASE WHEN b.action = 3 OR b.action = 4 THEN e.name ELSE m.name END AS material"
                + " FROM blocks b"
                + " LEFT JOIN users u ON b.user = u.id"
                + " LEFT JOIN levels l ON b.level = l.id"
                + " LEFT JOIN materials m ON b.type = m.id AND b.action != 3 AND b.action != 4"
                + " LEFT JOIN entities e ON b.type = e.id AND (b.action = 3 OR b.action = 4)"
                + " WHERE b.time >= ?" + playerClause(who)
                + " ORDER BY b.time DESC LIMIT ?";

        List<Map<String, Object>> out = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            int i = 1;
            ps.setLong(i++, since);
            if (!who.isBlank()) ps.setString(i++, who);
            ps.setInt(i, limit);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) out.add(row(rs, "block"));
            }
        } catch (SQLException e) {
            // 老库可能没有 entities 表 → 去掉实体联表再试一次（退化成只取 materials.name）
            String fallback = "SELECT b.time, u.name, l.name AS level, b.x, b.y, b.z, b.action, m.name AS material"
                    + " FROM blocks b"
                    + " LEFT JOIN users u ON b.user = u.id"
                    + " LEFT JOIN levels l ON b.level = l.id"
                    + " LEFT JOIN materials m ON b.type = m.id"
                    + " WHERE b.time >= ?" + playerClause(who)
                    + " ORDER BY b.time DESC LIMIT ?";
            try (PreparedStatement ps = conn.prepareStatement(fallback)) {
                int i = 1;
                ps.setLong(i++, since);
                if (!who.isBlank()) ps.setString(i++, who);
                ps.setInt(i, limit);
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) out.add(row(rs, "block"));
                }
            }
        }
        return out;
    }

    private static List<Map<String, Object>> fetchContainers(Connection conn, long since, String who, int limit)
            throws SQLException {
        String sql = "SELECT c.time, u.name, l.name AS level, c.x, c.y, c.z, c.action, m.name AS material, c.amount"
                + " FROM containers c"
                + " LEFT JOIN users u ON c.user = u.id"
                + " LEFT JOIN levels l ON c.level = l.id"
                + " LEFT JOIN materials m ON c.type = m.id"
                + " WHERE c.time >= ?" + playerClause(who)
                + " ORDER BY c.time DESC LIMIT ?";

        List<Map<String, Object>> out = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            int i = 1;
            ps.setLong(i++, since);
            if (!who.isBlank()) ps.setString(i++, who);
            ps.setInt(i, limit);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) out.add(row(rs, "container"));
            }
        }
        return out;
    }

    private static Map<String, Object> row(ResultSet rs, String kind) throws SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("time", rs.getLong("time"));
        m.put("player", rs.getString("name"));
        m.put("level", rs.getString("level"));
        m.put("x", rs.getInt("x"));
        m.put("y", rs.getInt("y"));
        m.put("z", rs.getInt("z"));
        m.put("kind", kind);
        m.put("actionId", rs.getInt("action"));
        m.put("material", rs.getString("material"));
        if ("container".equals(kind)) m.put("amount", rs.getInt("amount"));
        return m;
    }
}
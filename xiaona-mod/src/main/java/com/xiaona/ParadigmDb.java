package com.xiaona;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 只读读取 Paradigm 的封禁库。
 *
 * <p>用文档提供的视图 {@code paradigm_v_active_bans}，以 {@code mode=ro} 打开，
 * 绝不在 Paradigm 的库里写任何东西（写入统一走它的 /ban、/unban 命令）。
 */
final class ParadigmDb {
    private static final String SQL = "SELECT type, player_name, player_uuid, reason, actor, "
            + "created_at_ms, expires_at_ms FROM paradigm_v_active_bans ORDER BY created_at_ms DESC";

    private ParadigmDb() {}

    static List<BanProvider.BanRow> readActive(Path db) {
        if (db == null || !Files.isRegularFile(db)) {
            throw new BanException("找不到 Paradigm 数据库：" + (db == null ? "(未配置)" : db)
                    + "（确认 Paradigm 使用 sqlite 存储，且服务器至少启动过一次）");
        }
        try {
            Class.forName("org.sqlite.JDBC");
        } catch (ClassNotFoundException e) {
            throw new BanException("mod 内缺少 SQLite 驱动，无法读取 Paradigm 封禁库", e);
        }

        String url = "jdbc:sqlite:" + db.toAbsolutePath().toUri() + "?mode=ro";
        List<BanProvider.BanRow> rows = new ArrayList<>();
        try (Connection c = DriverManager.getConnection(url)) {
            try (Statement st = c.createStatement()) {
                st.execute("PRAGMA busy_timeout=2000");
                st.execute("PRAGMA query_only=true");
            }
            try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(SQL)) {
                Set<String> seen = new HashSet<>();
                while (rs.next()) {
                    String name = trim(rs.getString("player_name"));
                    // 空名字是 IP 封禁一类的记录，当前网页/机器人按玩家名展示，跳过
                    if (name.isEmpty()) continue;
                    if (!seen.add(name.toLowerCase(Locale.ROOT))) continue; // 同一玩家多条生效记录只留最新
                    rows.add(new BanProvider.BanRow(
                            name,
                            trim(rs.getString("player_uuid")),
                            trim(rs.getString("reason")),
                            trim(rs.getString("actor")),
                            longOf(rs, "created_at_ms"),
                            longOf(rs, "expires_at_ms")));
                }
            }
        } catch (SQLException e) {
            String msg = String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT);
            if (msg.contains("no such table") || msg.contains("no such view")) {
                throw new BanException("Paradigm 数据库里没有 paradigm_v_active_bans 视图"
                        + "（Paradigm 版本过旧？），无法读取封禁列表", e);
            }
            throw new BanException("读取 Paradigm 封禁库失败：" + e.getMessage(), e);
        }
        return rows;
    }

    private static String trim(String s) {
        return s == null ? "" : s.trim();
    }

    /** 0 = 永久（Paradigm 用 null 或 0 表示不过期） */
    private static long longOf(ResultSet rs, String col) throws SQLException {
        long v = rs.getLong(col);
        return rs.wasNull() ? 0 : v;
    }
}

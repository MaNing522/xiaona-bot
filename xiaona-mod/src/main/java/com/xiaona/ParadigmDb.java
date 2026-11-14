package com.xiaona;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 只读读取 Paradigm 的封禁库。
 *
 * <p>用文档提供的视图 {@code paradigm_v_active_bans}，以 {@code mode=ro} 打开，
 * 绝不在 Paradigm 的库里写任何东西（写入统一走它的 /ban、/unban 命令）。
 *
 * <p>字段名按 Paradigm 2.x 的实际视图（{@code paradigm_v_punishments_public}）取：
 * 类型列是 {@code punishment_type}、执行者是 {@code actor_name}，
 * 不是老版本误用的 {@code type} / {@code actor}。
 */
final class ParadigmDb {
    private static final String SQL_ACTIVE = "SELECT punishment_id, punishment_type, status, player_name, player_uuid, reason, actor_name, "
            + "created_at_ms, expires_at_ms, revoked_at_ms FROM paradigm_v_active_bans ORDER BY created_at_ms DESC";
    private static final String SQL_HISTORY = "SELECT punishment_id, punishment_type, status, player_name, player_uuid, reason, actor_name, "
            + "created_at_ms, expires_at_ms, revoked_at_ms FROM paradigm_v_punishments_public ORDER BY created_at_ms DESC LIMIT ?";

    private ParadigmDb() {}

    /** 生效中的封禁（喂给机器人做复核/白名单一类的判断） */
    static List<BanProvider.BanRow> readActive(Path db) {
        return read(db, SQL_ACTIVE, 0);
    }

    /** 惩罚历史（含已过期/已撤销），给网页「惩罚历史」用 */
    static List<BanProvider.BanRow> readHistory(Path db, int limit) {
        return read(db, SQL_HISTORY, Math.max(1, Math.min(limit, 500)));
    }

    private static List<BanProvider.BanRow> read(Path db, String sql, int limit) {
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
            try (var ps = c.prepareStatement(sql)) {
                if (limit > 0) ps.setInt(1, limit);
                try (ResultSet rs = ps.executeQuery()) {
                    while (rs.next()) {
                        rows.add(new BanProvider.BanRow(
                                trim(rs.getString("punishment_id")),
                                trim(rs.getString("punishment_type")),
                                trim(rs.getString("status")),
                                trim(rs.getString("player_name")),
                                trim(rs.getString("player_uuid")),
                                trim(rs.getString("reason")),
                                trim(rs.getString("actor_name")),
                                longOf(rs, "created_at_ms"),
                                longOf(rs, "expires_at_ms"),
                                longOf(rs, "revoked_at_ms")));
                    }
                }
            }
        } catch (SQLException e) {
            String msg = String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT);
            if (msg.contains("no such table") || msg.contains("no such view")) {
                throw new BanException("Paradigm 数据库里没有惩罚视图（Paradigm 版本过旧？），无法读取名单", e);
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


package com.xiaona;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** 用临时 SQLite 库验证 Paradigm 惩罚视图的只读映射。 */
public class ParadigmDbTest {
    @TempDir
    Path tmp;

    private Path db() {
        return tmp.resolve("paradigm.db");
    }

    private void exec(Path db, String... sqls) throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + db);
             Statement st = c.createStatement()) {
            for (String sql : sqls) st.execute(sql);
        }
    }

    private void createView(Path db) throws Exception {
        // 按 Paradigm 2.x 的真实列名建：类型是 punishment_type，执行者是 actor_name，撤销时间是 revoked_at_ms
        exec(db,
                "CREATE TABLE moderation_punishment_ledger (" +
                        "punishment_id TEXT, punishment_type TEXT, status TEXT, scope TEXT, " +
                        "player_uuid TEXT, player_name TEXT, reason TEXT, actor_name TEXT, " +
                        "created_at_ms INTEGER, expires_at_ms INTEGER, revoked_at_ms INTEGER)",
                "CREATE VIEW paradigm_v_punishments_public AS SELECT punishment_id, punishment_type, status, scope, " +
                        "player_uuid, player_name, reason, actor_name, created_at_ms, expires_at_ms, revoked_at_ms " +
                        "FROM moderation_punishment_ledger",
                "CREATE VIEW paradigm_v_active_bans AS SELECT * FROM paradigm_v_punishments_public " +
                        "WHERE punishment_type = 'BAN' AND status = 'ACTIVE'");
    }

    @Test
    public void 读取生效中的封禁并带上惩罚ID与类型() throws Exception {
        createView(db());
        exec(db(),
                "INSERT INTO moderation_punishment_ledger VALUES ('P-1','BAN','ACTIVE','player','uuid-1','Steve','外挂','Console',1000,NULL,NULL)",
                "INSERT INTO moderation_punishment_ledger VALUES ('P-2','BAN','ACTIVE','player','uuid-2','Alex','刷屏','Admin',3000,9999999999999,NULL)",
                "INSERT INTO moderation_punishment_ledger VALUES ('P-5','MUTE','ACTIVE','player','uuid-3','Herobrine','禁言','Admin',4000,NULL,NULL)");

        List<BanProvider.BanRow> rows = ParadigmDb.readActive(db());
        assertEquals(2, rows.size(), "MUTE 不算封禁");

        assertEquals("Alex", rows.get(0).name());
        assertEquals("P-2", rows.get(0).id());
        assertEquals("BAN", rows.get(0).type());
        assertEquals("ACTIVE", rows.get(0).status());
        assertEquals("刷屏", rows.get(0).reason());
        assertEquals("Admin", rows.get(0).source());
        assertEquals(3000, rows.get(0).created());
        assertEquals(9999999999999L, rows.get(0).expires());

        assertEquals("Steve", rows.get(1).name());
        assertEquals(0, rows.get(1).expires(), "null 过期时间 = 永久");
    }

    @Test
    public void 惩罚历史包含已撤销与禁言() throws Exception {
        createView(db());
        exec(db(),
                "INSERT INTO moderation_punishment_ledger VALUES ('P-1','BAN','ACTIVE','player','uuid-1','Steve','外挂','Console',1000,NULL,NULL)",
                "INSERT INTO moderation_punishment_ledger VALUES ('P-3','BAN','REVOKED','player','uuid-3','Herobrine','误封','Admin',2000,NULL,5000)",
                "INSERT INTO moderation_punishment_ledger VALUES ('P-5','MUTE','ACTIVE','player','uuid-3','Herobrine','禁言','Admin',4000,NULL,NULL)");

        List<BanProvider.BanRow> rows = ParadigmDb.readHistory(db(), 50);
        assertEquals(3, rows.size(), "历史里禁言和已撤销都要在");
        assertEquals("P-5", rows.get(0).id());
        assertEquals("MUTE", rows.get(0).type());
        assertEquals("P-3", rows.get(1).id());
        assertEquals("REVOKED", rows.get(1).status());
        assertEquals(5000, rows.get(1).revokedAt());
    }

    @Test
    public void 数据库不存在时报清楚路径() {
        BanException e = assertThrows(BanException.class, () -> ParadigmDb.readActive(db()));
        assertTrue(e.getMessage().contains("找不到 Paradigm 数据库"), e.getMessage());
    }

    @Test
    public void 缺视图时提示版本过旧() throws Exception {
        exec(db(), "CREATE TABLE something (id INTEGER)");
        BanException e = assertThrows(BanException.class, () -> ParadigmDb.readActive(db()));
        assertTrue(e.getMessage().contains("惩罚视图"), e.getMessage());
    }
}


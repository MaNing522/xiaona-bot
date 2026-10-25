package com.xiaona;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** 用临时 SQLite 库验证 paradigm_v_active_bans 的只读映射。 */
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
        exec(db,
                "CREATE TABLE bans (punishment_id TEXT, type TEXT, status TEXT, scope TEXT, " +
                        "player_uuid TEXT, player_name TEXT, reason TEXT, actor TEXT, " +
                        "created_at_ms INTEGER, expires_at_ms INTEGER)",
                "CREATE VIEW paradigm_v_active_bans AS SELECT * FROM bans WHERE status = 'ACTIVE'");
    }

    @Test
    public void 读取永久与临时封禁并跳过空名字和重复玩家() throws Exception {
        createView(db());
        exec(db(),
                "INSERT INTO bans VALUES ('p1','ban','ACTIVE','player','uuid-1','Steve','外挂','Console',1000,NULL)",
                "INSERT INTO bans VALUES ('p2','tempban','ACTIVE','player','uuid-2','Alex','刷屏','Admin',3000,9999999999999)",
                "INSERT INTO bans VALUES ('p3','ipban','ACTIVE','ip',NULL,NULL,'攻击','Console',2000,NULL)",
                "INSERT INTO bans VALUES ('p4','ban','ACTIVE','player','uuid-1','Steve','旧记录','Console',500,NULL)");

        List<BanProvider.BanRow> rows = ParadigmDb.readActive(db());
        assertEquals(2, rows.size(), "IP 封禁（空名字）跳过，同一玩家只留最新一条");
        assertEquals("Alex", rows.get(0).name());
        assertEquals("刷屏", rows.get(0).reason());
        assertEquals("Admin", rows.get(0).source());
        assertEquals(3000, rows.get(0).created());
        assertEquals(9999999999999L, rows.get(0).expires());

        assertEquals("Steve", rows.get(1).name());
        assertEquals(0, rows.get(1).expires(), "null 过期时间 = 永久");
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
        assertTrue(e.getMessage().contains("paradigm_v_active_bans"), e.getMessage());
    }
}

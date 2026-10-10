package com.xiaona;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** 直接读 GriefLogger SQLite 数据库的查询逻辑（用临时库建表插数验证 SQL）。 */
public class GriefQueryTest {

    private static Path createDb(Path root) throws Exception {
        Path dir = root.resolve("config").resolve("grieflogger");
        Files.createDirectories(dir);
        Path db = dir.resolve("database.db");
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + db);
             Statement st = c.createStatement()) {
            st.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, uuid TEXT DEFAULT NULL UNIQUE)");
            st.execute("CREATE TABLE levels(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)");
            st.execute("CREATE TABLE materials(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)");
            st.execute("CREATE TABLE entities(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)");
            st.execute("CREATE TABLE blocks(time bigint NOT NULL, user integer NOT NULL, level integer NOT NULL,"
                    + " x integer NOT NULL, y integer NOT NULL, z integer NOT NULL,"
                    + " type integer NOT NULL, action integer NOT NULL)");
            st.execute("CREATE TABLE containers(time bigint NOT NULL, user integer NOT NULL, level integer NOT NULL,"
                    + " x integer NOT NULL, y integer NOT NULL, z integer NOT NULL, type integer NOT NULL,"
                    + " data blob DEFAULT NULL, amount integer NOT NULL, action integer NOT NULL)");
            st.execute("INSERT INTO users(id, name, uuid) VALUES(1, 'Steve', 'u1'), (2, 'Alex', 'u2')");
            st.execute("INSERT INTO levels(id, name) VALUES(1, 'minecraft:overworld')");
            st.execute("INSERT INTO materials(id, name) VALUES(1, 'stone'), (2, 'diamond')");
            st.execute("INSERT INTO entities(id, name) VALUES(1, 'zombie')");
            long now = System.currentTimeMillis();
            // Steve 挖石头（BREAK_BLOCK=0）
            st.execute("INSERT INTO blocks(time, user, level, x, y, z, type, action) VALUES("
                    + now + ", 1, 1, 10, 64, 20, 1, 0)");
            // Alex 杀僵尸（KILL_ENTITY=3，type 指向 entities）
            st.execute("INSERT INTO blocks(time, user, level, x, y, z, type, action) VALUES("
                    + (now - 1000) + ", 2, 1, 11, 64, 21, 1, 3)");
            // Steve 拿走钻石（REMOVE_ITEM=0）
            st.execute("INSERT INTO containers(time, user, level, x, y, z, type, amount, action) VALUES("
                    + (now - 2000) + ", 1, 1, 12, 64, 22, 2, 3, 0)");
            // 很久以前的一条（应在 24h 窗口外）
            st.execute("INSERT INTO blocks(time, user, level, x, y, z, type, action) VALUES("
                    + (now - 48L * 3600_000L) + ", 1, 1, 1, 2, 3, 1, 0)");
        }
        return root;
    }

    @Test
    public void testQueryAllWithinWindow() throws Exception {
        Path root = createDb(Files.createTempDirectory("gl-query"));
        Config.Grief cfg = new Config.Grief();
        Map<String, Object> r = GriefQuery.query(root, cfg, "", 24, 50);

        assertTrue((Boolean) r.get("ok"), String.valueOf(r.get("error")));
        assertEquals(3, r.get("total"));            // 48 小时前那条被排除
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) r.get("rows");
        assertEquals(3, rows.size());
        // 时间倒序：最新一条是 Steve 挖石头
        assertEquals("Steve", rows.get(0).get("player"));
        assertEquals("stone", rows.get(0).get("material"));
        assertEquals("block", rows.get(0).get("kind"));
        assertEquals(0, rows.get(0).get("actionId"));
        // 杀实体那条 material 应来自 entities 表
        Map<String, Object> kill = rows.stream().filter(x -> "Alex".equals(x.get("player"))).findFirst().orElseThrow();
        assertEquals("zombie", kill.get("material"));
        assertEquals(3, kill.get("actionId"));
        // 容器那条应带 amount
        Map<String, Object> cont = rows.stream().filter(x -> "container".equals(x.get("kind"))).findFirst().orElseThrow();
        assertEquals(3, cont.get("amount"));
        assertEquals("diamond", cont.get("material"));
    }

    @Test
    public void testPlayerFilterIsCaseInsensitive() throws Exception {
        Path root = createDb(Files.createTempDirectory("gl-query2"));
        Config.Grief cfg = new Config.Grief();
        Map<String, Object> r = GriefQuery.query(root, cfg, "steve", 24, 50);

        assertTrue((Boolean) r.get("ok"), String.valueOf(r.get("error")));
        assertEquals(2, r.get("total"));            // Steve 的方块 + 容器各一条
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) r.get("rows");
        assertTrue(rows.stream().allMatch(x -> "Steve".equals(x.get("player"))));
    }

    @Test
    public void testLimitAndMissingDb() throws Exception {
        Path root = createDb(Files.createTempDirectory("gl-query3"));
        Config.Grief cfg = new Config.Grief();
        Map<String, Object> r = GriefQuery.query(root, cfg, "", 24, 1);
        assertEquals(3, r.get("total"));            // total 仍是窗口内总数
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rows = (List<Map<String, Object>>) r.get("rows");
        assertEquals(1, rows.size());               // 但只回 1 条

        // 库里没有配置文件时 → 明确的失败信息，而不是抛异常
        Map<String, Object> miss = GriefQuery.query(Files.createTempDirectory("gl-none"), cfg, "", 24, 50);
        assertFalse((Boolean) miss.get("ok"));
        assertNotNull(miss.get("error"));
    }

    @Test
    public void testCustomDbFile() throws Exception {
        Path root = Files.createTempDirectory("gl-custom");
        Path other = Files.createTempDirectory("gl-elsewhere");
        createDb(other);
        Config.Grief cfg = new Config.Grief();
        cfg.dbFile = other.resolve("config").resolve("grieflogger").resolve("database.db").toString();
        Map<String, Object> r = GriefQuery.query(root, cfg, "", 24, 50);
        assertTrue((Boolean) r.get("ok"), String.valueOf(r.get("error")));
        assertEquals(3, r.get("total"));
    }
}
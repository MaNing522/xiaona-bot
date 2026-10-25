package com.xiaona;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

/** Paradigm 存储配置解析与封禁命令拼接（纯函数，不需要 Minecraft）。 */
public class ParadigmStorageTest {
    @TempDir
    Path tmp;

    /** 模拟游戏目录下的 config */
    private Path configDir() {
        return tmp.resolve("config");
    }

    private void storage(String json) throws Exception {
        Path dir = configDir().resolve("paradigm");
        Files.createDirectories(dir);
        Files.writeString(dir.resolve("storage.json"), json, StandardCharsets.UTF_8);
    }

    @Test
    public void 没有配置文件时按默认sqlite和默认库路径() {
        assertEquals("sqlite", ParadigmStorage.provider(configDir()));
        assertEquals(configDir().resolve("paradigm").resolve("data").resolve("paradigm.db").normalize(),
                ParadigmStorage.dbPath(configDir(), "sqlite"));
    }

    @Test
    public void 识别sqlite与相对库路径() throws Exception {
        storage("{\"provider\":\"sqlite\",\"sqlite\":{\"path\":\"data/paradigm.db\"}}");
        assertEquals("sqlite", ParadigmStorage.provider(configDir()));
        assertEquals(configDir().resolve("paradigm").resolve("data").resolve("paradigm.db").normalize(),
                ParadigmStorage.dbPath(configDir(), "sqlite"));
    }

    @Test
    public void 识别嵌套的sqlite配置与绝对路径() throws Exception {
        Path abs = tmp.resolve("bans.sqlite").toAbsolutePath();
        storage("{\"storage\":{\"type\":\"sqlite\",\"sqlite\":{\"file\":\"" + abs.toString().replace("\\", "\\\\")
                + "\"}}}");
        assertEquals("sqlite", ParadigmStorage.provider(configDir()));
        assertEquals(abs.normalize(), ParadigmStorage.dbPath(configDir(), "sqlite"));
    }

    @Test
    public void 支持config开头的库路径() throws Exception {
        storage("{\"provider\":\"sqlite\",\"database\":\"config/paradigm/data/other.db\"}");
        assertEquals(configDir().resolve("paradigm").resolve("data").resolve("other.db").normalize(),
                ParadigmStorage.dbPath(configDir(), "sqlite"));
    }

    @Test
    public void json或mysql后端明确报错而不回退原版() throws Exception {
        storage("{\"provider\":\"json\"}");
        assertEquals("json", ParadigmStorage.provider(configDir()));
        BanException e = assertThrows(BanException.class, () -> ParadigmStorage.dbPath(configDir(), "json"));
        assertTrue(e.getMessage().contains("只支持 sqlite"), e.getMessage());

        storage("{\"provider\":\"mysql\"}");
        assertEquals("mysql", ParadigmStorage.provider(configDir()));
        assertThrows(BanException.class, () -> ParadigmStorage.dbPath(configDir(), "mysql"));
    }

    @Test
    public void 封禁命令不带引号并压成一行() {
        assertEquals("ban Steve", BanCommandRunner.banCommand("Steve", ""));
        assertEquals("ban Steve 使用外挂 换行", BanCommandRunner.banCommand("Steve", " 使用外挂 \n换行\t"));
        assertEquals("unban Steve", BanCommandRunner.unbanCommand("Steve"));
        assertEquals("pardon Steve", BanCommandRunner.pardonCommand("Steve"));
    }

    @Test
    public void 原因超长会被截断到100字() {
        String reason = "x".repeat(150);
        assertEquals(100, BanCommandRunner.cleanReason(reason).length());
    }
}

package com.xiaona;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

public class ConfigTest {
    /** 首次加载会生成默认 config.json，且默认值正确 */
    @Test
    public void testLoadCreatesDefaultFile() throws Exception {
        Path dir = Files.createTempDirectory("cfg-test");
        Config c = Config.load(dir);
        assertTrue(Files.exists(dir.resolve("config.json")));
        assertNotNull(c.bridge);
        assertNotNull(c.http);
        assertEquals(43733, c.http.sharePort);
        assertEquals("xn", c.bridge.privateCommand);
        assertEquals("gold", c.bridge.prefixColor);
        assertTrue(c.bridge.enabled);
        String raw = Files.readString(dir.resolve("config.json"), StandardCharsets.UTF_8);
        assertTrue(raw.contains("\"bridge\""));
        assertTrue(raw.contains("\"sharePort\": 43733"));
    }

    /** 修改字段后 save 写回，重新读取应拿到新值 */
    @Test
    public void testSaveRoundTrip() throws Exception {
        Path dir = Files.createTempDirectory("cfg-test2");
        Config c = Config.load(dir);

        c.bridge.secret = "0123456789abcdef0123456789abcdef";
        c.bridge.allowFrom = List.of("1.2.3.4");
        c.bridge.chatPrefix = "[MC2]";
        c.bridge.privateCommand = "ask";
        c.bridge.maxStreamClients = 2;
        c.bridge.rateLimitPerMinute = 30;
        c.http.port = 9090;
        c.save(dir);

        Config re = Config.load(dir);
        assertEquals("0123456789abcdef0123456789abcdef", re.bridge.secret);
        assertEquals(List.of("1.2.3.4"), re.bridge.allowFrom);
        assertEquals("[MC2]", re.bridge.chatPrefix);
        assertEquals("ask", re.bridge.privateCommand);
        assertEquals(2, re.bridge.maxStreamClients);
        assertEquals(30, re.bridge.rateLimitPerMinute);
        assertEquals(9090, re.http.port);
    }

    /** 空的私聊命令会回退为默认 xn，不落盘非法值 */
    @Test
    public void testBadPrivateCommandFallsBack() throws Exception {
        Path dir = Files.createTempDirectory("cfg-test3");
        Config c = Config.load(dir);
        c.bridge.privateCommand = "   ";
        c.save(dir);
        assertEquals("xn", c.bridge.privateCommand);
        assertEquals("xn", Config.load(dir).bridge.privateCommand);
    }

    /** json 中显式 null 不会导致 NPE，越界数值会被纠正 */
    @Test
    public void testNullSectionsAreRepaired() throws Exception {
        Path dir = Files.createTempDirectory("cfg-test4");
        Files.writeString(dir.resolve("config.json"),
                "{\"bridge\":null,\"http\":null}", StandardCharsets.UTF_8);
        Config c = Config.load(dir);
        assertNotNull(c.bridge);
        assertNotNull(c.http);
        assertNotNull(c.bridge.allowFrom);
        assertEquals("", c.bridge.secret);
        assertEquals("xn", c.bridge.privateCommand);

        // 非法数值被纠正
        Config c2 = new Config();
        c2.bridge.timestampWindowSec = 1;
        c2.bridge.queueSize = 0;
        c2.bridge.maxStreamClients = 0;
        c2.http.port = 0;
        c2.save(dir);
        Config re = Config.load(dir);
        assertEquals(300, re.bridge.timestampWindowSec);
        assertEquals(200, re.bridge.queueSize);
        assertEquals(4, re.bridge.maxStreamClients);
        assertEquals(8080, re.http.port);
    }

    /** secret 太短必须被判为不合格（桥要 fail-closed） */
    @Test
    public void testSecretValidation() {
        Config c = new Config();

        c.bridge.secret = "";
        assertFalse(new BridgeAuth(c.bridge).secretValid());

        c.bridge.secret = "short";
        assertFalse(new BridgeAuth(c.bridge).secretValid());

        c.bridge.secret = "0123456789abcdef0123456789abcdef"; // 32 位
        assertTrue(new BridgeAuth(c.bridge).secretValid());
    }
}
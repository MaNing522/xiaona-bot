package com.xiaona;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Simple Voice Chat 端口适配的纯文件逻辑：改 port、关 query，且不破坏其他配置行。 */
public class VoiceChatCompatTest {

    @Test
    public void testCreatesConfigWhenMissing(@TempDir Path dir) throws Exception {
        Path f = dir.resolve("voicechat").resolve("voicechat-server.properties");
        assertTrue(VoiceChatCompat.applyVoicePort(f, 43733), "配置不存在时应创建并写入");
        assertEquals(List.of("port=43733"), Files.readAllLines(f, StandardCharsets.UTF_8));
    }

    @Test
    public void testRewritesPortKeepingOtherLines(@TempDir Path dir) throws Exception {
        Path f = dir.resolve("voicechat-server.properties");
        Files.write(f, List.of(
                "# Simple Voice Chat 配置",
                "port=24454",
                "bind_address=",
                "voice_host=",
                "max_voice_distance=48"), StandardCharsets.UTF_8);

        assertTrue(VoiceChatCompat.applyVoicePort(f, 25565));
        List<String> out = Files.readAllLines(f, StandardCharsets.UTF_8);
        assertEquals("port=25565", out.get(1));
        assertEquals("# Simple Voice Chat 配置", out.get(0));
        assertEquals("bind_address=", out.get(2));
        assertEquals("voice_host=", out.get(3));
        assertEquals("max_voice_distance=48", out.get(4));
    }

    @Test
    public void testNoChangeWhenAlreadyCorrect(@TempDir Path dir) throws Exception {
        Path f = dir.resolve("voicechat-server.properties");
        Files.write(f, List.of("port=43733", "bind_address="), StandardCharsets.UTF_8);
        assertFalse(VoiceChatCompat.applyVoicePort(f, 43733), "端口已正确时不应改动");
        assertEquals(List.of("port=43733", "bind_address="), Files.readAllLines(f, StandardCharsets.UTF_8));
    }

    @Test
    public void testIgnoresCommentedPortLine(@TempDir Path dir) throws Exception {
        Path f = dir.resolve("voicechat-server.properties");
        Files.write(f, List.of("#port=24454"), StandardCharsets.UTF_8);
        assertTrue(VoiceChatCompat.applyVoicePort(f, 43733));
        List<String> out = Files.readAllLines(f, StandardCharsets.UTF_8);
        assertEquals("#port=24454", out.get(0), "注释行不应被当成有效配置");
        assertEquals("port=43733", out.get(1));
    }

    @Test
    public void testDisableQuery(@TempDir Path dir) throws Exception {
        Path f = dir.resolve("server.properties");
        Files.write(f, List.of("motd=hi", "enable-query=true", "query.port=25565"), StandardCharsets.UTF_8);
        assertTrue(VoiceChatCompat.disableQuery(f));
        List<String> out = Files.readAllLines(f, StandardCharsets.UTF_8);
        assertEquals("enable-query=false", out.get(1));
        assertEquals("motd=hi", out.get(0));
        assertEquals("query.port=25565", out.get(2));

        assertFalse(VoiceChatCompat.disableQuery(f), "已是 false 时不应再改动");
    }

    @Test
    public void testDisableQueryMissingFile(@TempDir Path dir) throws Exception {
        assertFalse(VoiceChatCompat.disableQuery(dir.resolve("server.properties")));
    }
}

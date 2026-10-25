package com.xiaona;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Plan 存在性/探活与 60 秒缓存。 */
public class PlanAvailabilityTest {
    private static HttpServer server(int code) throws IOException {
        HttpServer s = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        s.createContext("/v1/server", ex -> {
            byte[] b = "{}".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(code, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        s.start();
        return s;
    }

    private static Config.Plan cfg(int port, boolean enabled) {
        Config.Plan c = new Config.Plan();
        c.enabled = enabled;
        c.url = "http://127.0.0.1:" + port;
        c.timeoutMs = 800;
        return c;
    }

    @Test
    public void 面板200或401都算在线() throws Exception {
        HttpServer s = server(200);
        try {
            assertTrue(new PlanAvailability(cfg(s.getAddress().getPort(), true), false).available());
        } finally {
            s.stop(0);
        }

        HttpServer s401 = server(401);
        try {
            assertTrue(new PlanAvailability(cfg(s401.getAddress().getPort(), true), false).available());
        } finally {
            s401.stop(0);
        }
    }

    @Test
    public void 连不上面板则禁用() throws Exception {
        HttpServer s = server(200);
        int port = s.getAddress().getPort();
        s.stop(0);
        PlanAvailability p = new PlanAvailability(cfg(port, true), false);
        assertFalse(p.available());
        Map<String, Object> st = p.status();
        assertEquals(false, st.get("available"));
        assertTrue(String.valueOf(st.get("reason")).contains("连不上"), String.valueOf(st.get("reason")));
    }

    @Test
    public void plan开关关闭时始终禁用() {
        PlanAvailability p = new PlanAvailability(cfg(1, false), true);
        assertFalse(p.available());
        assertTrue(String.valueOf(p.status().get("reason")).contains("plan.enabled=false"));
    }

    @Test
    public void mod已加载时不发请求直接可用() {
        // 端口 1 上没有服务；如果它真去探活会失败，借此证明 modLoaded 时走的是短路
        PlanAvailability p = new PlanAvailability(cfg(1, true), true);
        assertTrue(p.available());
        assertEquals(true, p.status().get("modLoaded"));
    }

    @Test
    public void 探活结果缓存60秒() throws Exception {
        HttpServer s = server(200);
        PlanAvailability p = new PlanAvailability(cfg(s.getAddress().getPort(), true), false);
        assertTrue(p.available());
        s.stop(0);   // 面板关掉后，缓存期内仍按上次结果
        assertTrue(p.available());
    }
}

package com.xiaona;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 端口复用：同一端口上按首字节区分协议并分流。
 * - 明文 HTTP（GET/POST/HEAD/...） → 网页控制面板（GUI）
 * - 其他（Minecraft 握手包：长度 varint + 包ID 0x00） → MC 服务器，正常进服游玩
 */
public class PortMux {
    /** 嗅探超时：客户端连上后多久内未发数据则断开 */
    private static final int SNIFF_TIMEOUT_MS = 5000;
    private static final int SNIFF_BYTES = 3;

    private final int listenPort;
    private final int webPort;
    private final int mcPort;

    private volatile ServerSocket serverSocket;
    private final ServerSocket prebound;
    /**
     * 上游本地端口 → 真实客户端 IP。
     *
     * 复用模式下我们是唯一的 TCP 入口：MC 侧看到的每个玩家对端都是
     * {@code 127.0.0.1:<upstream 的本地端口>}，用这个端口反查即可还原真实 IP
     * （等价于自己实现了一次 PROXY protocol）。条目随连接关闭移除，不会无限增长。
     */
    private final java.util.concurrent.ConcurrentHashMap<Integer, String> realByUpstreamPort =
            new java.util.concurrent.ConcurrentHashMap<>();

    /** 当前生效的复用实例（给 mixin 反查真实 IP 用；同一时刻只可能有一个） */
    private static volatile PortMux active;
    private final ExecutorService pool = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "xiaona-mux-worker");
        t.setDaemon(true);
        return t;
    });

    public PortMux(int listenPort, int webPort, int mcPort) {
        this.listenPort = listenPort;
        this.webPort = webPort;
        this.mcPort = mcPort;
        this.prebound = null;
    }

    /**
     * 用**已经绑好**的监听套接字启动。
     * 端口被服务商固定、需要把 MC 挪到内部端口时用这个：必须提前占住对外端口，
     * 否则"MC 已挪走、PortMux 又没拿到端口"会让服务器彻底连不上。
     */
    public PortMux(ServerSocket prebound, int listenPort, int webPort, int mcPort) {
        this.listenPort = listenPort;
        this.webPort = webPort;
        this.mcPort = mcPort;
        this.prebound = prebound;
    }

    /** 启动复用监听；失败（端口被占用等）返回 false 且不影响 MC 原有端口 */
    public boolean start() {
        if (prebound != null) {
            this.serverSocket = prebound;
        } else {
            try {
                ServerSocket s = new ServerSocket();
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress(listenPort), 64);
                this.serverSocket = s;
            } catch (IOException e) {
                BotState.error("❌ 端口复用监听失败(" + listenPort + ")： " + e.getMessage()
                        + "（该端口可能已被 MC 服务器或其他程序占用，复用已禁用）");
                return false;
            }
        }
        active = this;
        Thread acc = new Thread(this::acceptLoop, "xiaona-mux-accept");
        acc.setDaemon(true);
        acc.start();
        BotState.log("🔀 端口复用已启用： " + listenPort + " → MC(" + mcPort + ") / 网页(" + webPort + ")");
        return true;
    }

    public void stop() {
        ServerSocket s = serverSocket;
        serverSocket = null;
        if (s != null) {
            try { s.close(); } catch (IOException ignored) {}
        }
        realByUpstreamPort.clear();
        if (active == this) active = null;
        pool.shutdownNow();
    }

    public boolean isRunning() { return serverSocket != null; }

    /**
     * 按"MC 侧看到的上游本地端口"反查真实客户端 IP。
     * @return 真实 IP；没有记录（非复用连接、或连接已关闭）时返回 null
     */
    public String realIpOf(int upstreamPort) {
        return realByUpstreamPort.get(upstreamPort);
    }

    /**
     * 静态反查入口（供 mixin 使用）：按"MC 侧看到的上游本地端口"找回真实客户端 IP。
     * @return 真实 IP；当前没有生效的复用实例、或该端口无记录时返回 null
     */
    public static String realIpOfActive(int upstreamPort) {
        PortMux m = active;
        return m == null ? null : m.realByUpstreamPort.get(upstreamPort);
    }

    private void acceptLoop() {
        while (true) {
            ServerSocket s = serverSocket;
            if (s == null || s.isClosed()) return;
            try {
                Socket client = s.accept();
                pool.submit(() -> handle(client));
            } catch (IOException e) {
                if (serverSocket == null || serverSocket.isClosed()) return;
            }
        }
    }

    private void handle(Socket client) {
        Socket upstream = null;
        Integer upPort = null;
        try {
            client.setTcpNoDelay(true);
            byte[] head = new byte[SNIFF_BYTES];
            int n = readHead(client, head);
            if (n <= 0) { close(client); return; }

            boolean web = isHttpMethod(head, n);
            int target = web ? webPort : mcPort;

            upstream = new Socket();
            upstream.setTcpNoDelay(true);
            upstream.connect(new InetSocketAddress("127.0.0.1", target), 5000);
            // 在把首包交给 MC 之前先把映射记好：MC 收到握手时就要能反查到真实 IP
            if (!web) {
                int lp = upstream.getLocalPort();
                String real = peerIp(client);
                if (lp > 0 && real != null) {
                    realByUpstreamPort.put(lp, real);
                    upPort = lp;
                }
            }
            if (n > 0) {
                OutputStream uo = upstream.getOutputStream();
                uo.write(head, 0, n);
                uo.flush();
            }
            client.setSoTimeout(0);
            upstream.setSoTimeout(0);

            Socket up = upstream;
            Thread t1 = pump(client.getInputStream(), up.getOutputStream(), client, up);
            Thread t2 = pump(up.getInputStream(), client.getOutputStream(), up, client);
            t1.join();
            t2.join();
        } catch (Exception e) {
            close(client);
            close(upstream);
        } finally {
            if (upPort != null) realByUpstreamPort.remove(upPort);
        }
    }

    /** 连接对端的 IP（真实客户端地址） */
    private static String peerIp(Socket s) {
        try {
            java.net.SocketAddress a = s.getRemoteSocketAddress();
            if (a instanceof InetSocketAddress isa && isa.getAddress() != null) {
                return isa.getAddress().getHostAddress();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** 读取最多 SNIFF_BYTES 字节用于协议判定，返回实际读取数 */
    private static int readHead(Socket s, byte[] buf) throws IOException {
        s.setSoTimeout(SNIFF_TIMEOUT_MS);
        int off = 0;
        InputStream in = s.getInputStream();
        while (off < buf.length) {
            int r = in.read(buf, off, buf.length - off);
            if (r < 0) break;
            off += r;
        }
        return off;
    }

    /** HTTP 方法（GET/POST/HEAD/PUT/OPTIONS/DELETE/PATCH/CONNECT）以两个 ASCII 字母开头 */
    private static boolean isHttpMethod(byte[] b, int n) {
        return n >= 2 && isAsciiAlpha(b[0]) && isAsciiAlpha(b[1]);
    }

    private static boolean isAsciiAlpha(byte b) {
        int v = b & 0xFF;
        return (v >= 'A' && v <= 'Z') || (v >= 'a' && v <= 'z');
    }

    /** 双向转发；任一端关闭则整对连接关闭 */
    private static Thread pump(InputStream in, OutputStream out, Socket a, Socket b) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[8192];
            try {
                int r;
                while ((r = in.read(buf)) > 0) {
                    out.write(buf, 0, r);
                    out.flush();
                }
            } catch (Exception ignored) {
            } finally {
                close(a);
                close(b);
            }
        }, "xiaona-mux-pipe");
        t.setDaemon(true);
        t.start();
        return t;
    }

    private static void close(Socket s) {
        if (s != null) {
            try { s.close(); } catch (IOException ignored) {}
        }
    }
}
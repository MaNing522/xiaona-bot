package com.xiaona;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.MutableText;
import net.minecraft.text.Style;
import net.minecraft.text.Text;
import net.minecraft.text.TextColor;
import net.minecraft.util.Formatting;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;

/**
 * 游戏侧事件的收集与消息注入。
 *
 * 事件只进内存环形缓冲，由桥的 SSE 流推给本机机器人；注入一律回到 MC 主线程执行，
 * 绝不让 HTTP 线程直接触碰 MC API。
 */
public class McEvents {
    /** 一条待推送的事件 */
    public static class Event {
        public final long seq;
        public final String type;   // chat | private | join | leave
        public final String player;
        public final String text;
        public final long time;
        public final boolean op;
        /** 进服事件带上真实客户端 IP；其余事件为空串 */
        public final String ip;

        public Event(long seq, String type, String player, String text, long time, boolean op, String ip) {
            this.seq = seq;
            this.type = type;
            this.player = player;
            this.text = text;
            this.time = time;
            this.op = op;
            this.ip = ip == null ? "" : ip;
        }
    }

    /** 一次取事件的结果 */
    public static class Batch {
        public final List<Event> events;
        /** true = 客户端请求的 seq 太旧、中间有事件已被丢弃（提示对方重新对齐） */
        public final boolean gap;

        public Batch(List<Event> events, boolean gap) {
            this.events = events;
            this.gap = gap;
        }
    }

    private final Object lock = new Object();
    private final Deque<Event> queue = new ArrayDeque<>();
    private final int capacity;

    private long nextSeq = 1;   // 与入队同锁自增，保证 seq 顺序与队列顺序一致
    private long firstSeq = 1;  // 队列里最小 seq

    private volatile MinecraftServer server;
    private int streamClients = 0;
    /** 注入文本开头 [标签] 的颜色；null = 不染色 */
    private volatile TextColor tagColor = parseColor("gold");

    public McEvents(int capacity) {
        this.capacity = Math.max(16, capacity);
    }

    public void setServer(MinecraftServer s) { this.server = s; }

    public void setTagColor(String spec) { this.tagColor = parseColor(spec); }

    // ---------- SSE 连接数控制 ----------
    public int streamClients() {
        synchronized (lock) { return streamClients; }
    }

    public boolean addStreamClient(int max) {
        synchronized (lock) {
            if (streamClients >= max) return false;
            streamClients++;
            return true;
        }
    }

    public void removeStreamClient() {
        synchronized (lock) {
            if (streamClients > 0) streamClients--;
        }
    }

    // ---------- 采集 ----------
    public void chat(String player, String text, boolean op) { push("chat", player, text, op); }
    public void privateMsg(String player, String text, boolean op) { push("private", player, text, op); }
    public void join(String player, boolean op, String ip) { push("join", player, "", op, ip); }
    public void leave(String player, boolean op) { push("leave", player, "", op); }
    public void death(String player, String text) { push("death", player, text, false); }
    public void advancement(String player, String text) { push("advancement", player, text, false); }

    private void push(String type, String player, String text, boolean op) { push(type, player, text, op, ""); }

    private void push(String type, String player, String text, boolean op, String ip) {
        synchronized (lock) {
            queue.addLast(new Event(nextSeq++, type, player, text, System.currentTimeMillis(), op, ip));
            while (queue.size() > capacity) {
                queue.removeFirst();
                firstSeq++;
            }
            lock.notifyAll();
        }
    }

    /** 当前最新 seq（新客户端默认从这里开始，不补发历史） */
    public long lastSeq() {
        synchronized (lock) { return nextSeq - 1; }
    }

    /**
     * 等待 since 之后的新事件，最多阻塞 timeoutMs 毫秒。
     * 返回空列表表示只是超时（调用方可发心跳）。
     */
    public Batch await(long since, long timeoutMs) {
        long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
        synchronized (lock) {
            while (true) {
                boolean gap = since < firstSeq - 1;
                List<Event> hit = new ArrayList<>();
                for (Event e : queue) if (e.seq > since) hit.add(e);
                if (!hit.isEmpty() || gap) return new Batch(hit, gap);

                long remainNanos = deadline - System.nanoTime();
                if (remainNanos <= 0) return new Batch(List.of(), false);
                try {
                    lock.wait(remainNanos / 1_000_000L, (int) (remainNanos % 1_000_000L));
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return new Batch(List.of(), false);
                }
            }
        }
    }

    // ---------- 注入（回 MC 主线程） ----------
    /** 广播到全服 */
    public boolean broadcast(String text) {
        MinecraftServer s = server;
        if (s == null || text == null || text.isEmpty()) return false;
        Text msg = render(text, tagColor);
        s.execute(() -> {
            try {
                s.getPlayerManager().broadcast(msg, false);
            } catch (Exception ignored) {
            }
        });
        return true;
    }

    /**
     * 私发给指定玩家（按名字匹配）。
     * 会等 MC 主线程确认该玩家是否存在，因此**只能从 HTTP 线程调用**（从 MC 线程调用会自锁）。
     * @return 是否确实送达
     */
    public boolean sendToPlayer(String name, String text) {
        MinecraftServer s = server;
        if (s == null || name == null || name.isBlank() || text == null || text.isEmpty()) return false;
        Text msg = render(text, tagColor);
        java.util.concurrent.CompletableFuture<Boolean> done = new java.util.concurrent.CompletableFuture<>();
        s.execute(() -> {
            try {
                ServerPlayerEntity p = s.getPlayerManager().getPlayer(name);
                if (p == null) {
                    done.complete(false);
                    return;
                }
                p.sendMessage(msg, false);
                done.complete(true);
            } catch (Exception e) {
                done.complete(false);
            }
        });
        try {
            return Boolean.TRUE.equals(done.get(3, java.util.concurrent.TimeUnit.SECONDS));
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 一次投递给一批玩家（群消息转发用，避免每个玩家一次 HTTP 请求）。
     * 与 {@link #sendToPlayer} 一样**只能从 HTTP 线程调用**。
     * @return 实际送达人数
     */
    public int sendToPlayers(List<String> names, String text) {
        MinecraftServer s = server;
        if (s == null || names == null || names.isEmpty() || text == null || text.isEmpty()) return 0;
        Text msg = render(text, tagColor);
        java.util.concurrent.CompletableFuture<Integer> done = new java.util.concurrent.CompletableFuture<>();
        try {
            s.execute(() -> {
                int n = 0;
                try {
                    for (String name : names) {
                        try {
                            ServerPlayerEntity p = s.getPlayerManager().getPlayer(name);
                            if (p != null) {
                                p.sendMessage(msg, false);
                                n++;
                            }
                        } catch (Exception ignored) {
                            // 单个玩家失败不影响其余人
                        }
                    }
                } finally {
                    done.complete(n);
                }
            });
        } catch (Exception e) {
            return 0;
        }
        try {
            return done.get(3, java.util.concurrent.TimeUnit.SECONDS);
        } catch (Exception e) {
            return 0;
        }
    }

    // ---------- 注入文本渲染 ----------
    /** 能被当成标签染色的 [..] 最大长度，避免把正文开头的长方括号也染上色 */
    private static final int MAX_TAG_LEN = 24;

    /**
     * 把注入文本渲染成 {@link Text}：**把开头连续的 [标签]**（如 [QQ] [123456]）都染成 tagColor，
     * 其余部分保持默认颜色。tagColor 为 null、或开头不是短标签时按纯文本处理。
     *
     * 标签之间允许有空格，空格连同标签一起染色（视觉上看不出）；正文必须是最后一段。
     *
     * 注意：{@code append} 的子节点在渲染时会**继承父节点样式**，所以正文必须显式写死
     * 默认色（白），否则会跟着标签一起变成金色。
     */
    public static Text render(String text, TextColor tagColor) {
        if (text == null || text.isEmpty()) return Text.literal("");
        if (tagColor == null || text.charAt(0) != '[') return Text.literal(text);

        // 依次吃下开头的连续标签（允许标签之间有空格）
        List<int[]> tags = new ArrayList<>();
        int pos = 0;
        while (true) {
            int close = tagEnd(text, pos);
            if (close < 0) break;
            tags.add(new int[]{pos, close});
            pos = close + 1;
            int n = pos;
            while (n < text.length() && text.charAt(n) == ' ') n++;
            if (n < text.length() && tagEnd(text, n) >= 0) pos = n;
            else break;
        }
        if (tags.isEmpty()) return Text.literal(text);

        // 第一个标签当根节点，其余标签作为兄弟节点追加；每段都显式染色，避免继承串色
        MutableText out = null;
        int prev = 0;
        for (int[] t : tags) {
            MutableText seg = Text.literal(text.substring(prev, t[1] + 1))
                    .setStyle(Style.EMPTY.withColor(tagColor));
            if (out == null) out = seg;
            else out.append(seg);
            prev = t[1] + 1;
        }
        String rest = text.substring(prev);
        if (!rest.isEmpty()) {
            out.append(Text.literal(rest).setStyle(Style.EMPTY.withColor(BODY_COLOR)));
        }
        return out;
    }

    /** 从 start 起是否是一个可染色的 [标签]；是则返回 ']' 的下标，否则 -1 */
    private static int tagEnd(String text, int start) {
        if (start < 0 || start >= text.length() || text.charAt(start) != '[') return -1;
        int close = text.indexOf(']', start + 1);
        if (close < 0) return -1;
        if (close < start + 2) return -1;          // "[]" 不算标签
        if (close - start > MAX_TAG_LEN) return -1; // 超长方括号不当标签
        return close;
    }

    /** 正文颜色：原版聊天默认就是白色，写死它才能断掉从标签继承下来的颜色 */
    private static final Formatting BODY_COLOR = Formatting.WHITE;

    /** 颜色写法：gold / yellow / red / #RRGGBB 等；none/off/空 = 不染色 */
    public static TextColor parseColor(String spec) {
        if (spec == null) return null;
        String s = spec.trim();
        if (s.isEmpty() || "none".equalsIgnoreCase(s) || "off".equalsIgnoreCase(s)) return null;
        if (s.startsWith("#") && s.length() == 7) {
            try {
                return TextColor.fromRgb(Integer.parseInt(s.substring(1), 16));
            } catch (Exception ignored) {
                return null;
            }
        }
        Formatting f = Formatting.byName(s.toLowerCase(Locale.ROOT));
        return f != null && f.isColor() ? TextColor.fromFormatting(f) : null;
    }

    // ---------- 查询 ----------
    /** 在线玩家：[名字, 是否OP] */
    public List<String[]> players() {
        List<String[]> out = new ArrayList<>();
        MinecraftServer s = server;
        if (s == null) return out;
        try {
            for (ServerPlayerEntity p : s.getPlayerManager().getPlayerList()) {
                out.add(new String[]{p.getName().getString(), String.valueOf(isOp(s, p))});
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    public int playerCount() {
        MinecraftServer s = server;
        if (s == null) return 0;
        try {
            return s.getPlayerManager().getCurrentPlayerCount();
        } catch (Exception e) {
            return 0;
        }
    }

    public boolean isOp(ServerPlayerEntity p) {
        MinecraftServer s = server;
        return s != null && isOp(s, p);
    }

    public static boolean isOp(MinecraftServer server, ServerPlayerEntity p) {
        try {
            return server.getPlayerManager().isOperator(p.getPlayerConfigEntry());
        } catch (Exception e) {
            return false;
        }
    }
}
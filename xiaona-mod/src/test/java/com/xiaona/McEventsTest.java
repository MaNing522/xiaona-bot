package com.xiaona;

import net.minecraft.text.Text;
import net.minecraft.text.TextColor;
import net.minecraft.util.Formatting;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/** 事件环形缓冲与等待逻辑（桥里最容易写错的部分，不依赖 MinecraftServer 即可测） */
public class McEventsTest {
    @Test
    public void testSeqIsMonotonicAndOrdered() {
        McEvents e = new McEvents(16);
        assertEquals(0, e.lastSeq());
        e.chat("Steve", "hi", false);
        e.chat("Alex", "yo", false);
        assertEquals(2, e.lastSeq());

        McEvents.Batch b = e.await(0, 1);
        assertEquals(2, b.events.size());
        assertEquals(1, b.events.get(0).seq);
        assertEquals(2, b.events.get(1).seq);
        assertEquals("chat", b.events.get(0).type);
        assertEquals("Steve", b.events.get(0).player);
        assertFalse(b.gap);
    }

    @Test
    public void testAwaitReturnsEmptyOnTimeout() {
        McEvents e = new McEvents(16);
        long t0 = System.nanoTime();
        McEvents.Batch b = e.await(0, 120);
        long ms = (System.nanoTime() - t0) / 1_000_000L;
        assertTrue(b.events.isEmpty());
        assertFalse(b.gap);
        assertTrue(ms >= 100, "应至少等到超时，实际 " + ms + "ms");
        assertTrue(ms < 2000, "不应明显超过超时，实际 " + ms + "ms");
    }

    @Test
    public void testAwaitWakesUpOnPush() throws Exception {
        McEvents e = new McEvents(16);
        AtomicReference<McEvents.Batch> got = new AtomicReference<>();
        Thread t = new Thread(() -> got.set(e.await(0, 5000)));
        t.start();
        Thread.sleep(150);          // 让它先进入等待
        e.chat("Steve", "wake", false);
        t.join(3000);
        assertNotNull(got.get());
        assertEquals(1, got.get().events.size());
        assertEquals("wake", got.get().events.get(0).text);
    }

    @Test
    public void testOnlyNewEventsAfterSince() {
        McEvents e = new McEvents(16);
        e.chat("A", "1", false);
        e.chat("B", "2", false);
        McEvents.Batch b = e.await(1, 1);
        assertEquals(1, b.events.size());
        assertEquals("2", b.events.get(0).text);
    }

    @Test
    public void testOverflowMarksGap() {
        McEvents e = new McEvents(16);   // 构造器会把小于 16 的抬到 16
        for (int i = 1; i <= 20; i++) e.chat("P" + i, "m" + i, false);
        assertEquals(20, e.lastSeq());

        // 队列只剩最后 16 条（seq 5..20）→ 停在 1 的客户端应被告知有断层
        McEvents.Batch gap = e.await(1, 1);
        assertTrue(gap.gap);
        assertEquals(16, gap.events.size());
        assertEquals(5, gap.events.get(0).seq);

        // 停在 4 的客户端没漏事件，不应报断层
        McEvents.Batch ok = e.await(4, 1);
        assertFalse(ok.gap);
        assertEquals(16, ok.events.size());
    }

    @Test
    public void testStreamClientCap() {
        McEvents e = new McEvents(16);
        assertTrue(e.addStreamClient(2));
        assertTrue(e.addStreamClient(2));
        assertFalse(e.addStreamClient(2));   // 超过上限必须被拒
        assertEquals(2, e.streamClients());
        e.removeStreamClient();
        assertEquals(1, e.streamClients());
        assertTrue(e.addStreamClient(2));
        e.removeStreamClient();
        e.removeStreamClient();
        e.removeStreamClient();              // 多减不应变成负数
        assertEquals(0, e.streamClients());
    }

    @Test
    public void testEventTypes() {
        McEvents e = new McEvents(16);
        e.join("Steve", false, "203.0.113.9");
        e.leave("Alex", true);
        e.privateMsg("Steve", "秘密", false);
        McEvents.Batch b = e.await(0, 1);
        assertEquals("join", b.events.get(0).type);
        assertEquals("203.0.113.9", b.events.get(0).ip);
        assertEquals("leave", b.events.get(1).type);
        assertTrue(b.events.get(1).op);
        assertEquals("private", b.events.get(2).type);
        assertEquals("秘密", b.events.get(2).text);
    }

    /** 模拟客户端的样式继承：子节点没写颜色的字段会从父节点继承下来 */
    private static TextColor effectiveColor(Text parent, Text child) {
        TextColor own = child.getStyle().getColor();
        return own != null ? own : parent.getStyle().getColor();
    }

    /** 注入文本开头的 [标签] 单独染色，正文保持默认色 */
    @Test
    public void testInjectTagIsColored() {
        TextColor gold = McEvents.parseColor("gold");
        assertNotNull(gold);

        Text t = McEvents.render("[QQ] Steve: 你好", gold);
        assertEquals("[QQ] Steve: 你好", t.getString(), "染色不能改变可见文本");
        assertEquals(gold, t.getStyle().getColor(), "开头的 [QQ] 应是金色");
        assertEquals(1, t.getSiblings().size(), "正文应作为独立一段附在后面");
        assertEquals(" Steve: 你好", t.getSiblings().get(0).getString());

        // 关键：append 的子节点会继承父节点样式，所以正文必须显式写死颜色，
        // 否则渲染出来正文会跟着标签一起变金（这就是"染色染到正文"的 bug）
        Text body = t.getSiblings().get(0);
        assertNotNull(body.getStyle().getColor(), "正文必须显式指定颜色，不能靠继承");
        assertNotEquals(gold, effectiveColor(t, body), "正文的有效颜色不能是标签的金色");
        assertEquals(TextColor.fromFormatting(Formatting.WHITE), effectiveColor(t, body),
                "正文应是聊天默认的白色");
    }

    /** 开头连续两个标签：两个都染色，正文仍是白色 */
    @Test
    public void testConsecutiveTagsAreColored() {
        TextColor gold = McEvents.parseColor("gold");
        Text t = McEvents.render("[QQ] [123456] Steve: 你好", gold);
        assertEquals("[QQ] [123456] Steve: 你好", t.getString(), "染色不能改变可见文本");
        assertEquals(gold, t.getStyle().getColor(), "第一个标签 [QQ] 应是金色");

        // 段结构：根 = "[QQ]"，兄弟依次为 " [123456]" 与 " Steve: 你好"
        assertEquals(2, t.getSiblings().size());
        Text tag2 = t.getSiblings().get(0);
        assertEquals(" [123456]", tag2.getString());
        assertEquals(gold, tag2.getStyle().getColor(), "第二个标签 [123456] 也应同色");

        Text body = t.getSiblings().get(1);
        assertEquals(" Steve: 你好", body.getString());
        assertEquals(TextColor.fromFormatting(Formatting.WHITE), effectiveColor(t, body),
                "正文仍应是白色，不能跟着标签变金");
        assertNotEquals(gold, effectiveColor(t, body));
    }

    /** 单个标签时行为不变：不产生多余兄弟段 */
    @Test
    public void testSingleTagStillOneBodySibling() {
        TextColor gold = McEvents.parseColor("gold");
        Text t = McEvents.render("[QQ] Steve: 你好", gold);
        assertEquals(1, t.getSiblings().size(), "单标签仍应只有 1 段正文");
        assertEquals(gold, t.getStyle().getColor());
        assertEquals(TextColor.fromFormatting(Formatting.WHITE),
                effectiveColor(t, t.getSiblings().get(0)));
    }

    /** 不染色 / 没有标签 / 超长方括号：一律保持纯文本，不拆段 */
    @Test
    public void testRenderKeepsPlainWhenNoTag() {
        assertNull(McEvents.parseColor("none"));
        assertNull(McEvents.parseColor(""));
        assertNull(McEvents.parseColor(null));
        assertNull(McEvents.parseColor("不是颜色"));

        Text off = McEvents.render("[QQ] x", null);
        assertEquals("[QQ] x", off.getString());
        assertTrue(off.getSiblings().isEmpty(), "关闭染色时不应拆成多段");

        TextColor gold = McEvents.parseColor("gold");
        Text noTag = McEvents.render("Steve: 你好", gold);
        assertEquals("Steve: 你好", noTag.getString());
        assertNull(noTag.getStyle().getColor(), "开头不是标签时整条保持默认色");
        assertTrue(noTag.getSiblings().isEmpty());

        Text longTag = McEvents.render("[" + "长".repeat(30) + "] x", gold);
        assertNull(longTag.getStyle().getColor(), "超长方括号不应被当成标签染色");
        assertTrue(longTag.getSiblings().isEmpty());
    }

    /** 支持 #RRGGBB 自定义颜色 */
    @Test
    public void testRenderWithRgbColor() {
        TextColor c = McEvents.parseColor("#FFAA00");
        assertNotNull(c);
        assertEquals(0xFFAA00, c.getRgb());

        Text t = McEvents.render("[记录] 死亡 xxx", c);
        assertEquals("[记录] 死亡 xxx", t.getString());
        assertEquals(c, t.getStyle().getColor());
        assertEquals(TextColor.fromFormatting(Formatting.WHITE), effectiveColor(t, t.getSiblings().get(0)),
                "自定义颜色同样不能漏到正文");
    }

    /**
     * 上线路由的形态无法在单元测试里序列化（Style 的 codec 初始化要注册表引导），
     * 所以这里退一步断言结构本身：标签与正文各带显式颜色，正文色 ≠ 标签色。
     * （真实上线形态用 runServer 打印过一次 JSON 确认，见提交说明）
     */
    @Test
    public void testBothSegmentsCarryExplicitColor() {
        TextColor gold = McEvents.parseColor("gold");
        Text t = McEvents.render("[QQ] Steve: 你好", gold);
        assertEquals(2, 1 + t.getSiblings().size(), "应为 标签 + 正文 两段");
        assertEquals(gold, t.getStyle().getColor(), "标签段是金色");
        assertEquals(TextColor.fromFormatting(Formatting.WHITE), t.getSiblings().get(0).getStyle().getColor(),
                "正文段必须显式白色");
    }
}
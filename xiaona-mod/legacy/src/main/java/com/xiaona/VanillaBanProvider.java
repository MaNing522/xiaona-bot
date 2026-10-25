package com.xiaona;

import com.mojang.authlib.GameProfile;
import net.minecraft.server.BannedPlayerEntry;
import net.minecraft.server.BannedPlayerList;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.ServerConfigEntry;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;

import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * 原版封禁名单（1.21.1 / 1.21.8 版本）。
 *
 * <p>这一代的名单 key 是 {@link GameProfile}，而且 {@code ServerConfigEntry#getKey()}
 * 是包内可见的（1.21.11 才改成公开的 {@code PlayerConfigEntry}），所以读名单时用反射取 key。
 * 写名单仍然直接改集合、不走 /ban：与 1.21.11 同理，避免命令异步解析档案导致名单没落地。
 */
final class VanillaBanProvider implements BanProvider {
    private final MinecraftServer server;

    VanillaBanProvider(MinecraftServer server) {
        this.server = server;
    }

    @Override
    public String id() {
        return "vanilla";
    }

    @Override
    public List<BanRow> list() {
        List<BanRow> list = new ArrayList<>();
        // 封禁名单是普通集合，必须在服务端线程里读，避免与 /ban 并发修改撞车
        CompletableFuture<Void> done = new CompletableFuture<>();
        server.execute(() -> {
            try {
                for (BannedPlayerEntry e : server.getPlayerManager().getUserBanList().values()) {
                    GameProfile key = keyOf(e);
                    if (key == null) continue;
                    list.add(new BanRow(
                            key.getName(),
                            String.valueOf(key.getId()),
                            e.getReason() == null ? "" : e.getReason(),
                            e.getSource() == null ? "" : e.getSource(),
                            e.getCreationDate() == null ? 0 : e.getCreationDate().getTime(),
                            e.getExpiryDate() == null ? 0 : e.getExpiryDate().getTime()));
                }
            } catch (Throwable t) {
                BotState.error("[桥] 读取封禁名单失败：" + t.getMessage());
            } finally {
                done.complete(null);
            }
        });
        try { done.get(3, TimeUnit.SECONDS); } catch (Exception ignore) { /* 超时按已读到的返回 */ }
        return list;
    }

    @Override
    public Result ban(List<String> names, String reason) {
        List<String> done = new ArrayList<>();
        List<String> failed = new ArrayList<>();
        Map<String, String> errors = new LinkedHashMap<>();
        CompletableFuture<Void> finished = new CompletableFuture<>();
        // 封禁名单是普通集合，增删必须在服务端线程里做
        server.execute(() -> {
            try {
                BannedPlayerList list = server.getPlayerManager().getUserBanList();
                for (String name : names) {
                    if (!name.matches("[A-Za-z0-9_]{3,16}")) {
                        failed.add(name);
                        errors.put(name, "玩家名不合法（只能是 3~16 位字母、数字、下划线）");
                        continue;
                    }
                    try {
                        // 优先用服务器名称缓存里的真实档案（在线模式 UUID 才对得上），查不到按离线档案
                        GameProfile key = profileOf(name);
                        if (!list.contains(key)) {
                            list.add(new BannedPlayerEntry(key, new Date(), "xiaona-bridge", null,
                                    reason.isBlank() ? "Banned by xiaona bridge" : reason));
                        }
                        ServerPlayerEntity online = server.getPlayerManager().getPlayer(name);
                        if (online != null) {
                            online.networkHandler.disconnect(Text.translatable("multiplayer.disconnect.banned"));
                        }
                        done.add(name);
                    } catch (Throwable t) {
                        BotState.error("[桥] 封禁 " + name + " 失败：" + t.getMessage());
                        failed.add(name);
                        errors.put(name, t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage());
                    }
                }
            } finally {
                finished.complete(null);
            }
        });
        try { finished.get(5, TimeUnit.SECONDS); } catch (Exception ignore) { /* 超时按已处理的结果返回 */ }
        return new Result(done, failed, errors);
    }

    @Override
    public Result unban(List<String> names) {
        List<String> done = new ArrayList<>();
        List<String> failed = new ArrayList<>();
        Map<String, String> errors = new LinkedHashMap<>();
        CompletableFuture<Void> finished = new CompletableFuture<>();
        server.execute(() -> {
            try {
                BannedPlayerList list = server.getPlayerManager().getUserBanList();
                for (String name : names) {
                    try {
                        boolean hit = false;
                        // 复制一份再遍历，边遍历边删会撞并发修改
                        for (BannedPlayerEntry e : new ArrayList<>(list.values())) {
                            GameProfile key = keyOf(e);
                            if (key != null && key.getName().equalsIgnoreCase(name)) {
                                list.remove(e);
                                hit = true;
                            }
                        }
                        if (hit) done.add(name); else failed.add(name);
                    } catch (Throwable t) {
                        BotState.error("[桥] 解封 " + name + " 失败：" + t.getMessage());
                        failed.add(name);
                        errors.put(name, t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage());
                    }
                }
            } finally {
                finished.complete(null);
            }
        });
        try { finished.get(5, TimeUnit.SECONDS); } catch (Exception ignore) { /* 超时按已处理的结果返回 */ }
        return new Result(done, failed, errors);
    }

    /** 旧版 getKey() 是包内可见的，外部只能反射读 */
    private static GameProfile keyOf(ServerConfigEntry<?> entry) {
        try {
            Method m = ServerConfigEntry.class.getDeclaredMethod("getKey");
            m.setAccessible(true);
            return (GameProfile) m.invoke(entry);
        } catch (Exception e) {
            return null;
        }
    }

    /** 名字 → 档案：在线玩家优先，其次名称缓存，最后离线 UUID 兜底 */
    private GameProfile profileOf(String name) {
        ServerPlayerEntity online = server.getPlayerManager().getPlayer(name);
        if (online != null) return online.getGameProfile();
        try {
            Optional<GameProfile> cached = server.getUserCache().findByName(name);
            if (cached.isPresent()) return cached.get();
        } catch (Exception ignored) {
        }
        return new GameProfile(UUID.nameUUIDFromBytes(
                ("OfflinePlayer:" + name).getBytes(StandardCharsets.UTF_8)), name);
    }
}

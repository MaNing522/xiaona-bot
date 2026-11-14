package com.xiaona;

import java.util.List;
import java.util.Map;

/**
 * 封禁来源。
 *
 * <p>服务器没装 Paradigm 时用原版名单（{@link VanillaBanProvider}）；
 * 装了就用 Paradigm 自己的库和命令（{@link ParadigmBanProvider}）。
 * 两套名单在 Paradigm 里是**完全分离**的，所以不做合并，避免出现"网页显示已封、游戏里还能进"。
 */
public interface BanProvider {
    /** "vanilla" / "paradigm" */
    String id();

    /** 当前生效中的封禁；读取失败抛 {@link BanException}，不能拿空列表冒充"没有封禁" */
    List<BanRow> list();

    /** 惩罚历史（含已撤销/过期）；原版没有历史，退化为当前名单 */
    default List<BanRow> history() { return list(); }

    /** 是否支持按惩罚ID（Paradigm 的 P-xxx）撤销 */
    default boolean supportsIdRevoke() { return false; }

    /** 按惩罚ID撤销；不支持的来源直接返回失败 */
    default Result revoke(List<String> ids, String reason) {
        Map<String, String> errors = new java.util.LinkedHashMap<>();
        for (String id : ids) errors.put(id, "当前封禁来源不支持按惩罚ID撤销");
        return new Result(List.of(), List.copyOf(ids), errors);
    }

    /** 封禁；done = 命令已被服务器接受（Paradigm 可能异步解析档案） */
    Result ban(List<String> names, String reason);

    /** 解封 */
    Result unban(List<String> names);

    /**
     * 一条惩罚记录。
     * id = Paradigm 的惩罚ID（原版为空）；type = BAN/MUTE/WARN/...；status = ACTIVE/EXPIRED/REVOKED/PENDING。
     * expires = 0 表示永久；source 是执行者（原版是命令来源，Paradigm 是 actor）。
     */
    record BanRow(String id, String type, String status, String name, String uuid, String reason,
                  String source, long created, long expires, long revokedAt) {}

    /** 逐个玩家的处理结果；errors 是失败原因（名字 → 中文说明） */
    record Result(List<String> done, List<String> failed, Map<String, String> errors) {}
}


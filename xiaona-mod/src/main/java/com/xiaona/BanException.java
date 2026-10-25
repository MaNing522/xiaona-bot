package com.xiaona;

/**
 * 封禁来源不可用 / 操作失败。
 * 消息直接给网页和 QQ 机器人看，所以一律用中文写清楚"哪里不对、该怎么办"。
 */
public class BanException extends RuntimeException {
    public BanException(String message) {
        super(message);
    }

    public BanException(String message, Throwable cause) {
        super(message, cause);
    }
}

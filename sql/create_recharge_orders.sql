-- ============================================
-- 积分充值订单表（微信支付 Native 扫码充值）
-- ⚠️ 仅执行一次：mysql -u<user> -p <db> < sql/create_recharge_orders.sql
-- ============================================
CREATE TABLE IF NOT EXISTS `recharge_orders` (
  `id`             INT          NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
  `order_no`       VARCHAR(32)  NOT NULL                            COMMENT '商户订单号 out_trade_no',
  `user_id`        INT          NOT NULL                            COMMENT '下单用户',
  `plan_id`        INT          NOT NULL                            COMMENT '充值套餐 ID（后端定义 1-6）',
  `amount`         INT          NOT NULL                            COMMENT '实付金额（单位：分）',
  `points`         INT          NOT NULL                            COMMENT '应到账积分',
  `status`         VARCHAR(20)  NOT NULL DEFAULT 'pending'          COMMENT 'pending待支付/paid已支付/closed已关闭',
  `transaction_id` VARCHAR(64)  NOT NULL DEFAULT ''                 COMMENT '微信支付单号',
  `paid_at`        DATETIME                                         COMMENT '支付成功时间',
  `created_at`     DATETIME     NOT NULL                            COMMENT '创建时间',
  `updated_at`     DATETIME     NOT NULL                            COMMENT '更新时间',
  UNIQUE KEY `uk_recharge_orders_order_no` (`order_no`),
  KEY `idx_recharge_orders_user` (`user_id`),
  KEY `idx_recharge_orders_status` (`status`),
  CONSTRAINT `fk_recharge_orders_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='积分充值订单表（微信支付 Native 扫码充值）';

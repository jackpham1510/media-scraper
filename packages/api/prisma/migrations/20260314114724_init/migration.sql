-- CreateTable
CREATE TABLE `scrape_jobs` (
    `id` VARCHAR(36) NOT NULL,
    `status` ENUM('pending', 'running', 'fast_complete', 'done', 'failed') NOT NULL DEFAULT 'pending',
    `browser_fallback` BOOLEAN NOT NULL DEFAULT false,
    `max_scroll_depth` TINYINT UNSIGNED NOT NULL DEFAULT 10,
    `urls_total` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `urls_done` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `urls_spa_detected` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `urls_browser_done` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,

    INDEX `idx_status`(`status`),
    INDEX `idx_created_at`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `scrape_requests` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `job_id` VARCHAR(36) NOT NULL,
    `url` TEXT NOT NULL,
    `status` ENUM('pending', 'processing', 'spa_detected', 'done', 'failed') NOT NULL DEFAULT 'pending',
    `scrape_path` ENUM('fast', 'browser') NULL,
    `spa_score` TINYINT UNSIGNED NULL,
    `error` TEXT NULL,

    INDEX `idx_job_status`(`job_id`, `status`),
    INDEX `idx_job_path`(`job_id`, `scrape_path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `scrape_pages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `job_id` VARCHAR(36) NOT NULL,
    `source_url` VARCHAR(2048) NOT NULL,
    `title` VARCHAR(1000) NULL,
    `description` TEXT NULL,
    `scraped_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_job_id`(`job_id`),
    INDEX `idx_source_url`(`source_url`(255)),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_items` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `page_id` BIGINT UNSIGNED NOT NULL,
    `job_id` VARCHAR(36) NOT NULL,
    `source_url` VARCHAR(2048) NOT NULL,
    `media_url` VARCHAR(2048) NOT NULL,
    `media_url_hash` CHAR(64) NOT NULL,
    `media_type` ENUM('image', 'video') NOT NULL,
    `alt_text` VARCHAR(1000) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `idx_job_id`(`job_id`),
    INDEX `idx_media_type`(`media_type`),
    INDEX `idx_created_at`(`created_at`),
    UNIQUE INDEX `uq_media_url_hash`(`media_url_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `scrape_requests` ADD CONSTRAINT `scrape_requests_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `scrape_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `scrape_pages` ADD CONSTRAINT `scrape_pages_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `scrape_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_items` ADD CONSTRAINT `media_items_page_id_fkey` FOREIGN KEY (`page_id`) REFERENCES `scrape_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `media_items` ADD CONSTRAINT `media_items_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `scrape_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- FULLTEXT index for alt_text search
-- Raw SQL required: Prisma schema DSL does not support FULLTEXT index syntax for MySQL
ALTER TABLE `media_items` ADD FULLTEXT INDEX `idx_ft_search` (`alt_text`);

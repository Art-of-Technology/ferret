CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`account_type` text NOT NULL,
	`display_name` text NOT NULL,
	`iban` text,
	`sort_code` text,
	`account_number` text,
	`currency` text NOT NULL,
	`balance_available` real,
	`balance_current` real,
	`balance_updated_at` integer,
	`is_manual` integer DEFAULT false,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`monthly_amount` real NOT NULL,
	`currency` text NOT NULL,
	`start_date` integer NOT NULL,
	`end_date` integer,
	FOREIGN KEY (`category`) REFERENCES `categories`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`name` text PRIMARY KEY NOT NULL,
	`parent` text,
	`color` text,
	`icon` text
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`provider_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_synced_at` integer
);
--> statement-breakpoint
CREATE TABLE `merchant_cache` (
	`merchant_normalized` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`confidence` real,
	`source` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` text PRIMARY KEY NOT NULL,
	`pattern` text NOT NULL,
	`field` text NOT NULL,
	`category` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`status` text NOT NULL,
	`transactions_added` integer,
	`transactions_updated` integer,
	`error_message` text
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`timestamp` integer NOT NULL,
	`amount` real NOT NULL,
	`currency` text NOT NULL,
	`description` text NOT NULL,
	`merchant_name` text,
	`transaction_type` text,
	`category` text,
	`category_source` text,
	`provider_category` text,
	`running_balance` real,
	`is_pending` integer DEFAULT false,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `txn_account_timestamp_idx` ON `transactions` (`account_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `txn_category_idx` ON `transactions` (`category`,`timestamp`);--> statement-breakpoint
CREATE INDEX `txn_merchant_idx` ON `transactions` (`merchant_name`);
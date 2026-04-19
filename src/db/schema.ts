import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const connections = sqliteTable('connections', {
  id: text('id').primaryKey(), // uuid
  providerId: text('provider_id').notNull(), // 'uk-ob-lloyds'
  providerName: text('provider_name').notNull(), // 'Lloyds'
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  status: text('status').notNull(), // active | expired | revoked
  lastSyncedAt: integer('last_synced_at', { mode: 'timestamp' }),
});

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(), // TrueLayer account_id
  connectionId: text('connection_id')
    .notNull()
    .references(() => connections.id),
  accountType: text('account_type').notNull(), // TRANSACTION | SAVINGS | CREDIT_CARD
  displayName: text('display_name').notNull(),
  iban: text('iban'),
  sortCode: text('sort_code'),
  accountNumber: text('account_number'),
  currency: text('currency').notNull(),
  balanceAvailable: real('balance_available'),
  balanceCurrent: real('balance_current'),
  balanceUpdatedAt: integer('balance_updated_at', { mode: 'timestamp' }),
  isManual: integer('is_manual', { mode: 'boolean' }).default(false), // CSV-imported
});

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(), // provider_transaction_id or hash
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
    amount: real('amount').notNull(), // negative = outflow
    currency: text('currency').notNull(),
    description: text('description').notNull(), // raw from bank
    merchantName: text('merchant_name'), // normalized
    transactionType: text('transaction_type'), // DEBIT | CREDIT | TRANSFER
    category: text('category'),
    categorySource: text('category_source'), // manual | rule | cache | claude
    providerCategory: text('provider_category'), // raw from bank if present
    runningBalance: real('running_balance'),
    isPending: integer('is_pending', { mode: 'boolean' }).default(false),
    metadata: text('metadata', { mode: 'json' }), // raw provider response
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    accountTimestampIdx: index('txn_account_timestamp_idx').on(table.accountId, table.timestamp),
    categoryIdx: index('txn_category_idx').on(table.category, table.timestamp),
    merchantIdx: index('txn_merchant_idx').on(table.merchantName),
  }),
);

export const categories = sqliteTable('categories', {
  name: text('name').primaryKey(),
  parent: text('parent'), // 'Food' parent of 'Groceries'
  color: text('color'), // hex for terminal display
  icon: text('icon'), // emoji
});

export const budgets = sqliteTable('budgets', {
  id: text('id').primaryKey(),
  category: text('category')
    .notNull()
    .references(() => categories.name),
  monthlyAmount: real('monthly_amount').notNull(),
  currency: text('currency').notNull(),
  startDate: integer('start_date', { mode: 'timestamp' }).notNull(),
  endDate: integer('end_date', { mode: 'timestamp' }),
});

export const rules = sqliteTable('rules', {
  id: text('id').primaryKey(),
  pattern: text('pattern').notNull(), // regex
  field: text('field').notNull(), // merchant | description
  category: text('category').notNull(),
  priority: integer('priority').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const merchantCache = sqliteTable('merchant_cache', {
  merchantNormalized: text('merchant_normalized').primaryKey(),
  category: text('category').notNull(),
  confidence: real('confidence'),
  source: text('source').notNull(), // claude | manual
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const syncLog = sqliteTable('sync_log', {
  id: text('id').primaryKey(),
  connectionId: text('connection_id').notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  status: text('status').notNull(), // success | failed | partial
  transactionsAdded: integer('transactions_added'),
  transactionsUpdated: integer('transactions_updated'),
  errorMessage: text('error_message'),
});

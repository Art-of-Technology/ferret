import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type {
  accounts,
  budgets,
  categories,
  connections,
  merchantCache,
  rules,
  syncLog,
  transactions,
} from '../db/schema';

export type Connection = InferSelectModel<typeof connections>;
export type NewConnection = InferInsertModel<typeof connections>;

export type Account = InferSelectModel<typeof accounts>;
export type NewAccount = InferInsertModel<typeof accounts>;

export type Transaction = InferSelectModel<typeof transactions>;
export type NewTransaction = InferInsertModel<typeof transactions>;

export type Category = InferSelectModel<typeof categories>;
export type NewCategory = InferInsertModel<typeof categories>;

export type Budget = InferSelectModel<typeof budgets>;
export type NewBudget = InferInsertModel<typeof budgets>;

export type Rule = InferSelectModel<typeof rules>;
export type NewRule = InferInsertModel<typeof rules>;

export type MerchantCacheEntry = InferSelectModel<typeof merchantCache>;
export type NewMerchantCacheEntry = InferInsertModel<typeof merchantCache>;

export type SyncLogEntry = InferSelectModel<typeof syncLog>;
export type NewSyncLogEntry = InferInsertModel<typeof syncLog>;

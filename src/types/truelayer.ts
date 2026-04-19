// TrueLayer Data API response types.
// Based on https://docs.truelayer.com/docs/data-api-basics and PRD §8.1.

export interface TrueLayerTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface TrueLayerMeResult {
  client_id: string;
  credentials_id: string;
  consent_status?: string;
  consent_created?: string;
  consent_expires_at?: string;
  provider: {
    provider_id: string;
    display_name: string;
    logo_uri?: string;
  };
}

export interface TrueLayerMeResponse {
  results: TrueLayerMeResult[];
}

export interface TrueLayerProviderInfo {
  display_name: string;
  provider_id: string;
  logo_uri?: string;
}

export interface TrueLayerAccountNumber {
  iban?: string;
  swift_bic?: string;
  number?: string;
  sort_code?: string;
}

export interface TrueLayerAccount {
  account_id: string;
  account_type: string; // TRANSACTION | SAVINGS
  display_name: string;
  currency: string;
  account_number?: TrueLayerAccountNumber;
  provider: TrueLayerProviderInfo;
  update_timestamp?: string;
}

export interface TrueLayerAccountsResponse {
  results: TrueLayerAccount[];
}

export interface TrueLayerBalance {
  currency: string;
  available?: number;
  current: number;
  overdraft?: number;
  update_timestamp?: string;
}

export interface TrueLayerBalanceResponse {
  results: TrueLayerBalance[];
}

export interface TrueLayerTransactionMeta {
  provider_transaction_category?: string;
  provider_reference?: string;
  provider_category?: string;
  provider_id?: string;
  [k: string]: unknown;
}

export interface TrueLayerTransaction {
  transaction_id: string;
  timestamp: string;
  description: string;
  amount: number;
  currency: string;
  transaction_type: string; // DEBIT | CREDIT
  transaction_category?: string;
  transaction_classification?: string[];
  merchant_name?: string;
  running_balance?: { amount: number; currency: string };
  meta?: TrueLayerTransactionMeta;
  normalised_provider_transaction_id?: string;
  provider_transaction_id?: string;
}

export interface TrueLayerTransactionsResponse {
  results: TrueLayerTransaction[];
}

export interface TrueLayerCard {
  account_id: string;
  card_network: string;
  card_type: string;
  currency: string;
  display_name: string;
  partial_card_number?: string;
  name_on_card?: string;
  valid_from?: string;
  valid_to?: string;
  update_timestamp?: string;
  provider: TrueLayerProviderInfo;
}

export interface TrueLayerCardsResponse {
  results: TrueLayerCard[];
}

export interface TrueLayerCardBalance {
  available: number;
  current: number;
  credit_limit?: number;
  last_statement_balance?: number;
  last_statement_date?: string;
  payment_due?: number;
  payment_due_date?: string;
  currency: string;
  update_timestamp?: string;
}

export interface TrueLayerCardBalanceResponse {
  results: TrueLayerCardBalance[];
}

export interface TrueLayerErrorBody {
  error?: string;
  error_description?: string;
  error_details?: unknown;
  message?: string;
}

export type TrueLayerDateRange = {
  from?: string; // ISO date or full timestamp
  to?: string;
};

// --- TYPES FRONTEND / API (Contrat existant) ---

export enum TransactionType {
  DEPOSIT = 'deposit',
  TRANSFER = 'transfer',
  PAYMENT = 'payment'
}

export enum TransactionStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

export interface User {
  id: string;
  nom: string;
  email: string;
  created_at: string;
  type?: string | null;
  adresse?: string | null;
  num_CIN?: string | null;
  role?: string | null;
  type_utilisateur?: string | null;
  passwd?: number | null;
}

export interface Wallet {
  id: string;
  userId: string;
  balance: number;
  currency: string;
}

export interface Transaction {
  id: string;
  sourceWalletId?: string;
  destinationWalletId?: string;
  amount: number;
  type: TransactionType;
  status: TransactionStatus;
  createdAt: string;
  description: string;
}

// --- TYPES SUPABASE / DATABASE (Mapping SQL) ---

export interface DBUser {
  id: string;
  nom: string;
  email: string;
  created_at: string;
  type: string | null;
  adresse: string | null;
  num_CIN: string | null;
  role: string | null;
  type_utilisateur: string | null;
  passwd: number | null;
}

export interface DBWallet {
  id: string;
  titulaire_id: string;
  solde: number;
  monnaie: string;
  created_at: string;
}

export interface DBTransaction {
  id: string;
  donneur_ordre_id: string | null;
  beneficiaire_id: string | null;
  montant: number;
  type: 'deposit' | 'transfer' | 'payment';
  description: string | null;
  status: 'pending' | 'completed' | 'failed';
  created_at: string;
}

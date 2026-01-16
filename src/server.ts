import express from 'express';
import cors from 'cors';
import { supabase } from './db';
import { Transaction, TransactionStatus, TransactionType, DBTransaction, DBWallet } from './types';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json() as any);

// --- HELPERS DE MAPPING ---

const mapTransactionTypeToApi = (type: string): TransactionType => {
  switch (type) {
    case 'deposit': return TransactionType.DEPOSIT;
    case 'transfer': return TransactionType.TRANSFER;
    case 'payment': return TransactionType.PAYMENT;
    default: return TransactionType.TRANSFER;
  }
};

const mapApiTypeToDb = (type: TransactionType | string): 'deposit' | 'transfer' | 'payment' => {
  if (type === TransactionType.DEPOSIT || type === 'deposit') return 'deposit';
  if (type === TransactionType.TRANSFER || type === 'transfer') return 'transfer';
  if (type === TransactionType.PAYMENT || type === 'payment') return 'payment';
  return 'transfer';
};

// --- AUTH ---

app.post('/api/auth/login', async (req: any, res: any) => {
  const { identifier } = req.body;

  if (!identifier) return res.status(400).json({ error: "Identifiant requis" });

  // On cherche l'utilisateur par passwd (integer)
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('passwd', parseInt(identifier))
    .single();

  if (error || !data) {
    return res.status(401).json({ error: "Identifiant incorrect" });
  }

  res.json(data);
});

// --- WALLET ---

// Get Wallet by User ID
app.get('/api/wallets/user/:userId', async (req: any, res: any) => {
  const { userId } = req.params;

  const { data, error } = await supabase
    .from('wallets')
    .select('*')
    .eq('titulaire_id', userId)
    .single();

  if (error) {
    return res.status(404).json({ error: "Wallet introuvable" });
  }

  // Mapping DB -> API
  const wallet = {
    id: data.id,
    userId: data.titulaire_id,
    balance: data.solde,
    currency: data.monnaie
  };

  res.json(wallet);
});

// --- TRANSACTIONS ---

// Get Transactions for a Wallet
app.get('/api/transactions/:walletId', async (req: any, res: any) => {
  const { walletId } = req.params;

  // 1. Trouver le User ID associé à ce wallet (car les transactions sont liées aux Users dans le schéma)
  const { data: walletData, error: walletError } = await supabase
    .from('wallets')
    .select('titulaire_id')
    .eq('id', walletId)
    .single();

  if (walletError || !walletData) {
    return res.status(404).json({ error: "Wallet introuvable" });
  }

  const userId = walletData.titulaire_id;

  // 2. Récupérer les transactions où l'user est donneur ou bénéficiaire
  const { data: txData, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .or(`donneur_ordre_id.eq.${userId},beneficiaire_id.eq.${userId}`)
    .order('created_at', { ascending: false });

  if (txError) {
    return res.status(500).json({ error: txError.message });
  }

  // 3. Pour mapper correctement sourceWalletId et destinationWalletId, nous avons besoin
  // de retrouver les WalletIDs correspondant aux UserIDs des transactions.
  // On récupère tous les userIds uniques impliqués.
  const userIds = new Set<string>();
  (txData as DBTransaction[]).forEach(tx => {
    if (tx.donneur_ordre_id) userIds.add(tx.donneur_ordre_id);
    if (tx.beneficiaire_id) userIds.add(tx.beneficiaire_id);
  });

  // Fetch wallets for these users
  const { data: walletsMapData } = await supabase
    .from('wallets')
    .select('id, titulaire_id')
    .in('titulaire_id', Array.from(userIds));

  const userToWalletMap: Record<string, string> = {};
  walletsMapData?.forEach((w: any) => {
    userToWalletMap[w.titulaire_id] = w.id;
  });

  // 4. Mapping Final
  const transactions: Transaction[] = (txData as DBTransaction[]).map(tx => ({
    id: tx.id,
    amount: tx.montant,
    type: mapTransactionTypeToApi(tx.type),
    status: tx.status === 'completed' ? TransactionStatus.COMPLETED :
      tx.status === 'pending' ? TransactionStatus.PENDING : TransactionStatus.FAILED,
    createdAt: tx.created_at,
    description: tx.description || '',
    sourceWalletId: tx.donneur_ordre_id ? userToWalletMap[tx.donneur_ordre_id] : undefined,
    destinationWalletId: tx.beneficiaire_id ? userToWalletMap[tx.beneficiaire_id] : undefined
  }));

  res.json(transactions);
});

// Create Transaction
app.post('/api/transactions', async (req: any, res: any) => {
  const { amount, type, destinationWalletId, sourceWalletId, description } = req.body;

  if (!amount || amount <= 0) return res.status(400).json({ error: "Montant invalide" });

  const dbType = mapApiTypeToDb(type);
  let donneurId = null;
  let beneficiaireId = null;

  try {
    // 1. Résolution des IDs Utilisateurs et Vérification Solde
    if (sourceWalletId) {
      const { data: sourceWallet } = await supabase.from('wallets').select('*').eq('id', sourceWalletId).single();
      if (!sourceWallet) throw new Error("Wallet source introuvable");

      // Vérification solde (sauf si c'est un dépôt externe, mais l'API demande sourceWalletId pour transfert/paiement)
      if ((dbType === 'transfer' || dbType === 'payment') && sourceWallet.solde < amount) {
        throw new Error("Solde insuffisant");
      }
      donneurId = sourceWallet.titulaire_id;
    }

    if (destinationWalletId) {
      const { data: destWallet } = await supabase.from('wallets').select('titulaire_id').eq('id', destinationWalletId).single();
      if (!destWallet) throw new Error("Wallet destinataire introuvable");
      beneficiaireId = destWallet.titulaire_id;
    }

    // 2. Exécution de la transaction (Simulation atomique via appels séquentiels)

    // Débit du donneur d'ordre (PAYMENT ou TRANSFER)
    if (sourceWalletId && (dbType === 'transfer' || dbType === 'payment')) {
      // Récupération du solde actuel
      const { data: sourceWalletData, error: sourceError } = await supabase
        .from('wallets')
        .select('solde')
        .eq('id', sourceWalletId)
        .single();

      if (sourceError || !sourceWalletData) {
        throw new Error("Impossible de lire le solde du wallet source");
      }

      // Mise à jour du solde (Décrémentation)
      const { error: updateSourceError } = await supabase
        .from('wallets')
        .update({ solde: sourceWalletData.solde - amount })
        .eq('id', sourceWalletId);

      if (updateSourceError) {
        throw new Error("Erreur lors du débit du wallet source");
      }
    }

    // Crédit du bénéficiaire (tous types si destination présente)
    if (destinationWalletId) {
      const { data: destWalletData } = await supabase.from('wallets').select('solde').eq('id', destinationWalletId).single();
      if (destWalletData) {
        await supabase.from('wallets').update({ solde: destWalletData.solde + amount }).eq('id', destinationWalletId);
      }
    }

    // Insert Transaction Record
    const { data: newTx, error: insertError } = await supabase
      .from('transactions')
      .insert({
        donneur_ordre_id: donneurId,
        beneficiaire_id: beneficiaireId,
        montant: amount,
        type: dbType,
        description,
        status: 'completed'
      })
      .select()
      .single();

    if (insertError) throw insertError;

    // Réponse au format API
    const responseTx: Transaction = {
      id: newTx.id,
      amount: newTx.montant,
      type: type, // Garder le type API original
      status: TransactionStatus.COMPLETED,
      createdAt: newTx.created_at,
      description: newTx.description,
      sourceWalletId,
      destinationWalletId
    };

    res.status(201).json(responseTx);

  } catch (err: any) {
    console.error(err);
    res.status(400).json({ error: err.message || "Erreur transaction" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend StudentPay (Supabase) running on http://localhost:${PORT}`);
});
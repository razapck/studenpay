import express from 'express';
import cors from 'cors';
import { supabase } from '../../shared/db';
import { Transaction, TransactionStatus, TransactionType, DBTransaction } from '../../shared/types';
import axios from 'axios';

const app = express();
const PORT = 3003;
const WALLET_SERVICE_URL = process.env.WALLET_SERVICE_URL || 'http://localhost:3002/api/wallets';

app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use((req: any, res: any, next: any) => {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    next();
});
app.use(express.json() as any);

// Handle preflight requests for Private Network Access
app.options('*', (req: any, res: any) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).send();
});

// --- HELPERS ---

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

// --- HELPER : construction des maps userId → walletId[] et userId → nom ---

async function buildUserMaps(userIds: Set<string>): Promise<{
    userToWalletMap: Record<string, string[]>;
    userToNameMap: Record<string, string>;
}> {
    const ids = Array.from(userIds);

    const [walletsResult, usersResult] = await Promise.all([
        supabase.from('wallets').select('id, titulaire_id').in('titulaire_id', ids),
        supabase.from('users').select('id, nom').in('id', ids)
    ]);

    // FIX : un userId peut avoir plusieurs wallets → on stocke un tableau
    const userToWalletMap: Record<string, string[]> = {};
    walletsResult.data?.forEach((w: any) => {
        if (!userToWalletMap[w.titulaire_id]) userToWalletMap[w.titulaire_id] = [];
        userToWalletMap[w.titulaire_id].push(w.id);
    });

    const userToNameMap: Record<string, string> = {};
    usersResult.data?.forEach((u: any) => {
        userToNameMap[u.id] = u.nom;
    });

    return { userToWalletMap, userToNameMap };
}

// --- HELPER : mapping d'une DBTransaction → Transaction API ---

function mapDbTxToApi(
    tx: DBTransaction,
    contextUserId: string | null, // null pour la vue admin (tous les dépôts)
    userToWalletMap: Record<string, string[]>,
    userToNameMap: Record<string, string>,
    sourceWalletIdOverride?: string,
    destinationWalletIdOverride?: string
): Transaction {
    const isReceived = contextUserId ? tx.beneficiaire_id === contextUserId : true;
    const otherPartyId = isReceived ? tx.donneur_ordre_id : tx.beneficiaire_id;
    const otherPartyName = otherPartyId ? (userToNameMap[otherPartyId] ?? 'Inconnu') : 'Inconnu';

    let description = tx.description || '';

    if (tx.type === 'transfer') {
        description = isReceived
            ? `Virement reçu de ${otherPartyName}`
            : `Virement envoyé à ${otherPartyName}`;
    } else if (tx.type === 'payment') {
        description = isReceived
            ? `Paiement reçu de ${otherPartyName}`
            : `Paiement ${otherPartyName}`;
    }

    // FIX : on prend le 1er wallet du tableau (ou l'override passé en paramètre)
    const sourceWalletId = sourceWalletIdOverride
        ?? (tx.donneur_ordre_id ? (userToWalletMap[tx.donneur_ordre_id]?.[0]) : undefined);
    const destinationWalletId = destinationWalletIdOverride
        ?? (tx.beneficiaire_id ? (userToWalletMap[tx.beneficiaire_id]?.[0]) : undefined);

    return {
        id: tx.id,
        amount: tx.montant,
        type: mapTransactionTypeToApi(tx.type),
        status: tx.status === 'completed' ? TransactionStatus.COMPLETED :
            tx.status === 'pending' ? TransactionStatus.PENDING : TransactionStatus.FAILED,
        createdAt: tx.created_at,
        description,
        sourceWalletId,
        destinationWalletId
    };
}

// --- TRANSACTIONS ---

// ----------------------------------------------------------------
// FIX NOUVEAU : GET /api/transactions — Vue admin, filtre par type
// Utilisé par ReceivedDeposits pour lister tous les dépôts reçus
// Exemple : GET /api/transactions?type=deposit
// ----------------------------------------------------------------
app.get('/api/transactions', async (req: any, res: any) => {
    const { type } = req.query;

    // Construction de la requête Supabase
    let query = supabase
        .from('transactions')
        .select('*')
        .order('created_at', { ascending: false });

    if (type) {
        const dbType = mapApiTypeToDb(type as string);
        query = query.eq('type', dbType);
    }

    const { data: txData, error: txError } = await query;

    if (txError) {
        return res.status(500).json({ error: txError.message });
    }

    if (!txData || txData.length === 0) {
        return res.json([]);
    }

    // Collecte de tous les userIds impliqués
    const userIds = new Set<string>();
    (txData as DBTransaction[]).forEach(tx => {
        if (tx.donneur_ordre_id) userIds.add(tx.donneur_ordre_id);
        if (tx.beneficiaire_id) userIds.add(tx.beneficiaire_id);
    });

    const { userToWalletMap, userToNameMap } = await buildUserMaps(userIds);

    const transactions: Transaction[] = (txData as DBTransaction[]).map(tx =>
        mapDbTxToApi(tx, null, userToWalletMap, userToNameMap)
    );

    res.json(transactions);
});

// ----------------------------------------------------------------
// GET /api/transactions/:walletId — Historique d'un wallet précis
// ----------------------------------------------------------------
app.get('/api/transactions/:walletId', async (req: any, res: any) => {
    const { walletId } = req.params;

    // 1. Résoudre le userId associé au walletId
    const { data: walletData, error: walletError } = await supabase
        .from('wallets')
        .select('titulaire_id')
        .eq('id', walletId)
        .single();

    if (walletError || !walletData) {
        return res.status(404).json({ error: "Wallet introuvable" });
    }

    const userId = walletData.titulaire_id;

    // 2. Récupérer toutes les transactions impliquant ce userId
    const { data: txData, error: txError } = await supabase
        .from('transactions')
        .select('*')
        .or(`donneur_ordre_id.eq.${userId},beneficiaire_id.eq.${userId}`)
        .order('created_at', { ascending: false });

    if (txError) {
        return res.status(500).json({ error: txError.message });
    }

    if (!txData || txData.length === 0) {
        return res.json([]);
    }

    // 3. Construire les maps userId → walletId[] et userId → nom
    const userIds = new Set<string>();
    (txData as DBTransaction[]).forEach(tx => {
        if (tx.donneur_ordre_id) userIds.add(tx.donneur_ordre_id);
        if (tx.beneficiaire_id) userIds.add(tx.beneficiaire_id);
    });

    const { userToWalletMap, userToNameMap } = await buildUserMaps(userIds);

    // 4. Mapping final
    // FIX : pour les transactions impliquant le walletId demandé, on force
    // sourceWalletId ou destinationWalletId à ce walletId précis
    const transactions: Transaction[] = (txData as DBTransaction[]).map(tx => {
        const isSender = tx.donneur_ordre_id === userId;
        const isReceiver = tx.beneficiaire_id === userId;

        const sourceWalletIdOverride = isSender ? walletId : undefined;
        const destinationWalletIdOverride = isReceiver ? walletId : undefined;

        return mapDbTxToApi(
            tx,
            userId,
            userToWalletMap,
            userToNameMap,
            sourceWalletIdOverride,
            destinationWalletIdOverride
        );
    });

    res.json(transactions);
});

// ----------------------------------------------------------------
// POST /api/transactions — Création d'une transaction
// ----------------------------------------------------------------
app.post('/api/transactions', async (req: any, res: any) => {
    const { amount, type, destinationWalletId, sourceWalletId, description } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: "Montant invalide" });

    const dbType = mapApiTypeToDb(type);
    let donneurId = null;
    let beneficiaireId = null;

    try {
        // 1. Validation et résolution des IDs via Wallet Service
        if (sourceWalletId) {
            try {
                const sourceResp = await axios.get(`${WALLET_SERVICE_URL}/${sourceWalletId}`);
                donneurId = sourceResp.data.userId;

                if ((dbType === 'transfer' || dbType === 'payment') && sourceResp.data.balance < amount) {
                    throw new Error("Solde insuffisant");
                }
            } catch (err: any) {
                const msg = err.response?.data?.error || err.message;
                console.error(`Error fetching source wallet (${sourceWalletId}):`, msg);
                throw new Error(`Wallet source introuvable ou erreur service: ${msg}`);
            }
        }

        if (destinationWalletId) {
            try {
                const destResp = await axios.get(`${WALLET_SERVICE_URL}/${destinationWalletId}`);
                beneficiaireId = destResp.data.userId;
            } catch (err: any) {
                const msg = err.response?.data?.error || err.message;
                console.error(`Error fetching destination wallet (${destinationWalletId}):`, msg);
                throw new Error(`Wallet destinataire introuvable ou erreur service: ${msg}`);
            }
        }

        // 2. Exécution distribuée

        // Débit source
        if (sourceWalletId && (dbType === 'transfer' || dbType === 'payment')) {
            try {
                await axios.post(`${WALLET_SERVICE_URL}/${sourceWalletId}/debit`, { amount });
            } catch (err: any) {
                throw new Error(err.response?.data?.error || "Erreur lors du débit du wallet source");
            }
        }

        // Crédit destination
        if (destinationWalletId) {
            try {
                await axios.post(`${WALLET_SERVICE_URL}/${destinationWalletId}/credit`, { amount });
            } catch (err: any) {
                // CRITICAL: débit effectué mais crédit échoué → incohérence
                // TODO: Implémenter compensation (rembourser source).
                console.error("CRITICAL: Credit failed after Debit succeeded", err);
                throw new Error("Erreur lors du crédit du wallet destinataire (Fonds débités)");
            }
        }

        // 3. Enregistrement en base
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

        const responseTx: Transaction = {
            id: newTx.id,
            amount: newTx.montant,
            type: type,
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

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Transaction Service running on http://localhost:${PORT}`);
    });
}

export { app };

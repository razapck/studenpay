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

// --- TRANSACTIONS ---

// Get Transactions for a Wallet
app.get('/api/transactions/:walletId', async (req: any, res: any) => {
    const { walletId } = req.params;

    // 1. Trouver le User ID associé à ce wallet
    // On appelle le Wallet Service pour avoir les infos du wallet (ou on requête la DB directement car on partage la DB)
    // Pour simplifier et garder la cohérence "microservice", on pourrait appeler le service, mais ici on a accès à la DB.
    // Le plan disait "Partage DB", donc on peut faire des requêtes DB directes pour la lecture si c'est plus simple,
    // mais pour l'écriture (balance), on doit passer par le service.
    // Pour la lecture des transactions, on a besoin de l'ID titulaire.

    const { data: walletData, error: walletError } = await supabase
        .from('wallets')
        .select('titulaire_id')
        .eq('id', walletId)
        .single();

    if (walletError || !walletData) {
        return res.status(404).json({ error: "Wallet introuvable" });
    }

    const userId = walletData.titulaire_id;

    // 2. Récupérer les transactions
    const { data: txData, error: txError } = await supabase
        .from('transactions')
        .select('*')
        .or(`donneur_ordre_id.eq.${userId},beneficiaire_id.eq.${userId}`)
        .order('created_at', { ascending: false });

    if (txError) {
        return res.status(500).json({ error: txError.message });
    }

    // 3. Mapping User IDs -> Wallet IDs & User Names
    // Ici on a besoin de savoir quels wallets correspondent aux users des transactions.
    // On peut faire une requête DB directe pour ça aussi.
    const userIds = new Set<string>();
    (txData as DBTransaction[]).forEach(tx => {
        if (tx.donneur_ordre_id) userIds.add(tx.donneur_ordre_id);
        if (tx.beneficiaire_id) userIds.add(tx.beneficiaire_id);
    });

    const { data: walletsMapData } = await supabase
        .from('wallets')
        .select('id, titulaire_id')
        .in('titulaire_id', Array.from(userIds));

    const { data: usersData } = await supabase
        .from('users')
        .select('id, nom')
        .in('id', Array.from(userIds));

    const userToWalletMap: Record<string, string> = {};
    walletsMapData?.forEach((w: any) => {
        userToWalletMap[w.titulaire_id] = w.id;
    });

    const userToNameMap: Record<string, string> = {};
    usersData?.forEach((u: any) => {
        userToNameMap[u.id] = u.nom;
    });

    // 4. Mapping Final
    const transactions: Transaction[] = (txData as DBTransaction[]).map(tx => {
        const isReceived = tx.beneficiaire_id === userId;
        const otherPartyId = isReceived ? tx.donneur_ordre_id : tx.beneficiaire_id;
        const otherPartyName = otherPartyId ? userToNameMap[otherPartyId] : 'Inconnu';

        let description = tx.description || '';

        // Logique de formatage du libellé
        if (tx.type === 'transfer') {
            if (isReceived) {
                description = `Virement recu de ${otherPartyName}`;
            } else {
                description = `Virement envoyé à ${otherPartyName}`;
            }
        } else if (tx.type === 'payment') {
            if (isReceived) {
                description = `Paiement reçu de ${otherPartyName}`;
            } else {
                description = `Paiement ${otherPartyName}`;
            }
        }

        return {
            id: tx.id,
            amount: tx.montant,
            type: mapTransactionTypeToApi(tx.type),
            status: tx.status === 'completed' ? TransactionStatus.COMPLETED :
                tx.status === 'pending' ? TransactionStatus.PENDING : TransactionStatus.FAILED,
            createdAt: tx.created_at,
            description: description,
            sourceWalletId: tx.donneur_ordre_id ? userToWalletMap[tx.donneur_ordre_id] : undefined,
            destinationWalletId: tx.beneficiaire_id ? userToWalletMap[tx.beneficiaire_id] : undefined
        };
    });

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
        // 1. Validation et Résolution des IDs via Wallet Service
        if (sourceWalletId) {
            try {
                const sourceResp = await axios.get(`${WALLET_SERVICE_URL}/${sourceWalletId}`);
                donneurId = sourceResp.data.userId;

                // Vérification solde via Wallet Service
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

        // 2. Exécution (Distribuée)

        // Débit Source
        if (sourceWalletId && (dbType === 'transfer' || dbType === 'payment')) {
            try {
                await axios.post(`${WALLET_SERVICE_URL}/${sourceWalletId}/debit`, { amount });
            } catch (err: any) {
                throw new Error(err.response?.data?.error || "Erreur lors du débit du wallet source");
            }
        }

        // Crédit Destination
        if (destinationWalletId) {
            try {
                await axios.post(`${WALLET_SERVICE_URL}/${destinationWalletId}/credit`, { amount });
            } catch (err: any) {
                // CRITICAL: Si le débit a réussi mais le crédit échoue, on a une incohérence.
                // TODO: Implementer compensation (rembourser source).
                console.error("CRITICAL: Credit failed after Debit succeeded", err);
                throw new Error("Erreur lors du crédit du wallet destinataire (Fonds débités)");
            }
        }

        // 3. Enregistrement Transaction
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

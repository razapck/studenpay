import express from 'express';
import cors from 'cors';
import { db, uuidToBinary, binaryToUuid } from '../../shared/db';
import { Transaction, TransactionStatus, TransactionType } from '../../shared/types';
import axios from 'axios';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

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

    try {
        // 1. Trouver le User ID associé à ce wallet
        const [walletRows] = await db.execute<RowDataPacket[]>(
            'SELECT titulaire_id FROM wallets WHERE id = ?',
            [uuidToBinary(walletId)]
        );

        if (walletRows.length === 0) {
            return res.status(404).json({ error: "Wallet introuvable" });
        }

        const userId = walletRows[0].titulaire_id;

        // 2. Récupérer les transactions
        const [txRows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM transactions WHERE donneur_ordre_id = ? OR beneficiaire_id = ? ORDER BY created_at DESC',
            [userId, userId]
        );

        // 3. Mapping User IDs -> Wallet IDs & User Names
        const userIds = new Set<string>();
        txRows.forEach(tx => {
            if (tx.donneur_ordre_id) userIds.add(binaryToUuid(tx.donneur_ordre_id));
            if (tx.beneficiaire_id) userIds.add(binaryToUuid(tx.beneficiaire_id));
        });

        const userToWalletMap: Record<string, string> = {};
        const userToNameMap: Record<string, string> = {};

        if (userIds.size > 0) {
            const placeholders = Array.from(userIds).map(() => '?').join(',');

            // Map Wallets
            const [walletsMapRows] = await db.execute<RowDataPacket[]>(
                `SELECT id, titulaire_id FROM wallets WHERE titulaire_id IN (${placeholders})`,
                Array.from(userIds).map(uuid => uuidToBinary(uuid))
            );
            walletsMapRows.forEach(w => {
                userToWalletMap[binaryToUuid(w.titulaire_id)] = binaryToUuid(w.id);
            });

            // Map User Names
            const [usersRows] = await db.execute<RowDataPacket[]>(
                `SELECT id, nom FROM users WHERE id IN (${placeholders})`,
                Array.from(userIds).map(uuid => uuidToBinary(uuid))
            );
            usersRows.forEach(u => {
                userToNameMap[binaryToUuid(u.id)] = u.nom;
            });
        }

        const currentUserIdStr = binaryToUuid(userId);

        // 4. Mapping Final
        const transactions: Transaction[] = txRows.map(tx => {
            const isReceived = binaryToUuid(tx.beneficiaire_id) === currentUserIdStr;
            const otherPartyId = isReceived ? binaryToUuid(tx.donneur_ordre_id) : binaryToUuid(tx.beneficiaire_id);
            const otherPartyName = otherPartyId ? userToNameMap[otherPartyId] : 'Inconnu';

            let description = tx.description || '';

            if (tx.type === 'transfer') {
                description = isReceived ? `Virement recu de ${otherPartyName}` : `Virement envoyé à ${otherPartyName}`;
            } else if (tx.type === 'payment') {
                description = isReceived ? `Paiement reçu de ${otherPartyName}` : `Paiement ${otherPartyName}`;
            }

            return {
                id: binaryToUuid(tx.id),
                amount: tx.montant,
                type: mapTransactionTypeToApi(tx.type),
                status: tx.status === 'completed' ? TransactionStatus.COMPLETED :
                    tx.status === 'pending' ? TransactionStatus.PENDING : TransactionStatus.FAILED,
                createdAt: tx.created_at,
                description: description,
                sourceWalletId: tx.donneur_ordre_id ? userToWalletMap[binaryToUuid(tx.donneur_ordre_id)] : undefined,
                destinationWalletId: tx.beneficiaire_id ? userToWalletMap[binaryToUuid(tx.beneficiaire_id)] : undefined
            };
        });

        res.json(transactions);
    } catch (error: any) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
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

                if ((dbType === 'transfer' || dbType === 'payment') && sourceResp.data.balance < amount) {
                    throw new Error("Solde insuffisant");
                }
            } catch (err: any) {
                const msg = err.response?.data?.error || err.message;
                throw new Error(`Wallet source introuvable ou erreur service: ${msg}`);
            }
        }

        if (destinationWalletId) {
            try {
                const destResp = await axios.get(`${WALLET_SERVICE_URL}/${destinationWalletId}`);
                beneficiaireId = destResp.data.userId;
            } catch (err: any) {
                const msg = err.response?.data?.error || err.message;
                throw new Error(`Wallet destinataire introuvable ou erreur service: ${msg}`);
            }
        }

        // 2. Exécution (Distribuée via Wallet Service)
        if (sourceWalletId && (dbType === 'transfer' || dbType === 'payment')) {
            await axios.post(`${WALLET_SERVICE_URL}/${sourceWalletId}/debit`, { amount });
        }

        if (destinationWalletId) {
            try {
                await axios.post(`${WALLET_SERVICE_URL}/${destinationWalletId}/credit`, { amount });
            } catch (err: any) {
                console.error("CRITICAL: Credit failed after Debit succeeded", err);
                throw new Error("Erreur lors du crédit du wallet destinataire (Fonds débités)");
            }
        }

        // 3. Enregistrement Transaction
        const txId = require('crypto').randomUUID();
        await db.execute(
            'INSERT INTO transactions (id, donneur_ordre_id, beneficiaire_id, montant, type, description, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                uuidToBinary(txId),
                donneurId ? uuidToBinary(donneurId) : null,
                beneficiaireId ? uuidToBinary(beneficiaireId) : null,
                amount,
                dbType,
                description,
                'completed'
            ]
        );

        const responseTx: Transaction = {
            id: txId,
            amount: amount,
            type: type,
            status: TransactionStatus.COMPLETED,
            createdAt: new Date().toISOString(),
            description: description,
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

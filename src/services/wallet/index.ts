import express from 'express';
import cors from 'cors';
import { db, uuidToBinary, binaryToUuid } from '../../shared/db';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

const app = express();
const PORT = 3002;

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
const mapDbWalletToApi = (w: any) => ({
    id: binaryToUuid(w.id),
    userId: binaryToUuid(w.titulaire_id),
    balance: w.solde,
    currency: w.monnaie
});

// --- WALLET ---

// Get Wallet by User ID
app.get('/api/wallets/user/:userId', async (req: any, res: any) => {
    const { userId } = req.params;

    try {
        const [rows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM wallets WHERE titulaire_id = ?',
            [uuidToBinary(userId)]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Wallet introuvable" });
        }

        res.json(mapDbWalletToApi(rows[0]));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Get All Wallets
app.get('/api/wallets', async (req: any, res: any) => {
    try {
        const [rows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM wallets ORDER BY created_at DESC'
        );
        res.json(rows.map(mapDbWalletToApi));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Get Wallet by ID (Internal/Public)
app.get('/api/wallets/:id', async (req: any, res: any) => {
    const { id } = req.params;

    try {
        const [rows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM wallets WHERE id = ?',
            [uuidToBinary(id)]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Wallet introuvable" });
        }

        res.json(mapDbWalletToApi(rows[0]));
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

// Debit Wallet (Internal)
app.post('/api/wallets/:id/debit', async (req: any, res: any) => {
    const { id } = req.params;
    const { amount } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: "Montant invalide" });

    try {
        const connection = await db.getConnection();
        await connection.beginTransaction();

        try {
            const [rows] = await connection.execute<RowDataPacket[]>(
                'SELECT solde FROM wallets WHERE id = ? FOR UPDATE',
                [uuidToBinary(id)]
            );

            if (rows.length === 0) throw new Error("Wallet introuvable");

            const wallet = rows[0];
            if (wallet.solde < amount) {
                throw new Error("Solde insuffisant");
            }

            await connection.execute(
                'UPDATE wallets SET solde = solde - ? WHERE id = ?',
                [amount, uuidToBinary(id)]
            );

            await connection.commit();
            res.json({ success: true });
        } catch (err: any) {
            await connection.rollback();
            res.status(400).json({ error: err.message });
        } finally {
            connection.release();
        }
    } catch (error: any) {
        res.status(500).json({ error: "Erreur lors du débit" });
    }
});

// Credit Wallet (Internal)
app.post('/api/wallets/:id/credit', async (req: any, res: any) => {
    const { id } = req.params;
    const { amount } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: "Montant invalide" });

    try {
        const [result] = await db.execute<ResultSetHeader>(
            'UPDATE wallets SET solde = solde + ? WHERE id = ?',
            [amount, uuidToBinary(id)]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Wallet introuvable" });
        }

        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ error: "Erreur lors du crédit" });
    }
});

// --- WALLET CRUD ---

// Create Wallet
app.post('/api/wallets', async (req: any, res: any) => {
    const { userId, balance = 0, currency = 'EUR' } = req.body;

    if (!userId) return res.status(400).json({ error: "userId requis" });

    try {
        const id = require('crypto').randomUUID();
        await db.execute(
            'INSERT INTO wallets (id, titulaire_id, solde, monnaie) VALUES (?, ?, ?, ?)',
            [uuidToBinary(id), uuidToBinary(userId), balance, currency]
        );

        const [rows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM wallets WHERE id = ?',
            [uuidToBinary(id)]
        );

        res.status(201).json(mapDbWalletToApi(rows[0]));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

// Update Wallet
app.put('/api/wallets/:id', async (req: any, res: any) => {
    const { id } = req.params;
    const { balance, currency } = req.body;

    try {
        const updates: string[] = [];
        const params: any[] = [];

        if (balance !== undefined) { updates.push('solde = ?'); params.push(balance); }
        if (currency !== undefined) { updates.push('monnaie = ?'); params.push(currency); }

        if (updates.length > 0) {
            params.push(uuidToBinary(id));
            await db.execute(
                `UPDATE wallets SET ${updates.join(', ')} WHERE id = ?`,
                params
            );
        }

        const [rows] = await db.execute<RowDataPacket[]>(
            'SELECT * FROM wallets WHERE id = ?',
            [uuidToBinary(id)]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Wallet introuvable" });
        }

        res.json(mapDbWalletToApi(rows[0]));
    } catch (error: any) {
        res.status(404).json({ error: "Erreur de mise à jour: " + error.message });
    }
});

// Delete Wallet
app.delete('/api/wallets/:id', async (req: any, res: any) => {
    const { id } = req.params;

    try {
        const [result] = await db.execute<ResultSetHeader>(
            'DELETE FROM wallets WHERE id = ?',
            [uuidToBinary(id)]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Wallet introuvable" });
        }

        res.json({ success: true, message: "Wallet supprimé" });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Wallet Service running on http://localhost:${PORT}`);
    });
}
export { app };

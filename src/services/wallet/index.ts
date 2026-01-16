import express from 'express';
import cors from 'cors';
import { supabase } from '../../shared/db';

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

// Get All Wallets
app.get('/api/wallets', async (req: any, res: any) => {
    const { data, error } = await supabase
        .from('wallets')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        return res.status(500).json({ error: error.message });
    }

    // Mapping DB -> API
    const wallets = data.map((w: any) => ({
        id: w.id,
        userId: w.titulaire_id,
        balance: w.solde,
        currency: w.monnaie
    }));

    res.json(wallets);
});

// Get Wallet by ID (Internal/Public)
app.get('/api/wallets/:id', async (req: any, res: any) => {
    const { id } = req.params;

    const { data, error } = await supabase
        .from('wallets')
        .select('*')
        .eq('id', id)
        .single();

    if (error || !data) {
        return res.status(404).json({ error: "Wallet introuvable" });
    }

    res.json({
        id: data.id,
        userId: data.titulaire_id,
        balance: data.solde,
        currency: data.monnaie
    });
});

// Debit Wallet (Internal)
app.post('/api/wallets/:id/debit', async (req: any, res: any) => {
    const { id } = req.params;
    const { amount } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: "Montant invalide" });

    const { data: wallet, error: fetchError } = await supabase
        .from('wallets')
        .select('solde')
        .eq('id', id)
        .single();

    if (fetchError || !wallet) return res.status(404).json({ error: "Wallet introuvable" });

    if (wallet.solde < amount) {
        return res.status(400).json({ error: "Solde insuffisant" });
    }

    const { error: updateError } = await supabase
        .from('wallets')
        .update({ solde: wallet.solde - amount })
        .eq('id', id);

    if (updateError) return res.status(500).json({ error: "Erreur lors du débit" });

    res.json({ success: true });
});

// Credit Wallet (Internal)
app.post('/api/wallets/:id/credit', async (req: any, res: any) => {
    const { id } = req.params;
    const { amount } = req.body;

    if (!amount || amount <= 0) return res.status(400).json({ error: "Montant invalide" });

    const { data: wallet, error: fetchError } = await supabase
        .from('wallets')
        .select('solde')
        .eq('id', id)
        .single();

    if (fetchError || !wallet) return res.status(404).json({ error: "Wallet introuvable" });

    const { error: updateError } = await supabase
        .from('wallets')
        .update({ solde: wallet.solde + amount })
        .eq('id', id);

    if (updateError) return res.status(500).json({ error: "Erreur lors du crédit" });

    res.json({ success: true });
});

// --- WALLET CRUD ---

// Create Wallet
app.post('/api/wallets', async (req: any, res: any) => {
    const { userId, balance = 0, currency = 'EUR' } = req.body;

    if (!userId) return res.status(400).json({ error: "userId requis" });

    const { data, error } = await supabase
        .from('wallets')
        .insert({
            titulaire_id: userId,
            solde: balance,
            monnaie: currency
        })
        .select()
        .single();

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    res.status(201).json({
        id: data.id,
        userId: data.titulaire_id,
        balance: data.solde,
        currency: data.monnaie
    });
});

// Update Wallet
app.put('/api/wallets/:id', async (req: any, res: any) => {
    const { id } = req.params;
    const { balance, currency } = req.body;

    const updateData: any = {};
    if (balance !== undefined) updateData.solde = balance;
    if (currency !== undefined) updateData.monnaie = currency;

    const { data, error } = await supabase
        .from('wallets')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

    if (error || !data) {
        return res.status(404).json({ error: "Wallet introuvable ou erreur de mise à jour" });
    }

    res.json({
        id: data.id,
        userId: data.titulaire_id,
        balance: data.solde,
        currency: data.monnaie
    });
});

// Delete Wallet
app.delete('/api/wallets/:id', async (req: any, res: any) => {
    const { id } = req.params;

    const { error } = await supabase
        .from('wallets')
        .delete()
        .eq('id', id);

    if (error) {
        return res.status(400).json({ error: error.message });
    }

    res.json({ success: true, message: "Wallet supprimé" });
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Wallet Service running on http://localhost:${PORT}`);
    });
}
export { app };

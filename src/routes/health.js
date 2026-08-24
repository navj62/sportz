import { Router } from 'express';
import { pool } from '../db/db.js';
import { logger } from '../logger.js';

export const healthRouter = Router();

healthRouter.get('/', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'ok' });
    } catch (err) {
        logger.error({ err }, 'Health check: DB unreachable');
        res.status(503).json({ status: 'error', db: 'unreachable' });
    }
});

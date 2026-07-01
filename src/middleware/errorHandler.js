import { logger } from '../logger.js';

export function errorHandler(err, req, res, next) {
    logger.error({ err, method: req.method, url: req.url }, 'Unhandled error');
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error' });
}

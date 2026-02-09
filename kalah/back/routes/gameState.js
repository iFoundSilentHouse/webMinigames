import express from 'express';
import { connections, sendSSE, games, broadcastGameState } from '../controller/gameState.js';

const router = express.Router();

// Middleware для SSE
const sseHeaders = (req, res, next) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    next();
};

// SSE endpoint
router.get('/sse/:playerId/:gameId', sseHeaders, (req, res) => {
    const { playerId, gameId } = req.params;

    console.log(`[SSE CONNECT] Игрок ${playerId} подключается к игре ${gameId}`);

    connections.set(playerId, { res, gameId });

    sendSSE(res, {
        type: 'connected',
        playerId,
        timestamp: Date.now(),
        message: 'Подключено'
    });

    const game = games.get(gameId);
    if (game) {
        sendSSE(res, {
            type: 'game_state',
            game: game.state,
            timestamp: Date.now()
        });
    }

    const heartbeat = setInterval(() => {
        try {
            sendSSE(res, { type: 'ping', timestamp: Date.now() });
        } catch (e) {
            clearInterval(heartbeat);
        }
    }, 25000);

    req.on('close', () => {
        console.log(`[SSE DISCONNECT] Игрок ${playerId} отключился`);
        clearInterval(heartbeat);
        connections.delete(playerId);
    });
});

export default router;
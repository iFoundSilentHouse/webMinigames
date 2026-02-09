import express from 'express';
import { games, connections } from '../controller/gameState.js';

const router = express.Router();

router.get('/stats', (req, res) => {
    const stats = {
        games: games.size,
        connections: connections.size,
        players: Array.from(games.values()).reduce((sum, game) => {
            return sum + (game.players?.length || 0);
        }, 0),
        activeGames: Array.from(games.values()).filter(g => g.state.status === 'playing').length,
        finishedGames: Array.from(games.values()).filter(g => g.state.status === 'finished').length,
        waitingGames: Array.from(games.values()).filter(g => g.state.status === 'waiting').length,
        timestamp: Date.now(),
        server: 'Kalah Game Server v2.0'
    };

    res.json(stats);
});

export default router;
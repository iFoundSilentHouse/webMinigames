import express from 'express';
import { 
    games, 
    connections, 
    broadcastGameState, 
    sendSSE 
} from '../controller/gameState.js';
import {
    initializeKalahBoard,
    makeKalahMove,
    checkGameEnd
} from '../controller/gameLogic.js';

const router = express.Router();

// ========== API endpoints ==========

// Создание игры
router.post('/game/create', (req, res) => {
    try {
        const { playerName } = req.body;
        const gameId = `kalah_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const board = initializeKalahBoard();

        const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        const game = {
            id: gameId,
            players: [{
                id: playerId,
                name: playerName || 'Игрок 1',
                playerIndex: 0,
                connected: false,
                joinedAt: Date.now()
            }],
            state: {
                board: board,
                currentPlayer: 0, // Должно быть 0, а не 1
                status: 'waiting', // Ожидание второго игрока
                winner: null,
                scores: { player1: 0, player2: 0 },
                messages: [{
                    type: 'system',
                    text: `🎮 Игра создана! Ожидание второго игрока...`,
                    timestamp: Date.now()
                }],
                gameType: 'kalah',
                rematchOfferedBy: null,
                rematchGameId: null
            },
            createdAt: Date.now(),
            gameHistory: []
        };

        games.set(gameId, game);
        console.log(`[CREATE] Создана игра ${gameId} игроком ${playerName}`);

        res.json({
            success: true,
            gameId,
            playerId,
            playerIndex: 0,
            game: game.state,
            message: 'Игра создана. Пригласите второго игрока!'
        });

    } catch (error) {
        console.error('Ошибка создания игры:', error);
        res.status(500).json({
            success: false,
            error: 'Ошибка создания игры'
        });
    }
});

// Подключение к игре
router.post('/game/:gameId/join', (req, res) => {
    try {
        const { gameId } = req.params;
        const { playerName } = req.body;

        console.log(`[JOIN] Запрос на подключение к игре ${gameId} от ${playerName || 'анонима'}`);

        const game = games.get(gameId);
        if (!game) {
            console.log(`[JOIN ERROR] Игра ${gameId} не найдена`);
            return res.status(404).json({
                success: false,
                error: 'Игра не найдена'
            });
        }

        // Проверяем, не пытается ли создатель присоединиться повторно
        if (game.players.length === 1 && game.players[0].name === playerName) {
            console.log(`[JOIN] Создатель ${playerName} пытается присоединиться повторно, возвращаем его данные`);
            return res.json({
                success: true,
                playerId: game.players[0].id,
                playerIndex: 0,
                game: game.state,
                message: `Вы уже создали эту игру`
            });
        }

        if (game.players.length >= 2) {
            console.log(`[JOIN ERROR] Игра ${gameId} уже имеет 2 игроков`);
            return res.status(400).json({
                success: false,
                error: 'Игра уже началась'
            });
        }

        // Создаем нового игрока
        const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const player = {
            id: playerId,
            name: playerName || `Игрок ${game.players.length + 1}`,
            playerIndex: game.players.length, // 0 для первого, 1 для второго
            connected: false,
            joinedAt: Date.now()
        };

        // Добавляем игрока в игру
        game.players.push(player);
        console.log(`[JOIN] Игрок ${player.name} (${playerId}) присоединился как игрок ${player.playerIndex + 1}`);

        // Если теперь у нас 2 игрока - активируем игру
        let gameActivated = false;
        if (game.players.length === 2) {
            console.log(`[JOIN] В игре ${gameId} теперь 2 игрока, активируем...`);
            
            // Активируем игру
            game.state.status = 'playing';
            game.state.currentPlayer = 0; // Первый ход у игрока 1
            
            // Убедимся, что доска инициализирована
            if (!game.state.board || game.state.board.length !== 14) {
                console.log(`[JOIN] Доска не инициализирована, создаем новую`);
                game.state.board = initializeKalahBoard();
            }
            
            // Добавляем системное сообщение
            const startMessage = {
                type: 'system',
                text: `🎮 Игра началась! ${game.players[0].name} против ${game.players[1].name}. Первый ход у ${game.players[0].name}`,
                timestamp: Date.now()
            };
            
            if (!game.state.messages) {
                game.state.messages = [];
            }
            game.state.messages.push(startMessage);
            
            gameActivated = true;
            console.log(`[JOIN] Игра ${gameId} активирована! Статус: ${game.state.status}, Текущий игрок: ${game.state.currentPlayer}`);
        } else {
            console.log(`[JOIN] В игре ${gameId} теперь ${game.players.length} игрок(ов), статус: ${game.state.status}`);
        }

        // Обязательно сохраняем обновленную игру в Map
        games.set(gameId, game);
        console.log(`[JOIN] Игра ${gameId} сохранена в Map, всего игр: ${games.size}`);

        // Формируем ответ
        const responseData = {
            success: true,
            playerId: playerId,
            playerIndex: player.playerIndex,
            game: { ...game.state }, // Отправляем копию состояния
            message: gameActivated 
                ? `Вы присоединились как ${player.name}. Игра началась!` 
                : `Вы присоединились как ${player.name}. Ожидайте второго игрока...`
        };

        console.log(`[JOIN] Отправляем ответ клиенту ${playerId}`);

        // Отправляем ответ клиенту
        res.json(responseData);

        // Рассылаем обновление состояния ВСЕМ игрокам с небольшой задержкой
        setTimeout(() => {
            console.log(`[JOIN BROADCAST] Рассылка обновления для игры ${gameId}`);
            console.log(`[JOIN BROADCAST] Статус игры: ${game.state.status}`);
            console.log(`[JOIN BROADCAST] Игроков в игре: ${game.players.length}`);
            console.log(`[JOIN BROADCAST] Активные соединения: ${connections.size}`);
            
            // Рассылаем всем игрокам этой игры
            game.players.forEach(p => {
                const conn = connections.get(p.id);
                console.log(`[JOIN BROADCAST] Игрок ${p.id} (${p.name}): ${conn ? 'имеет соединение' : 'нет соединения'}`);
            });
            
            broadcastGameState(gameId, 'server');
            
        }, 150); // Даем время клиенту обработать ответ

    } catch (error) {
        console.error('[JOIN] Критическая ошибка:', error);
        console.error(error.stack);
        res.status(500).json({
            success: false,
            error: 'Внутренняя ошибка сервера при подключении'
        });
    }
});

router.get('/game/:gameId/debug', (req, res) => {
    try {
        const { gameId } = req.params;
        const game = games.get(gameId);
        
        if (!game) {
            return res.json({
                exists: false,
                message: 'Игра не найдена'
            });
        }
        
        const debugInfo = {
            exists: true,
            gameId: game.id,
            status: game.state.status,
            players: game.players.map(p => ({
                id: p.id,
                name: p.name,
                index: p.playerIndex,
                hasSSEConnection: connections.has(p.id)
            })),
            board: {
                exists: !!game.state.board,
                length: game.state.board?.length || 0,
                isKalahBoard: game.state.board?.length === 14,
                preview: game.state.board?.slice(0, 5) || []
            },
            currentPlayer: game.state.currentPlayer,
            messagesCount: game.state.messages?.length || 0,
            createdAt: new Date(game.createdAt).toISOString(),
            gamesInMemory: games.size,
            connectionsInMemory: connections.size
        };
        
        console.log(`[DEBUG] Запрос информации по игре ${gameId}:`, debugInfo);
        
        res.json(debugInfo);
        
    } catch (error) {
        console.error('[DEBUG] Ошибка:', error);
        res.status(500).json({ error: 'Ошибка отладки' });
    }
});

// Ход в Калахе
router.post('/game/:gameId/move', (req, res) => {
    try {
        const { gameId } = req.params;
        const { playerId, pitIndex } = req.body;

        console.log(`[MOVE] === НАЧАЛО ОБРАБОТКИ ХОДА ===`);
        console.log(`[MOVE] Game ID: ${gameId}`);
        console.log(`[MOVE] Player ID: ${playerId}`);
        console.log(`[MOVE] Pit Index: ${pitIndex}`);
        //
        const requestedId = req.params.gameId;
        console.log("[MOVE DEBUG] typeof gameId:", typeof requestedId);
        console.log("[MOVE DEBUG] gameId length:", requestedId.length);
        console.log("[MOVE DEBUG] gameId как hex:", Buffer.from(requestedId).toString('hex'));
        console.log("[MOVE DEBUG] Первый ключ в Map как hex:", Buffer.from(Array.from(games.keys())[0]).toString('hex'));
        console.log("[MOVE DEBUG] requestedId === первый ключ?:", requestedId === Array.from(games.keys())[0]);
        console.log("[MOVE DEBUG] requestedId.trim() === первый ключ?:", requestedId.trim() === Array.from(games.keys())[0]);
        //

        // 1. Проверяем, существует ли игра
        console.log(`[MOVE] Ищем игру ${gameId} в games Map...`);
        const game = games.get(gameId);
        if (!game) {
            console.error(`[MOVE ERROR] Игра ${gameId} не найдена в games Map!`);
            console.log(`[MOVE DEBUG] Всего игр в памяти: ${games.size}`);
            console.log(`[MOVE DEBUG] Доступные игры:`, Array.from(games.keys()));
            
            return res.status(404).json({
                success: false,
                error: 'Игра не найдена',
                debug: {
                    totalGames: games.size,
                    availableGames: Array.from(games.keys())
                }
            });
        }
        
        console.log(`[MOVE] Игра найдена: ID=${game.id}, статус=${game.state.status}`);

        // 2. Проверяем статус игры
        if (game.state.status !== 'playing') {
            console.error(`[MOVE ERROR] Игра не в статусе 'playing'. Текущий статус: ${game.state.status}`);
            return res.status(400).json({
                success: false,
                error: 'Игра еще не началась или уже завершена',
                currentStatus: game.state.status
            });
        }

        // 3. Ищем игрока
        console.log(`[MOVE] Ищем игрока ${playerId}...`);
        const player = game.players.find(p => p.id === playerId);
        if (!player) {
            console.error(`[MOVE ERROR] Игрок ${playerId} не найден в игре!`);
            console.log(`[MOVE DEBUG] Игроки в игре:`, game.players.map(p => ({ 
                id: p.id, 
                name: p.name,
                index: p.playerIndex 
            })));
            
            return res.status(404).json({
                success: false,
                error: 'Игрок не найден',
                debug: {
                    playersInGame: game.players.map(p => ({ id: p.id, name: p.name }))
                }
            });
        }
        
        console.log(`[MOVE] Игрок найден: ${player.name} (index: ${player.playerIndex})`);

        // 4. Проверяем, чей сейчас ход
        console.log(`[MOVE] Текущий игрок в состоянии: ${game.state.currentPlayer}, Игрок запроса: ${player.playerIndex}`);
        if (game.state.currentPlayer !== player.playerIndex) {
            console.error(`[MOVE ERROR] Не очередь игрока!`);
            return res.status(400).json({
                success: false,
                error: 'Не ваш ход',
                currentPlayer: game.state.currentPlayer,
                yourIndex: player.playerIndex
            });
        }

        // 5. Проверяем валидность лунки
        const playerStart = player.playerIndex === 0 ? 0 : 7;
        const playerEnd = player.playerIndex === 0 ? 5 : 12;
        
        console.log(`[MOVE] Игрок ${player.playerIndex} может ходить с лунок ${playerStart} по ${playerEnd}`);
        
        if (pitIndex < playerStart || pitIndex > playerEnd) {
            console.error(`[MOVE ERROR] Неверная лунка: ${pitIndex}`);
            return res.status(400).json({
                success: false,
                error: 'Неверная лунка',
                validRange: { start: playerStart, end: playerEnd }
            });
        }

        // 6. Проверяем, что лунка не пустая
        console.log(`[MOVE] Проверяем лунку ${pitIndex}: ${game.state.board[pitIndex]} камней`);
        if (game.state.board[pitIndex] === 0) {
            console.error(`[MOVE ERROR] Лунка ${pitIndex} пуста!`);
            return res.status(400).json({
                success: false,
                error: 'Лунка пуста',
                pitIndex: pitIndex,
                stones: game.state.board[pitIndex]
            });
        }

        // 7. Выполняем ход
        console.log(`[MOVE] Выполняем ход из лунки ${pitIndex}...`);
        const moveResult = makeKalahMove(game.state.board, pitIndex, player.playerIndex);
        console.log(`[MOVE] Ход выполнен. Результат:`, {
            extraTurn: moveResult.extraTurn,
            animationSteps: moveResult.animation?.length || 0,
            newBoardPreview: moveResult.board.slice(0, 7)
        });

        // 8. Обновляем состояние игры
        game.state.board = moveResult.board;
        
        // Добавляем сообщение о ходе
        const moveMessage = {
            type: 'move',
            text: `${player.name} сделал ход из лунки ${pitIndex}`,
            timestamp: Date.now(),
            player: player.name,
            playerIndex: player.playerIndex,
            pitIndex: pitIndex
        };
        
        if (!game.state.messages) {
            game.state.messages = [];
        }
        game.state.messages.push(moveMessage);
        console.log(`[MOVE] Добавлено сообщение о ходе`);

        // 9. Проверяем конец игры
        console.log(`[MOVE] Проверяем конец игры...`);
        const gameEndCheck = checkGameEnd(game.state.board);
        if (gameEndCheck.gameOver) {
            console.log(`[MOVE] Игра окончена! Победитель: ${gameEndCheck.winner}`);
            
            game.state.board = gameEndCheck.board;
            game.state.status = 'finished';
            game.state.winner = gameEndCheck.winner;
            game.state.scores = gameEndCheck.scores;

            const winnerName = gameEndCheck.winner === 'player1' ? game.players[0].name :
                gameEndCheck.winner === 'player2' ? game.players[1].name : 'Ничья';

            game.state.messages.push({
                type: 'system',
                text: `🏆 Игра окончена! ${winnerName} побеждает со счетом ${gameEndCheck.scores.player1}:${gameEndCheck.scores.player2}`,
                timestamp: Date.now()
            });

            game.gameHistory.push({
                winner: gameEndCheck.winner,
                scores: gameEndCheck.scores,
                finishedAt: Date.now(),
                players: game.players.map(p => ({ name: p.name, playerIndex: p.playerIndex }))
            });
            
        } else if (!moveResult.extraTurn) {
            // Меняем текущего игрока
            game.state.currentPlayer = game.state.currentPlayer === 0 ? 1 : 0;
            console.log(`[MOVE] Ход передан игроку ${game.state.currentPlayer}`);

            const nextPlayer = game.players.find(p => p.playerIndex === game.state.currentPlayer);
            game.state.messages.push({
                type: 'system',
                text: `➡️ Теперь ходит ${nextPlayer.name}`,
                timestamp: Date.now()
            });
        } else {
            console.log(`[MOVE] Игрок получает дополнительный ход`);
            game.state.messages.push({
                type: 'system',
                text: `🎯 ${player.name} получает дополнительный ход!`,
                timestamp: Date.now()
            });
        }

        // 10. Сохраняем обновленную игру
        games.set(gameId, game);
        console.log(`[MOVE] Игра сохранена. Новый статус: ${game.state.status}, текущий игрок: ${game.state.currentPlayer}`);

        // 11. Отправляем ответ клиенту
        const responseData = {
            success: true,
            game: { ...game.state }, // Отправляем копию состояния
            animation: moveResult.animation,
            message: 'Ход принят'
        };
        
        console.log(`[MOVE] Отправляем ответ клиенту`);
        res.json(responseData);

        // 12. Рассылаем обновление всем игрокам
        setTimeout(() => {
            console.log(`[MOVE BROADCAST] Рассылка обновления для игры ${gameId}`);
            console.log(`[MOVE BROADCAST] Игроков в игре: ${game.players.length}`);
            
            game.players.forEach(p => {
                const conn = connections.get(p.id);
                console.log(`[MOVE BROADCAST] Игрок ${p.name}: ${conn ? 'есть соединение' : 'нет соединения'}`);
            });
            
            broadcastGameState(gameId, playerId, moveResult.animation);
        }, 50);

        console.log(`[MOVE] === ОБРАБОТКА ХОДА ЗАВЕРШЕНА ===`);

    } catch (error) {
        console.error('[MOVE] Критическая ошибка:', error);
        console.error(error.stack);
        res.status(500).json({
            success: false,
            error: 'Ошибка при ходе',
            details: error.message
        });
    }
});

// Сдача в игре
router.post('/game/:gameId/surrender', (req, res) => {
    try {
        const { gameId } = req.params;
        const { playerId } = req.body;

        console.log(`[SURRENDER] Запрос от ${playerId} в игре ${gameId}`);

        const game = games.get(gameId);
        if (!game) {
            return res.status(404).json({ success: false, error: 'Игра не найдена' });
        }

        if (game.state.status !== 'playing') {
            return res.status(400).json({ success: false, error: 'Сдаться можно только во время игры' });
        }

        const player = game.players.find(p => p.id === playerId);
        if (!player) {
            return res.status(400).json({ success: false, error: 'Игрок не найден' });
        }

        // Определяем победителя (противник)
        const winnerIndex = player.playerIndex === 0 ? 1 : 0;
        const loserName = player.name;
        const winnerName = game.players[winnerIndex].name;

        // Завершаем игру
        game.state.status = 'finished';
        game.state.winner = `player${winnerIndex + 1}`;

        // Собираем финальные очки (как в checkGameEnd)
        const finalBoard = [...game.state.board];
        let player1Score = finalBoard[6];
        let player2Score = finalBoard[13];

        // Камни player1
        for (let i = 0; i <= 5; i++) {
            player1Score += finalBoard[i];
            finalBoard[i] = 0;
        }

        // Камни player2
        for (let i = 7; i <= 12; i++) {
            player2Score += finalBoard[i];
            finalBoard[i] = 0;
        }

        finalBoard[6] = player1Score;
        finalBoard[13] = player2Score;

        game.state.board = finalBoard;
        game.state.scores = { player1: player1Score, player2: player2Score };

        // Сообщение о сдаче
        game.state.messages.push({
            type: 'system',
            text: `🕊️ ${loserName} сдался! 🏆 Победа ${winnerName} со счётом ${player1Score}:${player2Score}`,
            timestamp: Date.now()
        });

        // История игры
        game.gameHistory.push({
            winner: game.state.winner,
            scores: game.state.scores,
            finishedAt: Date.now(),
            reason: 'surrender',
            players: game.players.map(p => ({ name: p.name, playerIndex: p.playerIndex }))
        });

        games.set(gameId, game);

        // Рассылаем обновление
        broadcastGameState(gameId, playerId);

        console.log(`[SURRENDER] ${loserName} сдался в игре ${gameId}. Победа ${winnerName}`);

        res.json({
            success: true,
            message: 'Вы сдались. Игра завершена, противник победил. Можно предложить реванш!'
        });

    } catch (error) {
        console.error('[SURRENDER] Ошибка:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Предложение реванша
router.post('/game/:gameId/rematch', (req, res) => {
    try {
        const { gameId } = req.params;
        const { playerId } = req.body;

        const game = games.get(gameId);
        if (!game) {
            return res.status(404).json({
                success: false,
                error: 'Игра не найдена'
            });
        }

        if (game.state.status !== 'finished') {
            return res.status(400).json({
                success: false,
                error: 'Игра еще не завершена'
            });
        }

        const player = game.players.find(p => p.id === playerId);
        if (!player) {
            return res.status(404).json({
                success: false,
                error: 'Игрок не найден'
            });
        }

        if (game.state.rematchOfferedBy === playerId) {
            return res.status(400).json({
                success: false,
                error: 'Вы уже предложили реванш'
            });
        }

        if (!game.state.rematchOfferedBy) {
            game.state.rematchOfferedBy = playerId;

            game.state.messages.push({
                type: 'system',
                text: `🔄 ${player.name} предлагает реванш!`,
                timestamp: Date.now()
            });

            res.json({
                success: true,
                message: 'Предложение реванша отправлено'
            });

            broadcastGameState(gameId, playerId);

        } else {
            const otherPlayerId = game.state.rematchOfferedBy;
            if (otherPlayerId === playerId) {
                return res.status(400).json({
                    success: false,
                    error: 'Нельзя принять свой же реванш'
                });
            }

            const newGameId = `kalah_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const board = initializeKalahBoard();

            const newGame = {
                id: newGameId,
                players: game.players.map(p => ({
                    ...p,
                    playerIndex: p.playerIndex
                })),
                state: {
                    board: board,
                    currentPlayer: game.state.currentPlayer,
                    status: 'playing',
                    winner: null,
                    scores: { player1: 0, player2: 0 },
                    messages: [{
                        type: 'system',
                        text: `🔄 Реванш! Игроки поменялись сторонами`,
                        timestamp: Date.now()
                    }],
                    gameType: 'kalah',
                    rematchOfferedBy: null,
                    rematchGameId: null,
                    previousGameId: gameId
                },
                createdAt: Date.now(),
                gameHistory: []
            };

            game.state.rematchGameId = newGameId;
            games.set(newGameId, newGame);

            // И сразу рассылаем только по новой игре
            broadcastGameState(newGameId, 'server');
            game.state.messages.push({
                type: 'system',
                text: `🆕 Создана новая игра для реванша!`,
                timestamp: Date.now()
            });

            game.players.forEach(player => {
                const connection = connections.get(player.id);
                if (connection && connection.res) {
                    sendSSE(connection.res, {
                        type: 'rematch_accepted',
                        newGameId: newGameId,
                        message: 'Реванш принят! Новая игра создана.'
                    });
                }
            });

            res.json({
                success: true,
                newGameId: newGameId,
                game: newGame.state,
                message: 'Реванш начался!'
            });

            setTimeout(() => broadcastGameState(newGameId, 'server'), 100);
        }

    } catch (error) {
        console.error('[REMATCH] Ошибка:', error);
        res.status(500).json({
            success: false,
            error: 'Ошибка при предложении реванша'
        });
    }
});

// Автоматическая очистка старых игр
setInterval(() => {
    const now = Date.now();
    const dayAgo = now - 86400000;
    
    for (const [gameId, game] of games) {
        if (game.createdAt < dayAgo) {
            games.delete(gameId);
            console.log(`🗑️ Удалена старая игра Калах: ${gameId}`);
        }
    }
}, 3600000);

export default router;
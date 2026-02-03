const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

// Хранилища
const games = new Map();
const connections = new Map();

// Middleware для SSE
const sseHeaders = (req, res, next) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    next();
};

// Функция отправки SSE
function sendSSE(res, data) {
    try {
        if (res && !res.destroyed && !res.finished && !res.writableEnded) {
            const jsonData = JSON.stringify(data);
            res.write(`data: ${jsonData}\n\n`);
            console.log(`[SSE SEND] → ${data.type || 'unknown'} отправлено`);
            return true;
        } else {
            console.log(`[SSE SEND] НЕЛЬЗЯ ОТПРАВИТЬ — res invalid (destroyed=${res?.destroyed}, finished=${res?.finished}, ended=${res?.writableEnded})`);
            return false;
        }
    } catch (error) {
        console.error('[SEND SSE] Ошибка:', error.message);
        return false;
    }
}

// Рассылка состояния игры
function broadcastGameState(gameId, sourcePlayerId = null, animationData = null) {
    const game = games.get(gameId);
    if (!game) {
        console.log(`[BROADCAST] Игра ${gameId} не найдена`);
        return;
    }

    console.log(`[BROADCAST] Рассылка состояния игры ${gameId} → ${game.players.length} игрокам`);

    const updateData = {
        type: 'game_update',
        game: game.state,
        timestamp: Date.now(),
        sourcePlayerId,
        animation: animationData // Добавляем данные для анимации
    };

    game.players.forEach(player => {
        const connection = connections.get(player.id);
        if (connection && connection.res) {
            console.log(`[BROADCAST] Отправка игроку ${player.id} (${player.name || '?'})`);
            const sent = sendSSE(connection.res, updateData);
            console.log(`[BROADCAST] Отправка игроку ${player.id} → ${sent ? 'успех' : 'ПРОВАЛ'}`);
        } else {
            console.log(`[BROADCAST] Нет активного соединения для игрока ${player.id} (${player.name || '?'})`);
        }
    });
}

// Инициализация доски
function initializeKalahBoard() {
    const board = Array(14).fill(6);
    board[6] = 0;  // Калах игрока 1
    board[13] = 0; // Калах игрока 2
    return board;
}

// Проверка возможности хода
function canPlayerMove(board, playerIndex) {
    const start = playerIndex === 0 ? 0 : 7;
    const end = playerIndex === 0 ? 5 : 12;

    for (let i = start; i <= end; i++) {
        if (board[i] > 0) return true;
    }
    return false;
}

// Логика хода с генерацией данных для анимации
function makeKalahMove(board, pitIndex, playerIndex) {
    console.log(`[KALAH] Ход из лунки ${pitIndex} игроком ${playerIndex}`);

    const newBoard = [...board];
    let stones = newBoard[pitIndex];
    newBoard[pitIndex] = 0;

    let currentIndex = pitIndex;
    const opponentKalah = playerIndex === 0 ? 13 : 6;
    const playerKalah = playerIndex === 0 ? 6 : 13;

    // Данные для анимации
    const animationSteps = [];
    animationSteps.push({
        type: 'pickup',
        from: pitIndex,
        stones: stones
    });

    // Распределяем камни
    const distribution = [];
    while (stones > 0) {
        currentIndex = (currentIndex + 1) % 14;

        // Пропускаем калах противника
        if (currentIndex === opponentKalah) {
            continue;
        }

        distribution.push(currentIndex);
        stones--;
    }

    // Добавляем шаги распределения для анимации
    let delay = 0;
    distribution.forEach((targetIndex, i) => {
        animationSteps.push({
            type: 'move',
            from: pitIndex,
            to: targetIndex,
            stoneIndex: i,
            delay: delay
        });
        delay += 200; // Задержка между перемещениями камней
    });

    // Применяем распределение
    distribution.forEach(index => {
        newBoard[index]++;
    });

    const lastIndex = distribution[distribution.length - 1];

    // Проверяем захват
    let captureAnimation = null;
    if (lastIndex >= (playerIndex === 0 ? 0 : 7) &&
        lastIndex <= (playerIndex === 0 ? 5 : 12) &&
        newBoard[lastIndex] === 1) {

        const oppositeIndex = 12 - lastIndex;
        if (newBoard[oppositeIndex] > 0) {
            console.log(`[KALAH] Захват! Лунка ${lastIndex} -> ${oppositeIndex}`);

            captureAnimation = {
                type: 'capture',
                from: [lastIndex, oppositeIndex],
                to: playerKalah,
                stones: newBoard[lastIndex] + newBoard[oppositeIndex],
                delay: delay + 300
            };

            animationSteps.push(captureAnimation);

            newBoard[playerKalah] += newBoard[lastIndex] + newBoard[oppositeIndex];
            newBoard[lastIndex] = 0;
            newBoard[oppositeIndex] = 0;
        }
    }

    // Дополнительный ход если попал в свой калах
    const extraTurn = lastIndex === playerKalah;
    if (extraTurn && captureAnimation) {
        animationSteps.push({
            type: 'extra_turn',
            player: playerIndex,
            delay: captureAnimation.delay + 500
        });
    } else if (extraTurn) {
        animationSteps.push({
            type: 'extra_turn',
            player: playerIndex,
            delay: delay + 300
        });
    }

    return {
        board: newBoard,
        extraTurn,
        animation: animationSteps
    };
}

// Проверка конца игры
function checkGameEnd(board) {
    const player1HasMoves = canPlayerMove(board, 0);
    const player2HasMoves = canPlayerMove(board, 1);

    if (!player1HasMoves || !player2HasMoves) {
        const newBoard = [...board];
        let player1Score = newBoard[6];
        let player2Score = newBoard[13];

        // Собираем камни игрока 1
        for (let i = 0; i <= 5; i++) {
            player1Score += newBoard[i];
            newBoard[i] = 0;
        }

        // Собираем камни игрока 2
        for (let i = 7; i <= 12; i++) {
            player2Score += newBoard[i];
            newBoard[i] = 0;
        }

        newBoard[6] = player1Score;
        newBoard[13] = player2Score;

        let winner = null;
        if (player1Score > player2Score) {
            winner = 'player1';
        } else if (player2Score > player1Score) {
            winner = 'player2';
        } else {
            winner = 'draw';
        }

        return {
            gameOver: true,
            board: newBoard,
            winner,
            scores: { player1: player1Score, player2: player2Score }
        };
    }

    return { gameOver: false };
}

// ========== API endpoints ==========

// Создание игры
app.post('/game/create', (req, res) => {
    try {
        const gameId = `kalah_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const board = initializeKalahBoard();

        const game = {
            id: gameId,
            players: [],
            state: {
                board: board,
                currentPlayer: 0,
                status: 'waiting',
                winner: null,
                scores: { player1: 0, player2: 0 },
                messages: [],
                gameType: 'kalah',
                rematchOfferedBy: null,
                rematchGameId: null
            },
            createdAt: Date.now(),
            gameHistory: []
        };

        games.set(gameId, game);
        console.log(`[CREATE] Создана игра Калах ${gameId}`);

        res.json({
            success: true,
            gameId,
            game: game.state,
            message: 'Игра Калах создана'
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
app.post('/game/:gameId/join', (req, res) => {
    try {
        const { gameId } = req.params;
        const { playerName } = req.body;

        const game = games.get(gameId);
        if (!game) {
            return res.status(404).json({
                success: false,
                error: 'Игра не найдена'
            });
        }

        if (game.players.length >= 2) {
            return res.status(400).json({
                success: false,
                error: 'Игра уже началась'
            });
        }

        const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const player = {
            id: playerId,
            name: playerName || `Игрок ${game.players.length + 1}`,
            playerIndex: game.players.length,
            connected: true,
            joinedAt: Date.now()
        };

        game.players.push(player);
        console.log(`[JOIN] Игрок ${player.name} (${player.playerIndex}) присоединился`);

        if (game.players.length === 2) {
            game.state.status = 'playing';
            game.state.currentPlayer = 0;

            const startMsg = {
                type: 'system',
                text: `🎮 Игра началась! Первый ход у ${game.players[0].name}`,
                timestamp: Date.now()
            };
            game.state.messages.push(startMsg);

            console.log(`[GAME START] Сообщение добавлено, игроков: ${game.players.length}`);

            // Даём 50–150 мс, чтобы второй игрок успел открыть SSE
            setTimeout(() => {
                console.log(`[DELAYED BROADCAST] Запуск рассылки для игры ${gameId}`);
                broadcastGameState(gameId, 'server');

                // Дополнительно — принудительно отправляем свежий state каждому, у кого есть соединение
                game.players.forEach(p => {
                    const conn = connections.get(p.id);
                    if (conn?.res && !conn.res.destroyed && !conn.res.finished) {
                        console.log(`[FORCE SEND] Игроку ${p.id} (${p.name})`);
                        sendSSE(conn.res, {
                            type: 'game_update',
                            game: game.state,
                            timestamp: Date.now(),
                            sourcePlayerId: 'server'
                        });
                    }
                });
            }, 120);   // 120 мс — обычно достаточно
        }

        res.json({
            success: true,
            playerId,
            playerIndex: player.playerIndex,
            game: game.state,
            message: `Вы присоединились как ${player.name}`
        });

        // можно убрать этот блок полностью или оставить как fallback
        // if (game.players.length === 2) {
        //     setTimeout(() => broadcastGameState(gameId, 'server'), 100);
        // }

    } catch (error) {
        console.error('[JOIN] Ошибка:', error);
        res.status(500).json({
            success: false,
            error: 'Ошибка подключения'
        });
    }
});

// SSE endpoint
app.get('/sse/:playerId/:gameId', sseHeaders, (req, res) => {
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

// Ход в Калахе
app.post('/game/:gameId/move', (req, res) => {
    try {
        const { gameId } = req.params;
        const { playerId, pitIndex } = req.body;

        console.log(`[MOVE] Запрос от ${playerId} в лунку ${pitIndex}`);

        const game = games.get(gameId);
        if (!game) {
            return res.status(404).json({
                success: false,
                error: 'Игра не найдена'
            });
        }

        const player = game.players.find(p => p.id === playerId);
        if (!player) {
            return res.status(404).json({
                success: false,
                error: 'Игрок не найден'
            });
        }

        if (game.state.currentPlayer !== player.playerIndex) {
            return res.status(400).json({
                success: false,
                error: 'Не ваш ход',
                currentPlayer: game.state.currentPlayer
            });
        }

        const playerStart = player.playerIndex === 0 ? 0 : 7;
        const playerEnd = player.playerIndex === 0 ? 5 : 12;

        if (pitIndex < playerStart || pitIndex > playerEnd) {
            return res.status(400).json({
                success: false,
                error: 'Неверная лунка'
            });
        }

        if (game.state.board[pitIndex] === 0) {
            return res.status(400).json({
                success: false,
                error: 'Лунка пуста'
            });
        }

        // Выполняем ход с анимацией
        const moveResult = makeKalahMove(game.state.board, pitIndex, player.playerIndex);
        game.state.board = moveResult.board;

        // Добавляем сообщение о ходе
        game.state.messages.push({
            type: 'move',
            text: `${player.name} сделал ход из лунки ${pitIndex}`,
            timestamp: Date.now(),
            player: player.name,
            playerIndex: player.playerIndex,
            pitIndex: pitIndex
        });

        // Проверяем конец игры
        const gameEndCheck = checkGameEnd(game.state.board);
        if (gameEndCheck.gameOver) {
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
            game.state.currentPlayer = game.state.currentPlayer === 0 ? 1 : 0;

            const nextPlayer = game.players.find(p => p.playerIndex === game.state.currentPlayer);
            game.state.messages.push({
                type: 'system',
                text: `➡️ Теперь ходит ${nextPlayer.name}`,
                timestamp: Date.now()
            });
        } else {
            game.state.messages.push({
                type: 'system',
                text: `🎯 ${player.name} получает дополнительный ход!`,
                timestamp: Date.now()
            });
        }

        games.set(gameId, game);

        // Отправляем ответ с данными для анимации
        res.json({
            success: true,
            game: game.state,
            animation: moveResult.animation,
            message: 'Ход принят'
        });

        // Рассылаем обновление с анимацией
        setTimeout(() => broadcastGameState(gameId, playerId, moveResult.animation), 50);

    } catch (error) {
        console.error('[MOVE] Ошибка:', error);
        res.status(500).json({
            success: false,
            error: 'Ошибка при ходе'
        });
    }
});

// Предложение реванша
app.post('/game/:gameId/rematch', (req, res) => {
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
                    playerIndex: p.playerIndex === 0 ? 1 : 0
                })),
                state: {
                    board: board,
                    currentPlayer: 0,
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

            //games.set(newGameId, game.state.rematchGameId = newGameId);
            game.state.rematchGameId = newGameId;          // только ссылка в старой игре
            games.set(newGameId, newGame);                 // новая игра в Map

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

// Статистика
app.get('/stats', (req, res) => {
    const stats = {
        games: games.size,
        connections: connections.size,
        players: Array.from(games.values()).reduce((sum, game) => sum + game.players.length, 0),
        activeGames: Array.from(games.values()).filter(g => g.state.status === 'playing').length,
        finishedGames: Array.from(games.values()).filter(g => g.state.status === 'finished').length,
        timestamp: Date.now(),
        server: 'Kalah SSE Server v2.0 (Animated)'
    };

    res.json(stats);
});

// Главная страница с игрой (обновленный HTML с анимациями)
app.get('/', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🎮 Калах (Манкала) - Анимированная игра</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        :root {
            --primary-color: #4361ee;
            --secondary-color: #3a0ca3;
            --accent-color: #f72585;
            --success-color: #4cc9f0;
            --warning-color: #f8961e;
            --danger-color: #f94144;
            --light-color: #f8f9fa;
            --dark-color: #212529;
            --gray-color: #6c757d;
            --board-color: #8d6e63;
            --pit-color: #d7ccc8;
            --store-color: #795548;
            --player1-color: #4361ee;
            --player2-color: #f72585;
            --stone-color1: #ff6b6b;
            --stone-color2: #4ecdc4;
            --shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
            --radius: 16px;
            --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            color: var(--dark-color);
            line-height: 1.6;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            display: grid;
            grid-template-columns: 300px 1fr 350px;
            gap: 24px;
            height: calc(100vh - 40px);
        }
        
        @media (max-width: 1200px) {
            .container {
                grid-template-columns: 1fr;
                height: auto;
            }
        }
        
        /* Панели */
        .panel {
            background: white;
            border-radius: var(--radius);
            box-shadow: var(--shadow);
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }
        
        .panel-header {
            background: linear-gradient(to right, var(--primary-color), var(--secondary-color));
            color: white;
            padding: 20px;
            display: flex;
            align-items: center;
            gap: 12px;
        }
        
        .panel-header i {
            font-size: 1.5rem;
        }
        
        .panel-header h2 {
            font-size: 1.4rem;
            font-weight: 600;
        }
        
        .panel-content {
            padding: 24px;
            flex: 1;
            overflow-y: auto;
        }
        
        /* Формы */
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-label {
            display: block;
            margin-bottom: 8px;
            color: var(--gray-color);
            font-weight: 600;
            font-size: 0.9rem;
        }
        
        .form-input {
            width: 100%;
            padding: 14px 16px;
            border: 2px solid #e9ecef;
            border-radius: 12px;
            font-size: 1rem;
            transition: var(--transition);
            background: #f8f9fa;
        }
        
        .form-input:focus {
            outline: none;
            border-color: var(--primary-color);
            background: white;
            box-shadow: 0 0 0 3px rgba(67, 97, 238, 0.1);
        }
        
        /* Кнопки */
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            padding: 14px 24px;
            border: none;
            border-radius: 12px;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: var(--transition);
            text-align: center;
            width: 100%;
            margin-bottom: 12px;
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
        }
        
        .btn:active {
            transform: translateY(0);
        }
        
        .btn-primary {
            background: linear-gradient(to right, var(--primary-color), var(--secondary-color));
            color: white;
        }
        
        .btn-secondary {
            background: linear-gradient(to right, var(--accent-color), #ff4d6d);
            color: white;
        }
        
        .btn-success {
            background: linear-gradient(to right, #4cc9f0, #4895ef);
            color: white;
        }
        
        .btn-warning {
            background: linear-gradient(to right, var(--warning-color), #f3722c);
            color: white;
        }
        
        .btn-outline {
            background: transparent;
            border: 2px solid var(--primary-color);
            color: var(--primary-color);
        }
        
        /* Информация об игроке */
        .player-card {
            background: #f8f9fa;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            border-left: 4px solid var(--primary-color);
        }
        
        .player-card h3 {
            color: var(--dark-color);
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .player-info-item {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            padding-bottom: 10px;
            border-bottom: 1px solid #e9ecef;
        }
        
        .player-info-item:last-child {
            border-bottom: none;
            margin-bottom: 0;
        }
        
        .info-label {
            color: var(--gray-color);
            font-weight: 500;
        }
        
        .info-value {
            color: var(--dark-color);
            font-weight: 600;
        }
        
        /* Панель реванша */
        .rematch-card {
            background: linear-gradient(135deg, #fff9c4, #ffecb3);
            border-radius: 12px;
            padding: 24px;
            margin-top: 20px;
            border: 2px dashed #ffb300;
            text-align: center;
        }
        
        .rematch-card h3 {
            color: #f57c00;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        }
        
        .rematch-message {
            color: #5d4037;
            margin-bottom: 20px;
            font-size: 1rem;
        }
        
        /* Доска Калах */
        .game-board-container {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
        
        .game-status {
            background: white;
            border-radius: var(--radius);
            padding: 20px;
            margin-bottom: 24px;
            text-align: center;
            font-size: 1.2rem;
            font-weight: 600;
            box-shadow: var(--shadow);
            transition: var(--transition);
        }
        
        .status-waiting {
            background: linear-gradient(to right, #fff3cd, #ffeaa7);
            color: #856404;
        }
        
        .status-playing {
            background: linear-gradient(to right, #d4edda, #c3e6cb);
            color: #155724;
        }
        
        .status-finished {
            background: linear-gradient(to right, #f8d7da, #f5c6cb);
            color: #721c24;
        }
        
        /* Сама доска */
        .kalah-board {
            flex: 1;
            background: var(--board-color);
            border-radius: var(--radius);
            padding: 30px;
            display: flex;
            flex-direction: column;
            box-shadow: inset 0 4px 20px rgba(0, 0, 0, 0.2);
            position: relative;
            overflow: hidden;
        }
        
        .board-row {
            display: flex;
            flex: 1;
            gap: 15px;
        }
        
        /* Калахи (хранилища) */
        .kalah-store {
            flex: 0 0 120px;
            background: linear-gradient(145deg, var(--store-color), #5d4037);
            border-radius: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            box-shadow: inset 0 4px 20px rgba(0, 0, 0, 0.3);
            overflow: hidden;
        }
        
        .store-label {
            position: absolute;
            top: 10px;
            color: rgba(255, 255, 255, 0.8);
            font-weight: 600;
            font-size: 0.9rem;
        }
        
        .store-count {
            font-size: 3rem;
            font-weight: 700;
            color: white;
            text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
        }
        
        /* Лунки */
        .pits-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        
        .pits-row {
            display: flex;
            flex: 1;
            gap: 15px;
        }
        #pitsPlayer2 {
            flex-direction: row-reverse;
        }
        
        
        .kalah-pit {
            flex: 1;
            background: linear-gradient(145deg, var(--pit-color), #bcaaa4);
            border-radius: 50%;
            position: relative;
            cursor: pointer;
            transition: var(--transition);
            box-shadow: inset 0 4px 15px rgba(0, 0, 0, 0.2);
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            min-height: 80px;
        }
        
        .kalah-pit:hover {
            transform: scale(1.05);
            box-shadow: inset 0 4px 15px rgba(0, 0, 0, 0.2), 0 0 0 3px rgba(67, 97, 238, 0.3);
        }
        
        .kalah-pit.active {
            box-shadow: inset 0 4px 15px rgba(0, 0, 0, 0.2), 0 0 0 3px var(--primary-color);
        }
        
        .kalah-pit.disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .kalah-pit.disabled:hover {
            transform: none;
            box-shadow: inset 0 4px 15px rgba(0, 0, 0, 0.2);
        }
        
        .pit-label {
            position: absolute;
            top: 10px;
            color: rgba(0, 0, 0, 0.6);
            font-weight: 600;
            font-size: 0.9rem;
        }
        
        .pit-count {
            font-size: 2rem;
            font-weight: 700;
            color: var(--dark-color);
            z-index: 2;
        }
        
        /* Камни в лунках */
        .stones-container {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: center;
            gap: 3px;
            padding: 10px;
        }
        
        .stone {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            position: absolute;
            transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
        }
        
        .stone.player1 {
            background: radial-gradient(circle at 30% 30%, var(--stone-color1), #ff4757);
        }
        
        .stone.player2 {
            background: radial-gradient(circle at 30% 30%, var(--stone-color2), #00d2d3);
        }
        
        /* Анимации */
        @keyframes stoneMove {
            0% {
                transform: translate(0, 0) scale(1);
            }
            50% {
                transform: translate(var(--move-x), var(--move-y)) scale(1.2);
            }
            100% {
                transform: translate(0, 0) scale(1);
            }
        }
        
        @keyframes pulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.1); }
            100% { transform: scale(1); }
        }
        
        @keyframes highlight {
            0% { box-shadow: 0 0 0 0 rgba(67, 97, 238, 0.7); }
            70% { box-shadow: 0 0 0 10px rgba(67, 97, 238, 0); }
            100% { box-shadow: 0 0 0 0 rgba(67, 97, 238, 0); }
        }
        
        .animate-pulse {
            animation: pulse 0.5s ease-in-out;
        }
        
        .animate-highlight {
            animation: highlight 1s ease-out;
        }
        
        /* Чат */
        .chat-container {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
        
        .messages-container {
            flex: 1;
            background: #f8f9fa;
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        
        .message {
            padding: 12px 16px;
            border-radius: 12px;
            max-width: 85%;
            word-wrap: break-word;
        }
        
        .message-system {
            background: #e3f2fd;
            border-left: 4px solid #2196f3;
            align-self: center;
            text-align: center;
            font-style: italic;
        }
        
        .message-move {
            background: #e8f5e9;
            border-left: 4px solid #4caf50;
        }
        
        .message-player1 {
            background: #e3f2fd;
            border-left: 4px solid var(--player1-color);
            align-self: flex-start;
        }
        
        .message-player2 {
            background: #fce4ec;
            border-left: 4px solid var(--player2-color);
            align-self: flex-end;
        }
        
        .message-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 5px;
            font-size: 0.85rem;
        }
        
        .message-sender {
            font-weight: 600;
            color: var(--dark-color);
        }
        
        .message-time {
            color: var(--gray-color);
        }
        
        .message-text {
            color: var(--dark-color);
            line-height: 1.5;
        }
        
        .chat-input-container {
            display: flex;
            gap: 12px;
        }
        
        .chat-input {
            flex: 1;
            padding: 14px 16px;
            border: 2px solid #e9ecef;
            border-radius: 12px;
            font-size: 1rem;
            transition: var(--transition);
        }
        
        .chat-input:focus {
            outline: none;
            border-color: var(--primary-color);
        }
        
        /* Логи */
        .logs-container {
            margin-top: 24px;
            background: var(--dark-color);
            border-radius: var(--radius);
            padding: 20px;
            flex: 1;
            display: flex;
            flex-direction: column;
        }
        
        .logs-header {
            color: white;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .logs-content {
            flex: 1;
            overflow-y: auto;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 15px;
        }
        
        .log-entry {
            padding: 8px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            font-family: 'Monaco', 'Courier New', monospace;
            font-size: 0.85rem;
        }
        
        .log-time {
            color: #95a5a6;
            margin-right: 10px;
        }
        
        .log-info { color: #3498db; }
        .log-success { color: #2ecc71; }
        .log-warning { color: #f1c40f; }
        .log-error { color: #e74c3c; }
        
        /* Правила игры */
        .rules-container {
            background: #e8f4fc;
            border-radius: 12px;
            padding: 20px;
            margin-top: 20px;
        }
        
        .rules-title {
            color: #2980b9;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .rules-list {
            padding-left: 20px;
        }
        
        .rules-list li {
            margin-bottom: 8px;
            color: #2c3e50;
        }
        
        /* Индикатор текущего игрока */
        .current-player-indicator {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            padding: 12px;
            border-radius: 12px;
            margin-bottom: 20px;
            font-weight: 600;
        }
        
        .current-player-indicator.player1 {
            background: rgba(67, 97, 238, 0.1);
            color: var(--player1-color);
            border: 2px solid var(--player1-color);
        }
        
        .current-player-indicator.player2 {
            background: rgba(247, 37, 133, 0.1);
            color: var(--player2-color);
            border: 2px solid var(--player2-color);
        }
        
        .player-indicator-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
        }
        
        .player-indicator-dot.player1 {
            background: var(--player1-color);
        }
        
        .player-indicator-dot.player2 {
            background: var(--player2-color);
        }
        
        /* Мобильная адаптация */
        @media (max-width: 768px) {
            .container {
                padding: 10px;
            }
            
            .kalah-board {
                padding: 15px;
            }
            
            .kalah-store {
                flex: 0 0 80px;
            }
            
            .store-count {
                font-size: 2rem;
            }
            
            .pit-count {
                font-size: 1.5rem;
            }
        }
        
        /* Утилиты */
        .hidden {
            display: none !important;
        }
        
        .text-center {
            text-align: center;
        }
        
        .mb-3 {
            margin-bottom: 1rem;
        }
        
        .mt-3 {
            margin-top: 1rem;
        }
        
        .flex {
            display: flex;
        }
        
        .items-center {
            align-items: center;
        }
        
        .justify-between {
            justify-content: space-between;
        }
        
        .gap-2 {
            gap: 0.5rem;
        }
        
        .gap-4 {
            gap: 1rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Левая панель: управление -->
        <div class="panel">
            <div class="panel-header">
                <i class="fas fa-gamepad"></i>
                <h2>Управление игрой</h2>
            </div>
            <div class="panel-content">
                <div class="form-group">
                    <label class="form-label">Ваше имя:</label>
                    <input type="text" id="playerName" class="form-input" placeholder="Введите ваше имя" value="Игрок">
                </div>
                
                <div class="form-group">
                    <label class="form-label">ID игры:</label>
                    <input type="text" id="gameId" class="form-input" placeholder="Оставьте пустым для новой игры">
                </div>
                
                <button class="btn btn-primary" onclick="createGame()">
                    <i class="fas fa-plus-circle"></i> Создать новую игру
                </button>
                
                <button class="btn btn-secondary" onclick="joinGame()">
                    <i class="fas fa-sign-in-alt"></i> Присоединиться к игре
                </button>
                
                <div id="playerInfo" class="hidden">
                    <div class="player-card">
                        <h3><i class="fas fa-user"></i> Ваш профиль</h3>
                        <div class="player-info-item">
                            <span class="info-label">Имя:</span>
                            <span class="info-value" id="infoName">-</span>
                        </div>
                        <div class="player-info-item">
                            <span class="info-label">Сторона:</span>
                            <span class="info-value" id="infoSide">-</span>
                        </div>
                        <div class="player-info-item">
                            <span class="info-label">ID игры:</span>
                            <span class="info-value" id="infoGameId">-</span>
                        </div>
                        <div class="player-info-item">
                            <span class="info-label">Ваш ID:</span>
                            <span class="info-value" id="infoPlayerId">-</span>
                        </div>
                    </div>
                </div>
                
                <div id="rematchPanel" class="rematch-card hidden">
                    <h3><i class="fas fa-redo"></i> Реванш</h3>
                    <p class="rematch-message" id="rematchMessage"></p>
                    <button class="btn btn-warning" onclick="offerRematch()" id="btnOfferRematch">
                        <i class="fas fa-fist-raised"></i> Предложить реванш
                    </button>
                    <button class="btn btn-success hidden" onclick="acceptRematch()" id="btnAcceptRematch">
                        <i class="fas fa-check-circle"></i> Принять реванш
                    </button>
                </div>
                
                <div class="rules-container">
                    <h3 class="rules-title"><i class="fas fa-book"></i> Правила Калах:</h3>
                    <ul class="rules-list">
                        <li>Берите камни из своей лунки</li>
                        <li>Раскладывайте против часовой стрелки</li>
                        <li>Попали в свой калах → дополнительный ход</li>
                        <li>Попали в свою пустую лунку → захват камней</li>
                        <li>Игра заканчивается, когда у игрока нет ходов</li>
                        <li>Побеждает набравший больше камней</li>
                    </ul>
                </div>
            </div>
        </div>
        
        <!-- Центральная панель: игровое поле -->
        <div class="panel">
            <div class="panel-header">
                <i class="fas fa-chess-board"></i>
                <h2>Игровое поле Калах</h2>
            </div>
            <div class="panel-content game-board-container">
                <div class="game-status" id="gameStatus">
                    Создайте игру или присоединитесь к существующей
                </div>
                
                <div id="currentPlayerIndicator" class="current-player-indicator hidden">
                    <div class="player-indicator-dot" id="playerIndicatorDot"></div>
                    <span id="currentPlayerText">Сейчас ходит: </span>
                </div>
                
                <div class="kalah-board" id="kalahBoard">
                    <!-- Верхний ряд: игрок 2 -->
                    <div class="board-row">
                        <div class="kalah-store" id="storePlayer2">
                            <div class="store-label">Игрок 2</div>
                            <div class="store-count">0</div>
                        </div>
                        
                        <div class="pits-container">
                            <div class="pits-row" id="pitsPlayer2">
                                <!-- Лунки игрока 2 (7-12) -->
                            </div>
                        </div>
                        
                        <div class="kalah-store" id="storePlayer1">
                            <div class="store-label">Игрок 1</div>
                            <div class="store-count">0</div>
                        </div>
                    </div>
                    
                    <!-- Нижний ряд: игрок 1 -->
                    <div class="board-row">
                        <div style="flex: 0 0 120px;"></div> <!-- Пустое место для симметрии -->
                        
                        <div class="pits-container">
                            <div class="pits-row" id="pitsPlayer1">
                                <!-- Лунки игрока 1 (0-5) -->
                            </div>
                        </div>
                        
                        <div style="flex: 0 0 120px;"></div> <!-- Пустое место для симметрии -->
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Правая панель: чат и логи -->
        <div class="panel">
            <div class="panel-header">
                <i class="fas fa-comments"></i>
                <h2>Чат и логи</h2>
            </div>
            <div class="panel-content chat-container">
                <div class="messages-container" id="chatMessages">
                    <!-- Сообщения будут здесь -->
                </div>
                
                <div class="chat-input-container">
                    <input type="text" id="chatInput" class="chat-input" placeholder="Введите сообщение..." 
                           onkeypress="if(event.key === 'Enter') sendMessage()">
                    <button class="btn btn-primary" onclick="sendMessage()">
                        <i class="fas fa-paper-plane"></i>
                    </button>
                </div>
                
                <div class="logs-container">
                    <div class="logs-header">
                        <i class="fas fa-terminal"></i>
                        <h3>Лог событий</h3>
                    </div>
                    <div class="logs-content" id="logContainer">
                        <!-- Логи будут здесь -->
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const SERVER_URL = 'http://localhost:3000';
        
        // Состояние клиента
        const clientState = {
            gameId: null,
            playerId: null,
            playerName: null,
            playerIndex: null,
            eventSource: null,
            gameState: null,
            isConnected: false,
            stones: {}, // Хранилище DOM-элементов камней
            animationQueue: [],
            isAnimating: false
        };
        
        // Логирование
        function log(message, type = 'info') {
            const logContainer = document.getElementById('logContainer');
            const time = new Date().toLocaleTimeString('ru-RU', { 
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry';
            logEntry.innerHTML = \`
                <span class="log-time">[\${time}]</span>
                <span class="log-\${type}">\${message}</span>
            \`;
            
            logContainer.appendChild(logEntry);
            logContainer.scrollTop = logContainer.scrollHeight;
            
            console.log(\`[\${type.toUpperCase()}] \${message}\`);
        }
        
        // Форматирование времени
        function formatTime(timestamp) {
            return new Date(timestamp).toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit'
            });
        }
        
        // Создание игры
        async function createGame() {
            const playerName = document.getElementById('playerName').value.trim() || 'Игрок';
            clientState.playerName = playerName;
            
            try {
                log('Создание новой игры Калах...', 'info');
                
                const response = await fetch(\`\${SERVER_URL}/game/create\`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    }
                });
                
                const data = await response.json();
                
                if (data.success) {
                    clientState.gameId = data.gameId;
                    log(\`✅ Игра Калах создана! ID: \${data.gameId}\`, 'success');
                    
                    setTimeout(() => joinGame(playerName), 500);
                } else {
                    log(\`❌ Ошибка: \${data.error || data.message}\`, 'error');
                }
                
            } catch (error) {
                log(\`❌ Ошибка сети: \${error.message}\`, 'error');
            }
        }
        
        // Подключение к игре
        async function joinGame(playerName = null) {
            const gameIdInput = document.getElementById('gameId').value.trim();
            
            if (gameIdInput) {
                clientState.gameId = gameIdInput;
            }
            
            if (!clientState.gameId) {
                log('❌ Введите ID игры или создайте новую', 'error');
                return;
            }
            
            if (!playerName) {
                playerName = document.getElementById('playerName').value.trim() || 'Игрок';
            }
            clientState.playerName = playerName;
            
            try {
                log(\`Присоединение к игре \${clientState.gameId}...\`, 'info');
                
                const response = await fetch(\`\${SERVER_URL}/game/\${clientState.gameId}/join\`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify({ playerName })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    clientState.playerId = data.playerId;
                    clientState.playerIndex = data.playerIndex;
                    clientState.gameState = data.game;
                    
                    log(\`✅ Успешно! Вы - \${data.playerIndex === 0 ? 'Игрок 1 (низ)' : 'Игрок 2 (верх)'}\`, 'success');
                    
                    showGameInfo();
                    connectSSE();
                    initializeBoard();
                    updateGameDisplay();
                    
                } else {
                    log(\`❌ Ошибка: \${data.error || data.message}\`, 'error');
                }
                
            } catch (error) {
                log(\`❌ Ошибка сети: \${error.message}\`, 'error');
            }
        }
        
        // Подключение SSE
        function connectSSE() {
            if (clientState.eventSource) {
                clientState.eventSource.close();
            }
            
            const url = \`\${SERVER_URL}/sse/\${clientState.playerId}/\${clientState.gameId}\`;
            log(\`Подключение SSE: \${url}\`, 'info');
            
            clientState.eventSource = new EventSource(url);
            
            clientState.eventSource.onopen = () => {
                clientState.isConnected = true;
                log('✅ SSE соединение установлено', 'success');
            };
            
            clientState.eventSource.onmessage = (event) => {
    try {
        let dataStr = event.data;
        
        if (dataStr.startsWith('data: ')) {
            dataStr = dataStr.substring(6);
        }
        
        if (dataStr.trim() !== '') {
            const data = JSON.parse(dataStr);
            
            if (data.type === 'rematch_accepted') {
                handleRematchAccepted(data);
            } else if (data.type === 'game_update') {
                handleAnimatedUpdate(data);
            } else {
                handleServerEvent(data);
            }
        }
    } catch (error) {                                      // ← error здесь
        log(\`❌ Ошибка парсинга SSE: \${error.message}\`, 'error');
    }
};
            
            clientState.eventSource.onerror = (error) => {
                log('❌ Ошибка SSE соединения', 'error');
                clientState.isConnected = false;
                
                setTimeout(() => {
                    if (!clientState.isConnected) {
                        log('Попытка переподключения...', 'info');
                        connectSSE();
                    }
                }, 5000);
            };
        }
        
        // Обработка обновления с анимацией
        function handleAnimatedUpdate(data) {
            // Сначала обновляем состояние игры
            clientState.gameState = data.game;
            
            // Если есть анимация, добавляем её в очередь
            if (data.animation && data.animation.length > 0) {
                clientState.animationQueue = data.animation;
                startAnimation();
            } else {
                updateGameDisplay();
            }
        }
        
        // Запуск анимации
function startAnimation() {
if (clientState.isAnimating || clientState.animationQueue.length === 0) {
        // ← Вот здесь обновляем UI, когда анимация полностью завершена
        clientState.isAnimating = false;
        updateGameDisplay();   // статус, индикатор хода, активные/неактивные лунки
        updateChat();          // новые сообщения в чате
        return;
    }

    clientState.isAnimating = true;
    const animationStep = clientState.animationQueue.shift();

    switch (animationStep.type) {
        case 'pickup':
            animatePickup(animationStep);
            break;
        case 'move':
            animateStoneMove(animationStep);
            break;
        case 'capture':
            animateCapture(animationStep);
            break;
        case 'extra_turn':
            animateExtraTurn(animationStep);
            break;
        default:
            console.warn("Неизвестный тип анимации:", animationStep.type);
    }

    // Важно: здесь мы НЕ вызываем startAnimation() напрямую
    // Это будет сделано из функций анимации после их завершения
}
        
        // Анимация взятия камней
        function animatePickup(step) {
            const pit = document.getElementById(\`pit_\${step.from}\`);
            if (pit) {
                pit.classList.add('animate-pulse');
                
                // Создаем камни для анимации
                createAnimationStones(step.from, step.stones);
                
                setTimeout(() => {
                    pit.classList.remove('animate-pulse');
                    updateBoardDisplay();
                    setTimeout(() => startAnimation(), 300);
                }, 500);
            } else {
                setTimeout(() => startAnimation(), 300);
            }
            setTimeout(() => {
        pit.classList.remove('animate-pulse');
        updateBoardDisplay();
        
        // ← Вот это добавляем
        clientState.isAnimating = false;
        startAnimation();           // запускаем следующий шаг или завершаем
    }, 500);
        }
        
        // Анимация перемещения камня
        function animateStoneMove(step) {
            const stoneId = \`stone_\${step.from}_\${step.stoneIndex}\`;
            const stone = document.getElementById(stoneId);
            
            if (stone) {
                const fromPit = document.getElementById(\`pit_\${step.from}\`);
                const toPit = document.getElementById(\`pit_\${step.to}\`);
                
                if (fromPit && toPit) {
                    const fromRect = fromPit.getBoundingClientRect();
                    const toRect = toPit.getBoundingClientRect();
                    
                    // Вычисляем смещение
                    const dx = toRect.left - fromRect.left;
                    const dy = toRect.top - fromRect.top;
                    
                    // Анимируем перемещение
                    stone.style.setProperty('--move-x', \`\${dx}px\`);
                    stone.style.setProperty('--move-y', \`\${dy}px\`);
                    stone.style.animation = \`stoneMove 0.5s cubic-bezier(0.4, 0, 0.2, 1) \${step.delay || 0}ms forwards\`;
                    
                    // После завершения анимации
                    setTimeout(() => {
                        if (stone.parentNode) {
                            stone.parentNode.removeChild(stone);
                        }
                        updateBoardDisplay();
                        setTimeout(() => startAnimation(), 100);
                    }, 500 + (step.delay || 0));
                }
            } else {
                setTimeout(() => startAnimation(), 100);
            }
            setTimeout(() => {
        if (stone.parentNode) {
            stone.parentNode.removeChild(stone);
        }
        updateBoardDisplay();

        // ← Вот это добавляем
        clientState.isAnimating = false;
        startAnimation();           // следующий шаг или завершение
    }, 500 + (step.delay || 0));
        }
        
        // Анимация захвата камней
        function animateCapture(step) {
            // Подсвечиваем захваченные лунки
            step.from.forEach(pitIndex => {
                const pit = document.getElementById(\`pit_\${pitIndex}\`);
                if (pit) pit.classList.add('animate-highlight');
            });
            
            // Анимация перемещения в калах
            setTimeout(() => {
                step.from.forEach(pitIndex => {
                    const pit = document.getElementById(\`pit_\${pitIndex}\`);
                    if (pit) pit.classList.remove('animate-highlight');
                });
                
                updateBoardDisplay();
                setTimeout(() => startAnimation(), 300);
            }, 1000);
            
            setTimeout(() => {
        step.from.forEach(pitIndex => {
            const pit = document.getElementById(\`pit_\${pitIndex}\`);
            if (pit) pit.classList.remove('animate-highlight');
        });

        updateBoardDisplay();

        // ← Вот это добавляем
        clientState.isAnimating = false;
        startAnimation();
    }, 1000);
        }
        
        // Анимация дополнительного хода
        function animateExtraTurn(step) {
            const playerIndicator = document.getElementById('currentPlayerIndicator');
            if (playerIndicator) {
                playerIndicator.classList.add('animate-pulse');
                setTimeout(() => {
                    playerIndicator.classList.remove('animate-pulse');
                    updateGameDisplay();
                    setTimeout(() => startAnimation(), 300);
                }, 1000);
            } else {
                setTimeout(() => startAnimation(), 300);
            }
            setTimeout(() => {
        playerIndicator.classList.remove('animate-pulse');
        updateGameDisplay();

        // ← Вот это добавляем
        clientState.isAnimating = false;
        startAnimation();
    }, 1000);
        }
        
        // Создание камней для анимации
        function createAnimationStones(fromPitIndex, stoneCount) {
            const fromPit = document.getElementById(\`pit_\${fromPitIndex}\`);
            if (!fromPit) return;
            
            const pitRect = fromPit.getBoundingClientRect();
            
            for (let i = 0; i < Math.min(stoneCount, 10); i++) {
                const stone = document.createElement('div');
                stone.id = \`stone_\${fromPitIndex}_\${i}\`;
                stone.className = \`stone \${fromPitIndex < 7 ? 'player1' : 'player2'}\`;
                
                // Случайная позиция внутри лунки
                const angle = Math.random() * Math.PI * 2;
                const radius = Math.random() * 30;
                const x = Math.cos(angle) * radius;
                const y = Math.sin(angle) * radius;
                
                stone.style.left = \`calc(50% + \${x}px)\`;
                stone.style.top = \`calc(50% + \${y}px)\`;
                stone.style.transform = \`translate(-50%, -50%)\`;
                
                document.body.appendChild(stone);
                clientState.stones[\`stone_\${fromPitIndex}_\${i}\`] = stone;
            }
        }
        
        // Обработка реванша
        function handleRematchAccepted(data) {
            log(\`🔄 Реванш принят! Новая игра: \${data.newGameId}\`, 'success');
            
            clientState.gameId = data.newGameId;
            document.getElementById('gameId').value = data.newGameId;
            
            setTimeout(() => {
                connectSSE();
                log('Переподключение к новой игре...', 'info');
            }, 1000);
        }
        
        // Обработка обычных событий
        function handleServerEvent(data) {
            switch(data.type) {
                case 'connected':
                    log(\`Сервер: \${data.message}\`, 'info');
                    break;
                case 'game_state':
                    clientState.gameState = data.game;
                    updateGameDisplay();
                    break;
                case 'ping':
                    break;
            }
        }
        
        // Ход в Калахе
        async function makeMove(pitIndex) {
            if (!clientState.gameId || !clientState.playerId) {
                log('Сначала присоединитесь к игре', 'error');
                return;
            }
            
            if (clientState.gameState.status !== 'playing') {
                log('Игра еще не началась или уже завершена', 'warning');
                return;
            }
            
            if (clientState.gameState.currentPlayer !== clientState.playerIndex) {
                log(\`Сейчас не ваш ход\`, 'warning');
                return;
            }
            
            try {
                log(\`Ход из лунки \${pitIndex}...\`, 'info');
                const response = await fetch(\`\${SERVER_URL}/game/\${clientState.gameId}/move\`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify({
                        playerId: clientState.playerId,
                        pitIndex: pitIndex
                    })
                });
                
                const data = await response.json();
                
                if (!data.success) {
                    log(\`❌ Ошибка: \${data.error}\`, 'error');
                }
                
            } catch (error) {
                log(\`❌ Ошибка отправки хода: \${error.message}\`, 'error');
            }
        }
        
        // Предложение реванша
        async function offerRematch() {
            if (!clientState.gameId || !clientState.playerId) return;
            
            try {
                log('Предложение реванша...', 'info');
                const response = await fetch(\`\${SERVER_URL}/game/\${clientState.gameId}/rematch\`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify({
                        playerId: clientState.playerId
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    if (data.newGameId) {
                        log(\`✅ Реванш начался! Новая игра: \${data.newGameId}\`, 'success');
                    } else {
                        log('✅ Предложение реванша отправлено', 'success');
                    }
                } else {
                    log(\`❌ Ошибка: \${data.error}\`, 'error');
                }
                
            } catch (error) {
                log(\`❌ Ошибка: \${error.message}\`, 'error');
            }
        }
        
        // Принятие реванша
        async function acceptRematch() {
            await offerRematch();
        }
        
        // Показать информацию об игроке
        function showGameInfo() {
            const playerInfo = document.getElementById('playerInfo');
            playerInfo.classList.remove('hidden');
            
            document.getElementById('infoName').textContent = clientState.playerName;
            document.getElementById('infoSide').textContent = clientState.playerIndex === 0 ? 'Игрок 1 (нижний ряд)' : 'Игрок 2 (верхний ряд)';
            document.getElementById('infoGameId').textContent = clientState.gameId;
            document.getElementById('infoPlayerId').textContent = clientState.playerId;
            
            document.getElementById('gameId').value = clientState.gameId;
        }
        
        // Инициализация доски
        function initializeBoard() {
            // Очищаем доску
            document.getElementById('pitsPlayer1').innerHTML = '';
            document.getElementById('pitsPlayer2').innerHTML = '';
            
            // Создаем лунки игрока 1 (0-5)
            for (let i = 0; i < 6; i++) {
                createPitElement(i, 'player1');
            }
            
            // Создаем лунки игрока 2 (7-12), но отображаем в обратном порядке
            for (let i = 7; i <= 12; i++) {
                createPitElement(i, 'player2');
            }
        }
        
        // Создание элемента лунки
        function createPitElement(index, player) {
            const pit = document.createElement('div');
            pit.className = 'kalah-pit';
            pit.id = \`pit_\${index}\`;
            pit.dataset.index = index;
            
            const displayNumber = player === 'player1' ? index : 12 - (index - 7);
            
            pit.innerHTML = \`
                <div class="pit-label">\${displayNumber}</div>
                <div class="pit-count" id="count_\${index}">0</div>
                <div class="stones-container" id="stones_\${index}"></div>
            \`;
            
            // Назначаем обработчик клика
            pit.addEventListener('click', () => {
                if (!pit.classList.contains('disabled')) {
                    makeMove(index);
                }
            });
            
            // Добавляем в соответствующий ряд
            if (player === 'player1') {
                document.getElementById('pitsPlayer1').appendChild(pit);
            } else {
                document.getElementById('pitsPlayer2').appendChild(pit);
            }
            
            return pit;
        }
        
        // Обновление отображения игры
        function updateGameDisplay() {
            const gameStatus = document.getElementById('gameStatus');
            const kalahBoard = document.getElementById('kalahBoard');
            const rematchPanel = document.getElementById('rematchPanel');
            const currentPlayerIndicator = document.getElementById('currentPlayerIndicator');
            
            if (clientState.gameState) {
                kalahBoard.style.display = 'flex';
                
                // Обновляем статус
                const statusText = getStatusText(clientState.gameState);
                gameStatus.textContent = statusText;
                gameStatus.className = \`game-status status-\${clientState.gameState.status}\`;
                
                // Обновляем индикатор текущего игрока
                if (clientState.gameState.status === 'playing') {
                    currentPlayerIndicator.classList.remove('hidden');
                    const isPlayer1 = clientState.gameState.currentPlayer === 0;
                    currentPlayerIndicator.className = \`current-player-indicator \${isPlayer1 ? 'player1' : 'player2'}\`;
                    document.getElementById('playerIndicatorDot').className = \`player-indicator-dot \${isPlayer1 ? 'player1' : 'player2'}\`;
                    document.getElementById('currentPlayerText').textContent = \`Сейчас ходит: \${isPlayer1 ? 'Игрок 1' : 'Игрок 2'}\`;
                } else {
                    currentPlayerIndicator.classList.add('hidden');
                }
                
                // Обновляем доску
                updateBoardDisplay();
                
                // Обновляем чат
                updateChat();
                
                // Показываем/скрываем панель реванша
                if (clientState.gameState.status === 'finished') {
                    rematchPanel.classList.remove('hidden');
                    
                    const rematchMessage = document.getElementById('rematchMessage');
                    const btnOfferRematch = document.getElementById('btnOfferRematch');
                    const btnAcceptRematch = document.getElementById('btnAcceptRematch');
                    
                    if (clientState.gameState.rematchOfferedBy) {
                        if (clientState.gameState.rematchOfferedBy === clientState.playerId) {
                            rematchMessage.textContent = 'Вы предложили реванш. Ожидайте ответа...';
                            btnOfferRematch.classList.add('hidden');
                            btnAcceptRematch.classList.add('hidden');
                        } else {
                            rematchMessage.textContent = 'Противник предлагает реванш!';
                            btnOfferRematch.classList.add('hidden');
                            btnAcceptRematch.classList.remove('hidden');
                        }
                    } else {
                        rematchMessage.textContent = 'Хотите сыграть реванш?';
                        btnOfferRematch.classList.remove('hidden');
                        btnAcceptRematch.classList.add('hidden');
                    }
                } else {
                    rematchPanel.classList.add('hidden');
                }
                
                // Завершаем анимацию
                clientState.isAnimating = false;
            }
        }
        
        // Обновление доски
        function updateBoardDisplay() {
            if (!clientState.gameState || !clientState.gameState.board) return;
            
            const board = clientState.gameState.board;
            
            // Обновляем калахи
            document.querySelector('#storePlayer1 .store-count').textContent = board[6];
            document.querySelector('#storePlayer2 .store-count').textContent = board[13];
            
            // Обновляем все лунки
            for (let i = 0; i < 14; i++) {
                if (i === 6 || i === 13) continue; // Пропускаем калахи
                
                const pit = document.getElementById(\`pit_\${i}\`);
                const countElement = document.getElementById(\`count_\${i}\`);
                const stonesContainer = document.getElementById(\`stones_\${i}\`);
                
                if (pit && countElement && stonesContainer) {
                    const count = board[i];
                    countElement.textContent = count;
                    
                    // Очищаем и создаем камни
                    stonesContainer.innerHTML = '';
                    
                    // Создаем визуальные камни
                    createStonesInPit(i, count, stonesContainer);
                    
                    // Обновляем состояние лунки
                    updatePitState(pit, i, count);
                }
            }
        }
        
        // Создание камней в лунке
        function createStonesInPit(pitIndex, count, container) {
            const maxStonesToShow = 12; // Максимальное количество отображаемых камней
            const stonesToShow = Math.min(count, maxStonesToShow);
            const isPlayer1 = pitIndex < 7;
            
            for (let i = 0; i < stonesToShow; i++) {
                const stone = document.createElement('div');
                stone.className = \`stone \${isPlayer1 ? 'player1' : 'player2'}\`;
                
                // Случайная позиция внутри лунки
                const angle = Math.random() * Math.PI * 2;
                const radius = Math.random() * 35;
                const x = Math.cos(angle) * radius;
                const y = Math.sin(angle) * radius;
                
                stone.style.left = \`calc(50% + \${x}px)\`;
                stone.style.top = \`calc(50% + \${y}px)\`;
                stone.style.transform = \`translate(-50%, -50%)\`;
                
                container.appendChild(stone);
            }
            
            // Если камней больше, чем показываем, добавляем индикатор
            if (count > maxStonesToShow) {
                const indicator = document.createElement('div');
                indicator.className = 'stone-count-indicator';
                indicator.textContent = \`+\${count - maxStonesToShow}\`;
                indicator.style.position = 'absolute';
                indicator.style.bottom = '5px';
                indicator.style.right = '5px';
                indicator.style.background = 'rgba(0,0,0,0.7)';
                indicator.style.color = 'white';
                indicator.style.padding = '2px 6px';
                indicator.style.borderRadius = '10px';
                indicator.style.fontSize = '0.8rem';
                container.appendChild(indicator);
            }
        }
        
        // Обновление состояния лунки
        function updatePitState(pit, index, count) {
            const isPlayer1Pit = index < 6 || index === 6;
            const isPlayer2Pit = (index >= 7 && index <= 12) || index === 13;
            
            // Сбрасываем классы
            pit.classList.remove('active', 'disabled');
            
            if (clientState.gameState.status === 'playing') {
                const isCurrentPlayer = clientState.gameState.currentPlayer === clientState.playerIndex;
                const isPlayersTurn = (clientState.playerIndex === 0 && isPlayer1Pit) || 
                                     (clientState.playerIndex === 1 && isPlayer2Pit);
                
                // Проверяем, может ли игрок ходить из этой лунки
                if (isCurrentPlayer && isPlayersTurn && count > 0 && 
                    ((clientState.playerIndex === 0 && index >= 0 && index <= 5) ||
                     (clientState.playerIndex === 1 && index >= 7 && index <= 12))) {
                    
                    pit.classList.add('active');
                    pit.style.cursor = 'pointer';
                } else {
                    pit.classList.add('disabled');
                    pit.style.cursor = 'not-allowed';
                }
            } else {
                pit.classList.add('disabled');
                pit.style.cursor = 'default';
            }
        }
        
        // Получение текста статуса
        function getStatusText(state) {
            switch(state.status) {
                case 'waiting':
                    return '⏳ Ожидание второго игрока...';
                case 'playing':
                    return \`🎲 Игра идёт. Ход: \${state.currentPlayer === 0 ? 'Игрок 1' : 'Игрок 2'}\`;
                case 'finished':
                    if (state.winner === 'draw') {
                        return \`🤝 Ничья! \${state.scores.player1}:\${state.scores.player2}\`;
                    } else {
                        const winnerName = state.winner === 'player1' ? 'Игрок 1' : 'Игрок 2';
                        return \`🏆 Победил \${winnerName} (\${state.scores.player1}:\${state.scores.player2})\`;
                    }
                default:
                    return state.status;
            }
        }
        
        // Обновление чата
        function updateChat() {
            if (!clientState.gameState || !clientState.gameState.messages) return;
            
            const chatMessages = document.getElementById('chatMessages');
            chatMessages.innerHTML = '';
            
            clientState.gameState.messages.forEach(msg => {
                const messageDiv = document.createElement('div');
                
                if (msg.type === 'system') {
                    messageDiv.className = 'message message-system';
                } else if (msg.type === 'move') {
                    messageDiv.className = 'message message-move';
                } else if (msg.player) {
                    messageDiv.className = \`message message-\${msg.playerIndex === 0 ? 'player1' : 'player2'}\`;
                } else {
                    messageDiv.className = 'message';
                }
                
                let senderName = '';
                if (msg.type === 'system') {
                    senderName = 'Система';
                } else if (msg.player) {
                    senderName = msg.player;
                }
                
                messageDiv.innerHTML = \`
                    <div class="message-header">
                        <span class="message-sender">\${senderName}</span>
                        <span class="message-time">\${formatTime(msg.timestamp)}</span>
                    </div>
                    <div class="message-text">\${msg.text}</div>
                \`;
                
                chatMessages.appendChild(messageDiv);
            });
            
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        
        // Глобальные функции
        window.createGame = createGame;
        window.joinGame = joinGame;
        window.offerRematch = offerRematch;
        window.acceptRematch = acceptRematch;
        
        // Инициализация
        document.addEventListener('DOMContentLoaded', () => {
            log('🎮 Игра Калах инициализирована. Готов к работе!', 'success');
            log(\`⚡ Сервер: \${SERVER_URL}\`, 'info');
            document.getElementById('playerName').focus();
        });
    </script>
</body>
</html>`;

    res.send(html);
});

// Запуск сервера
const PORT = 3000;
app.listen(PORT, () => {
    console.log('🎮 ===========================================');
    console.log('🎮  Сервер Калах с анимациями запущен!');
    console.log('🎮 ===========================================');
    console.log(`🌐  Главный интерфейс: http://localhost:\${PORT}`);
  console.log('📡  API работает на порту 3000');
  console.log('');
  console.log('✨  Особенности:');
  console.log('   • 🎨 Современный красивый интерфейс');
  console.log('   • ✨ Плавные анимации перемещения камней');
  console.log('   • 🔄 Полная поддержка реванша');
  console.log('   • 💬 Встроенный чат с подсветкой игроков');
  console.log('   • 📊 Детальные логи всех событий');
  console.log('');
  console.log('🎯  Как играть:');
  console.log('   1. Откройте http://localhost:3000 в двух вкладках');
  console.log('   2. Создайте игру в первой вкладке');
  console.log('   3. Присоединитесь по ID во второй вкладке');
  console.log('   4. Кликайте по активным лункам для хода');
  console.log('   5. Наслаждайтесь анимациями!');
  console.log('');
  console.log('🔄  Анимации включают:');
  console.log('   • Подсветку выбранной лунки');
  console.log('   • Плавное перемещение камней');
  console.log('   • Эффект захвата камней');
  console.log('   • Индикатор дополнительного хода');
  console.log('============================================');
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
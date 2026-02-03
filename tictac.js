const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const app = express();

app.use(cors());
app.use(express.json());

// Хранилища
const games = new Map(); // gameId -> game object
const connections = new Map(); // playerId -> { res, gameId }

// Middleware для статических файлов (если нужно)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware для SSE
const sseHeaders = (req, res, next) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    next();
};

// Функция отправки SSE с проверкой
function sendSSE(res, data) {
    try {
        if (res && !res.destroyed && !res.finished) {
            const jsonData = JSON.stringify(data);
            console.log(`[SEND SSE] Отправляю: ${jsonData.substring(0, 100)}...`);
            res.write(`data: ${jsonData}\n\n`);

            // Принудительный flush для немедленной отправки
            if (res.flush) {
                res.flush();
            }
            return true;
        }
        return false;
    } catch (error) {
        console.error('[SEND SSE] Ошибка:', error.message);
        return false;
    }
}

// Рассылка состояния игры всем игрокам
function broadcastGameState(gameId, sourcePlayerId = null) {
    console.log(`[BROADCAST] Рассылка для игры ${gameId} от игрока ${sourcePlayerId || 'сервера'}`);

    const game = games.get(gameId);
    if (!game) {
        console.log(`[BROADCAST] Игра ${gameId} не найдена`);
        return;
    }

    const updateData = {
        type: 'game_update',
        game: game.state,
        timestamp: Date.now(),
        sourcePlayerId: sourcePlayerId
    };

    let sentCount = 0;

    // Рассылаем всем игрокам игры
    game.players.forEach(player => {
        const connection = connections.get(player.id);
        if (connection && connection.res) {
            console.log(`[BROADCAST] Отправляю игроку ${player.name} (${player.id}, ${player.symbol})`);
            if (sendSSE(connection.res, updateData)) {
                sentCount++;
            }
        } else {
            console.log(`[BROADCAST] Игрок ${player.name} не имеет активного SSE соединения`);
        }
    });

    console.log(`[BROADCAST] Отправлено ${sentCount} из ${game.players.length} игрокам`);
}

// ========== API endpoints ==========

// SSE endpoint
app.get('/sse/:playerId/:gameId', sseHeaders, (req, res) => {
    const { playerId, gameId } = req.params;

    console.log(`[SSE CONNECT] Игрок ${playerId} подключается к игре ${gameId}`);

    // Сохраняем соединение
    connections.set(playerId, { res, gameId });

    // Отправляем приветственное сообщение
    sendSSE(res, {
        type: 'connected',
        playerId,
        timestamp: Date.now(),
        message: 'SSE соединение установлено'
    });

    // Отправляем текущее состояние игры сразу
    const game = games.get(gameId);
    if (game) {
        console.log(`[SSE CONNECT] Отправляю текущее состояние игры для ${playerId}`);
        sendSSE(res, {
            type: 'game_state',
            game: game.state,
            timestamp: Date.now()
        });
    }

    // Heartbeat
    const heartbeatInterval = setInterval(() => {
        try {
            sendSSE(res, { type: 'ping', timestamp: Date.now() });
        } catch (e) {
            clearInterval(heartbeatInterval);
        }
    }, 25000);

    // Обработка закрытия соединения
    req.on('close', () => {
        console.log(`[SSE DISCONNECT] Игрок ${playerId} отключился`);
        clearInterval(heartbeatInterval);
        connections.delete(playerId);
    });

    req.on('error', (err) => {
        console.error(`[SSE ERROR] Игрок ${playerId}:`, err.message);
        clearInterval(heartbeatInterval);
        connections.delete(playerId);
    });
});

// Создание игры
app.post('/game/create', (req, res) => {
    try {
        const gameId = `game_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const game = {
            id: gameId,
            players: [],
            state: {
                board: Array(9).fill(null),
                currentPlayer: 'X',
                status: 'ожидание',
                winner: null,
                messages: []
            },
            createdAt: Date.now()
        };

        games.set(gameId, game);
        console.log(`[CREATE] Создана игра ${gameId}`);

        res.json({
            success: true,
            gameId,
            game: game.state,
            message: 'Игра создана'
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

        console.log(`[JOIN] Попытка присоединения к игре ${gameId} как "${playerName}"`);

        const game = games.get(gameId);
        if (!game) {
            return res.status(404).json({
                success: false,
                error: 'Игра не найдена'
            });
        }

        // Проверяем количество игроков
        if (game.players.length >= 2) {
            return res.status(400).json({
                success: false,
                error: 'Игра уже началась'
            });
        }

        // Создаем игрока
        const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const player = {
            id: playerId,
            name: playerName || 'Игрок',
            symbol: game.players.length === 0 ? 'X' : 'O',
            connected: true,
            joinedAt: Date.now()
        };

        game.players.push(player);
        console.log(`[JOIN] Игрок ${player.name} (${player.symbol}, ${playerId}) присоединился`);

        // Если два игрока подключились, начинаем игру
        let gameStarted = false;
        if (game.players.length === 2) {
            game.state.status = 'игра';
            game.state.currentPlayer = 'X';
            gameStarted = true;

            console.log(`[JOIN] Игра ${gameId} началась! Два игрока подключены.`);

            // Добавляем системное сообщение
            game.state.messages.push({
                type: 'system',
                text: `🎮 Игра началась! Игроки: ${game.players[0].name}(X) vs ${game.players[1].name}(O)`,
                timestamp: Date.now()
            });

            game.state.messages.push({
                type: 'system',
                text: `🎲 Первый ход у ${game.players[0].name}(X)`,
                timestamp: Date.now()
            });
        }

        res.json({
            success: true,
            playerId,
            symbol: player.symbol,
            game: game.state,
            message: `Вы присоединились как ${player.symbol}`
        });

        // Если игра началась, рассылаем обновление ВСЕМ игрокам
        if (gameStarted) {
            console.log(`[JOIN] Рассылаю уведомление о начале игры всем игрокам`);

            setTimeout(() => {
                broadcastGameState(gameId, 'server');
            }, 500);
        }

    } catch (error) {
        console.error('[JOIN] Ошибка:', error);
        res.status(500).json({
            success: false,
            error: 'Ошибка подключения'
        });
    }
});

// Ход игрока
app.post('/game/:gameId/move', (req, res) => {
    try {
        const { gameId } = req.params;
        const { playerId, position } = req.body;

        console.log(`[MOVE] Запрос от ${playerId} на позицию ${position} в игре ${gameId}`);

        const game = games.get(gameId);
        if (!game) {
            console.log(`[MOVE] Игра ${gameId} не найдена`);
            return res.status(404).json({
                success: false,
                error: 'Игра не найдена'
            });
        }

        // Находим игрока
        const player = game.players.find(p => p.id === playerId);
        if (!player) {
            console.log(`[MOVE] Игрок ${playerId} не найден в игре`);
            return res.status(404).json({
                success: false,
                error: 'Игрок не найден'
            });
        }

        console.log(`[MOVE] Игрок: ${player.name} (${player.symbol}), текущий ход: ${game.state.currentPlayer}`);

        // Проверяем, чей сейчас ход
        if (game.state.currentPlayer !== player.symbol) {
            console.log(`[MOVE] Ошибка: не очередь ${player.symbol}, сейчас ходит ${game.state.currentPlayer}`);
            return res.status(400).json({
                success: false,
                error: 'Не ваш ход',
                currentPlayer: game.state.currentPlayer
            });
        }

        // Проверяем позицию
        if (position < 0 || position > 8) {
            return res.status(400).json({
                success: false,
                error: 'Неверная позиция (0-8)'
            });
        }

        // Проверяем, свободна ли клетка
        if (game.state.board[position] !== null) {
            console.log(`[MOVE] Клетка ${position} уже занята: ${game.state.board[position]}`);
            return res.status(400).json({
                success: false,
                error: 'Клетка занята'
            });
        }

        // Делаем ход
        game.state.board[position] = player.symbol;
        console.log(`[MOVE] Ход выполнен: ${player.symbol} на ${position}`);

        // Добавляем сообщение о ходе
        game.state.messages.push({
            type: 'move',
            text: `${player.name} (${player.symbol}) походил на позицию ${position}`,
            timestamp: Date.now(),
            player: player.name,
            symbol: player.symbol,
            position: position
        });

        // Проверяем победу
        const winner = checkWinner(game.state.board);
        if (winner) {
            game.state.winner = winner;
            game.state.status = 'завершена';
            const winnerPlayer = game.players.find(p => p.symbol === winner);

            console.log(`[MOVE] Победа! Выиграл ${winnerPlayer?.name || winner} (${winner})`);

            game.state.messages.push({
                type: 'system',
                text: `🏆 Победил ${winnerPlayer?.name || winner} (${winner})!`,
                timestamp: Date.now()
            });

        } else if (game.state.board.every(cell => cell !== null)) {
            // Ничья
            game.state.status = 'завершена';
            game.state.winner = 'ничья';
            console.log('[MOVE] Ничья! Все клетки заняты');

            game.state.messages.push({
                type: 'system',
                text: '🤝 Ничья! Все клетки заняты',
                timestamp: Date.now()
            });

        } else {
            // Передаем ход другому игроку
            game.state.currentPlayer = player.symbol === 'X' ? 'O' : 'X';
            const nextPlayer = game.players.find(p => p.symbol === game.state.currentPlayer);

            console.log(`[MOVE] Теперь ходит ${nextPlayer?.name || game.state.currentPlayer} (${game.state.currentPlayer})`);

            game.state.messages.push({
                type: 'system',
                text: `➡️ Теперь ходит ${nextPlayer?.name || 'противник'} (${game.state.currentPlayer})`,
                timestamp: Date.now()
            });
        }

        // Сохраняем обновленное состояние
        games.set(gameId, game);

        // Отправляем ответ клиенту
        res.json({
            success: true,
            game: game.state,
            message: 'Ход принят'
        });

        // Рассылаем обновление ВСЕМ игрокам сразу после ответа
        console.log(`[MOVE] Рассылаю обновление состояния игры ${gameId} всем игрокам`);

        setTimeout(() => {
            broadcastGameState(gameId, playerId);
        }, 50);

    } catch (error) {
        console.error('[MOVE] Ошибка:', error);
        res.status(500).json({
            success: false,
            error: 'Ошибка при ходе'
        });
    }
});

// Проверка победителя
function checkWinner(board) {
    const lines = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
        [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
        [0, 4, 8], [2, 4, 6] // diagonals
    ];

    for (let [a, b, c] of lines) {
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return board[a];
        }
    }
    return null;
}

// ========== HTML страницы ==========

// Страница отладки (debug.html)
app.get('/debug', (req, res) => {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Отладка игры (SSE)</title>
    <style>
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 15px;
            padding: 30px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 1200px;
            margin: 0 auto;
        }
        h1 {
            color: #333;
            text-align: center;
            margin-bottom: 30px;
            background: linear-gradient(to right, #4facfe 0%, #00f2fe 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .panel {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 30px;
            margin-bottom: 30px;
        }
        @media (max-width: 768px) {
            .panel {
                grid-template-columns: 1fr;
            }
        }
        .section {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 10px;
            border: 1px solid #e9ecef;
        }
        .section h2 {
            margin-top: 0;
            color: #495057;
            border-bottom: 2px solid #dee2e6;
            padding-bottom: 10px;
        }
        input, button {
            width: 100%;
            padding: 12px;
            margin: 8px 0;
            border: 2px solid #dee2e6;
            border-radius: 8px;
            font-size: 16px;
            box-sizing: border-box;
        }
        input:focus {
            outline: none;
            border-color: #4facfe;
            box-shadow: 0 0 0 3px rgba(79, 172, 254, 0.2);
        }
        button {
            background: linear-gradient(to right, #43e97b 0%, #38f9d7 100%);
            color: white;
            border: none;
            cursor: pointer;
            font-weight: bold;
            transition: transform 0.2s;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        .btn-secondary {
            background: linear-gradient(to right, #fa709a 0%, #fee140 100%);
        }
        .game-board {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 10px;
            margin: 20px auto;
            max-width: 300px;
        }
        .cell {
            aspect-ratio: 1;
            background: white;
            border: 3px solid #4facfe;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.2s;
        }
        .cell:hover {
            background: #f1f8ff;
            transform: scale(1.05);
        }
        .cell.x { color: #ff6b6b; }
        .cell.o { color: #4d96ff; }
        .status {
            background: white;
            padding: 15px;
            border-radius: 10px;
            margin: 15px 0;
            text-align: center;
            font-size: 1.2em;
            font-weight: bold;
            border: 2px dashed #dee2e6;
        }
        .player-info {
            background: white;
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 15px;
        }
        .player-info p {
            margin: 8px 0;
            padding: 8px;
            background: #f8f9fa;
            border-radius: 6px;
        }
        .logs {
            background: #212529;
            color: #f8f9fa;
            padding: 20px;
            border-radius: 10px;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            height: 300px;
            overflow-y: auto;
            margin-top: 20px;
        }
        .log-entry {
            padding: 6px 0;
            border-bottom: 1px solid #495057;
        }
        .log-time {
            color: #adb5bd;
            margin-right: 10px;
        }
        .log-info { color: #4d96ff; }
        .log-success { color: #51cf66; }
        .log-error { color: #ff6b6b; }
        .log-warning { color: #ffa502; }
        
        .chat {
            background: white;
            border-radius: 10px;
            padding: 15px;
            height: 300px;
            display: flex;
            flex-direction: column;
        }
        .messages {
            flex: 1;
            overflow-y: auto;
            margin-bottom: 15px;
            padding: 10px;
            background: #f8f9fa;
            border-radius: 8px;
        }
        .message {
            margin-bottom: 10px;
            padding: 10px;
            border-radius: 8px;
            background: white;
            border-left: 4px solid #4facfe;
        }
        .message.system {
            border-left-color: #ffa502;
            background: #fff9e6;
            font-style: italic;
        }
        .message.chat {
            border-left-color: #2ed573;
        }
        .chat-input {
            display: flex;
            gap: 10px;
        }
        .chat-input input {
            flex: 1;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎮 Отладка игры (SSE на порту 3001)</h1>
        
        <div class="panel">
            <div class="section">
                <h2>📝 Управление игрой</h2>
                
                <div>
                    <label>Ваше имя:</label>
                    <input type="text" id="playerName" placeholder="Введите ваше имя" value="Игрок">
                </div>
                
                <div>
                    <label>ID игры (для подключения):</label>
                    <input type="text" id="gameId" placeholder="Введите ID игры или оставьте пустым">
                </div>
                
                <button onclick="createGame()" id="btnCreate">🎮 Создать новую игру</button>
                <button onclick="joinGame()" class="btn-secondary" id="btnJoin">➕ Присоединиться к игре</button>
                
                <div class="player-info" id="playerInfo" style="display: none;">
                    <h3>👤 Информация об игроке</h3>
                    <p><strong>Имя:</strong> <span id="infoName"></span></p>
                    <p><strong>Символ:</strong> <span id="infoSymbol"></span></p>
                    <p><strong>ID игры:</strong> <span id="infoGameId"></span></p>
                    <p><strong>Ваш ID:</strong> <span id="infoPlayerId"></span></p>
                </div>
            </div>
            
            <div class="section">
                <h2>🎲 Игровое поле</h2>
                
                <div class="status" id="gameStatus">
                    Создайте игру или присоединитесь к существующей
                </div>
                
                <div class="game-board" id="gameBoard" style="display: none;">
                    <!-- Клетки будут созданы динамически -->
                </div>
                
                <div id="chatPanel" style="display: none;">
                    <h2>💬 Чат игры</h2>
                    <div class="chat">
                        <div class="messages" id="chatMessages">
                            <!-- Сообщения будут добавляться здесь -->
                        </div>
                        <div class="chat-input">
                            <input type="text" id="chatInput" placeholder="Введите сообщение..." 
                                   onkeypress="if(event.key === 'Enter') sendMessage()">
                            <button onclick="sendMessage()">Отправить</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="logs">
            <h3 style="color: white; margin-bottom: 15px;">📋 Лог событий</h3>
            <div id="logContainer"></div>
        </div>
    </div>

    <script>
        // Конфигурация
        const SERVER_URL = 'http://localhost:3000';
        
        // Состояние клиента
        const clientState = {
            gameId: null,
            playerId: null,
            playerName: null,
            symbol: null,
            eventSource: null,
            gameState: null,
            isConnected: false
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
                minute: '2-digit',
                second: '2-digit'
            });
        }
        
        // Создание игры
        async function createGame() {
            const playerName = document.getElementById('playerName').value.trim() || 'Игрок';
            clientState.playerName = playerName;
            
            try {
                log('Создание новой игры...', 'info');
                
                const response = await fetch(\`\${SERVER_URL}/game/create\`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    }
                });
                
                const data = await response.json();
                
                if (data.success) {
                    clientState.gameId = data.gameId;
                    log(\`✅ Игра создана! ID: \${data.gameId}\`, 'success');
                    
                    // Автоматически присоединяемся к созданной игре
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
                    clientState.symbol = data.symbol;
                    clientState.gameState = data.game;
                    
                    log(\`✅ Успешно! Вы играете за \${data.symbol} как "\${data.playerName}"\`, 'success');
                    
                    showGameInfo();
                    connectSSE();
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
                console.log('Raw SSE event:', event.data);
                
                try {
                    let dataStr = event.data;
                    
                    // Если есть префикс 'data: ', удаляем его
                    if (dataStr.startsWith('data: ')) {
                        dataStr = dataStr.substring(6);
                    }
                    
                    // Пытаемся распарсить JSON
                    if (dataStr.trim() !== '') {
                        const data = JSON.parse(dataStr);
                        handleServerEvent(data);
                    }
                } catch (error) {
                    log(\`❌ Ошибка парсинга SSE: \${error.message}\`, 'error');
                    log(\`Данные: \${event.data.substring(0, 100)}\`, 'error');
                }
            };
            
            clientState.eventSource.onerror = (error) => {
                log('❌ Ошибка SSE соединения', 'error');
                clientState.isConnected = false;
                
                // Переподключение через 5 секунд
                setTimeout(() => {
                    if (!clientState.isConnected) {
                        log('Попытка переподключения...', 'info');
                        connectSSE();
                    }
                }, 5000);
            };
        }
        
        // Обработка событий от сервера
        function handleServerEvent(data) {
            switch(data.type) {
                case 'connected':
                    log(\`Сервер: \${data.message}\`, 'info');
                    break;
                    
                case 'game_state':
                case 'game_update':
                    clientState.gameState = data.game;
                    updateGameDisplay();
                    log(\`🔄 Обновление игры от \${data.sourcePlayerId || 'сервера'}\`, 'info');
                    break;
                    
                case 'heartbeat':
                case 'ping':
                    // Игнорируем пинги
                    break;
                    
                default:
                    log(\`Неизвестный тип события: \${data.type}\`, 'warning');
            }
        }
        
        // Отправка хода
        async function makeMove(position) {
            if (!clientState.gameId || !clientState.playerId) {
                log('Сначала присоединитесь к игре', 'error');
                return;
            }
            
            if (clientState.gameState.status !== 'игра') {
                log('Игра еще не началась или уже завершена', 'warning');
                return;
            }
            
            if (clientState.gameState.currentPlayer !== clientState.symbol) {
                log(\`Сейчас не ваш ход (ходит \${clientState.gameState.currentPlayer})\`, 'warning');
                return;
            }
            
            try {
                const response = await fetch(\`\${SERVER_URL}/game/\${clientState.gameId}/move\`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify({
                        playerId: clientState.playerId,
                        position: position
                    })
                });
                
                const data = await response.json();
                
                if (!data.success) {
                    log(\`Ошибка: \${data.error || data.message}\`, 'error');
                } else {
                    log(\`✅ Ход принят\`, 'success');
                    clientState.gameState = data.game;
                    updateGameDisplay();
                }
                
            } catch (error) {
                log(\`Ошибка отправки хода: \${error.message}\`, 'error');
            }
        }
        
        // Отправка сообщения в чат
        async function sendMessage() {
            const input = document.getElementById('chatInput');
            const message = input.value.trim();
            
            if (!message || !clientState.gameId || !clientState.playerId) {
                return;
            }
            
            try {
                const response = await fetch(\`\${SERVER_URL}/game/\${clientState.gameId}/chat\`, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    body: JSON.stringify({
                        playerId: clientState.playerId,
                        text: message
                    })
                });
                
                input.value = '';
                
            } catch (error) {
                log(\`Ошибка отправки сообщения: \${error.message}\`, 'error');
            }
        }
        
        // Показать информацию об игроке
        function showGameInfo() {
            const playerInfo = document.getElementById('playerInfo');
            playerInfo.style.display = 'block';
            
            document.getElementById('infoName').textContent = clientState.playerName;
            document.getElementById('infoSymbol').textContent = clientState.symbol;
            document.getElementById('infoGameId').textContent = clientState.gameId;
            document.getElementById('infoPlayerId').textContent = clientState.playerId;
            
            // Показать ID игры для второго игрока
            document.getElementById('gameId').value = clientState.gameId;
        }
        
        // Обновление отображения игры
        function updateGameDisplay() {
            const gameArea = document.getElementById('gameBoard');
            const gameStatus = document.getElementById('gameStatus');
            const chatPanel = document.getElementById('chatPanel');
            
            if (clientState.gameState) {
                gameArea.style.display = 'grid';
                chatPanel.style.display = 'block';
                
                // Обновляем статус
                gameStatus.textContent = getStatusText(clientState.gameState);
                gameStatus.className = \`status \${clientState.gameState.status}\`;
                
                // Создаем/обновляем доску
                gameArea.innerHTML = '';
                
                clientState.gameState.board.forEach((cell, index) => {
                    const cellElement = document.createElement('div');
                    cellElement.className = \`cell \${cell || ''}\`;
                    cellElement.textContent = cell || '';
                    cellElement.title = \`Клетка \${Math.floor(index/3)+1},\${(index%3)+1}\`;
                    
                    if (clientState.gameState.status === 'игра' && 
                        !cell && 
                        clientState.gameState.currentPlayer === clientState.symbol) {
                        cellElement.style.cursor = 'pointer';
                        cellElement.onclick = () => makeMove(index);
                    } else {
                        cellElement.style.cursor = 'default';
                        cellElement.onclick = null;
                    }
                    
                    gameArea.appendChild(cellElement);
                });
                
                // Обновляем чат
                updateChat();
            }
        }
        
        // Получение текста статуса
        function getStatusText(state) {
            const statuses = {
                'ожидание': '⏳ Ожидание второго игрока...',
                'игра': \`🎲 Сейчас ходит: \${state.currentPlayer}\`,
                'пауза': '⏸️ Игра приостановлена',
                'завершена': state.winner === 'ничья' 
                    ? '🤝 Ничья!' 
                    : \`🏆 Победил: \${state.winner}\`
            };
            
            return statuses[state.status] || state.status;
        }
        
        // Обновление чата
        function updateChat() {
            if (!clientState.gameState || !clientState.gameState.messages) return;
            
            const chatMessages = document.getElementById('chatMessages');
            chatMessages.innerHTML = '';
            
            clientState.gameState.messages.forEach(msg => {
                const messageDiv = document.createElement('div');
                messageDiv.className = \`message \${msg.type}\`;
                
                let sender = '';
                if (msg.type === 'player' || msg.type === 'chat') {
                    sender = \`\${msg.player} (\${msg.symbol}): \`;
                } else if (msg.type === 'system') {
                    sender = '⚙️ ';
                } else if (msg.type === 'move') {
                    sender = '🎮 ';
                }
                
                messageDiv.innerHTML = \`
                    <div class="sender">\${sender}</div>
                    <div class="text">\${msg.text}</div>
                    <div class="time">\${formatTime(msg.timestamp)}</div>
                \`;
                
                chatMessages.appendChild(messageDiv);
            });
            
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
        
        // Глобальные функции для кнопок
        window.createGame = createGame;
        window.joinGame = joinGame;
        window.sendMessage = sendMessage;
        
        // Автофокус на поле ввода имени
        document.getElementById('playerName').focus();
        
        // Поддержка Enter для отправки сообщений
        document.getElementById('chatInput')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });
        
        log('Клиент инициализирован. Готов к работе!', 'success');
        log(\`Сервер API: \${SERVER_URL}\`, 'info');
        log('Страница отладки запущена на порту 3001', 'info');
    </script>
</body>
</html>`;

    res.send(html);
});

// Главная страница
app.get('/', (req, res) => {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Игровой сервер</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 40px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: white;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: rgba(255, 255, 255, 0.1);
            padding: 30px;
            border-radius: 15px;
            backdrop-filter: blur(10px);
        }
        h1 {
            text-align: center;
            margin-bottom: 30px;
            font-size: 2.5em;
        }
        .card {
            background: rgba(255, 255, 255, 0.2);
            padding: 20px;
            margin: 15px 0;
            border-radius: 10px;
            border-left: 5px solid #4facfe;
        }
        .card h2 {
            margin-top: 0;
            color: #fff;
        }
        .card p {
            margin: 10px 0;
            line-height: 1.6;
        }
        a {
            color: #4facfe;
            text-decoration: none;
            font-weight: bold;
        }
        a:hover {
            text-decoration: underline;
        }
        .endpoints {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
            margin-top: 20px;
        }
        .endpoint {
            background: rgba(255, 255, 255, 0.1);
            padding: 15px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 14px;
        }
        .badge {
            display: inline-block;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
            margin-right: 8px;
        }
        .badge.get { background: #61affe; color: white; }
        .badge.post { background: #49cc90; color: white; }
        .stats {
            display: flex;
            justify-content: space-around;
            margin: 30px 0;
            text-align: center;
        }
        .stat {
            background: rgba(255, 255, 255, 0.2);
            padding: 20px;
            border-radius: 10px;
            flex: 1;
            margin: 0 10px;
        }
        .stat .number {
            font-size: 2.5em;
            font-weight: bold;
            color: #4facfe;
        }
        .stat .label {
            font-size: 0.9em;
            opacity: 0.9;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎮 Игровой сервер (SSE)</h1>
        
        <div class="card">
            <h2>📡 Статус сервера</h2>
            <p>Сервер успешно запущен и готов к работе!</p>
            <p><strong>API порт:</strong> 3000</p>
            <p><strong>Интерфейс порт:</strong> 3001</p>
            <p><strong>Протокол:</strong> Server-Sent Events (SSE)</p>
        </div>
        
        <div class="stats">
            <div class="stat">
                <div class="number" id="gamesCount">0</div>
                <div class="label">Активных игр</div>
            </div>
            <div class="stat">
                <div class="number" id="connectionsCount">0</div>
                <div class="label">Подключений</div>
            </div>
            <div class="stat">
                <div class="number" id="playersCount">0</div>
                <div class="label">Игроков онлайн</div>
            </div>
        </div>
        
        <div class="card">
            <h2>🔗 Быстрые ссылки</h2>
            <p>• <a href="/debug" target="_blank">🎮 Отладка игры</a> - полный интерфейс для игры</p>
            <p>• <a href="/stats" target="_blank">📊 Статистика сервера</a> - текущее состояние</p>
            <p>• <a href="http://localhost:3000/stats" target="_blank">📡 API статистика</a> - JSON API</p>
        </div>
        
        <div class="card">
            <h2>🚀 Как начать играть</h2>
            <p>1. Откройте <a href="/debug" target="_blank">страницу отладки</a> в двух вкладках браузера</p>
            <p>2. В первой вкладке создайте новую игру</p>
            <p>3. Во второй вкладке вставьте ID игры и присоединитесь</p>
            <p>4. Начинайте играть в крестики-нолики!</p>
        </div>
        
        <div class="card">
            <h2>📚 Доступные endpoints</h2>
            <div class="endpoints">
                <div class="endpoint">
                    <span class="badge post">POST</span> /game/create<br>
                    <small>Создание новой игры</small>
                </div>
                <div class="endpoint">
                    <span class="badge post">POST</span> /game/:id/join<br>
                    <small>Присоединение к игре</small>
                </div>
                <div class="endpoint">
                    <span class="badge post">POST</span> /game/:id/move<br>
                    <small>Сделать ход</small>
                </div>
                <div class="endpoint">
                    <span class="badge get">GET</span> /sse/:player/:game<br>
                    <small>SSE соединение</small>
                </div>
                <div class="endpoint">
                    <span class="badge get">GET</span> /game/:id<br>
                    <small>Получить состояние игры</small>
                </div>
                <div class="endpoint">
                    <span class="badge get">GET</span> /stats<br>
                    <small>Статистика сервера</small>
                </div>
            </div>
        </div>
        
        <div class="card">
            <h2>🔧 Техническая информация</h2>
            <p><strong>Технологии:</strong> Node.js, Express, Server-Sent Events</p>
            <p><strong>Кодировка:</strong> UTF-8 (полная поддержка русского языка)</p>
            <p><strong>Хранение состояния:</strong> In-memory (перезапуск сервера очистит все игры)</p>
            <p><strong>Особенности:</strong> Реальное время без WebSocket, автоматическое переподключение</p>
        </div>
    </div>

    <script>
        // Обновление статистики
        async function updateStats() {
            try {
                const response = await fetch('http://localhost:3000/stats');
                const data = await response.json();
                
                document.getElementById('gamesCount').textContent = data.games || 0;
                document.getElementById('connectionsCount').textContent = data.connections || 0;
                document.getElementById('playersCount').textContent = data.players || 0;
            } catch (error) {
                console.log('Не удалось получить статистику:', error);
            }
        }
        
        // Обновляем статистику каждые 5 секунд
        updateStats();
        setInterval(updateStats, 5000);
    </script>
</body>
</html>`;

    res.send(html);
});

// Статистика
app.get('/stats', (req, res) => {
    const stats = {
        games: games.size,
        connections: connections.size,
        players: Array.from(games.values()).reduce((sum, game) => sum + game.players.length, 0),
        activeGames: Array.from(games.values()).filter(g => g.players.length === 2 && g.state.status === 'игра').length,
        waitingGames: Array.from(games.values()).filter(g => g.players.length === 1).length,
        timestamp: Date.now(),
        server: 'SSE Game Server v1.0'
    };

    res.json(stats);
});

// Проверка здоровья сервера
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        uptime: process.uptime()
    });
});

// Обработка 404
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.path} not found`,
        available_routes: [
            'GET  /          - Главная страница',
            'GET  /debug     - Страница отладки',
            'GET  /stats     - Статистика',
            'GET  /health    - Проверка здоровья',
            'POST /game/create - Создать игру',
            'POST /game/:id/join - Присоединиться',
            'POST /game/:id/move - Сделать ход',
            'GET  /sse/:player/:game - SSE подключение'
        ]
    });
});

// Запуск сервера на двух портах
const PORT_API = 3000;
const PORT_HTML = 3001;

// Создаем HTTP сервер
const tictac = http.createServer(app);

// Запускаем сервер на порту 3000 (API)
tictac.listen(PORT_API, () => {
    console.log(`✅ API сервер запущен на порту ${PORT_API}`);
    console.log(`🌐 http://localhost:${PORT_API}`);
    console.log('📊 /stats - статистика');
    console.log('🔧 /health - проверка здоровья');
    console.log('🎮 /game/create - создание игры');
});

// Создаем отдельный сервер для HTML интерфейса
const htmlApp = express();

// Middleware для статических файлов
htmlApp.use(express.static(path.join(__dirname, 'public')));

// Роуты для HTML приложения
htmlApp.get('/', (req, res) => {
    res.redirect(`http://localhost:${PORT_HTML}/debug`);
});

htmlApp.get('/debug', (req, res) => {
    // Возвращаем ту же HTML страницу что и на порту 3000
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Отладка игры на порту 3001</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .container { max-width: 600px; margin: 0 auto; }
        h1 { color: #333; }
        .info { background: #f0f0f0; padding: 20px; border-radius: 10px; margin: 20px 0; }
        .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; }
        a { color: #0066cc; text-decoration: none; }
        a:hover { text-decoration: underline; }
        button { background: #4CAF50; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
        button:hover { background: #45a049; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎮 Игровой интерфейс (порт 3001)</h1>
        
        <div class="info">
            <p><strong>API сервер:</strong> <a href="http://localhost:3000" target="_blank">http://localhost:3000</a></p>
            <p><strong>Текущий интерфейс:</strong> http://localhost:3001/debug</p>
            <p>Этот интерфейс использует API на порту 3000</p>
        </div>
        
        <div class="warning">
            <p><strong>Внимание!</strong> Для корректной работы игры необходимо:</p>
            <ol>
                <li>API сервер должен быть запущен на порту 3000</li>
                <li>Откройте этот интерфейс в двух вкладках браузера</li>
                <li>Используйте CORS-friendly браузер или отключите CORS защиту</li>
            </ol>
        </div>
        
        <div style="margin: 30px 0; text-align: center;">
            <button onclick="window.open('/debug/full', '_blank')">▶️ Открыть полный интерфейс</button>
            <p style="margin-top: 10px; font-size: 0.9em; color: #666;">(откроется в новой вкладке)</p>
        </div>
        
        <div>
            <h3>📊 Быстрая проверка:</h3>
            <p><a href="http://localhost:3000/health" target="_blank">Проверить API сервер</a></p>
            <p><a href="http://localhost:3000/stats" target="_blank">Посмотреть статистику</a></p>
        </div>
    </div>
</body>
</html>`;

    res.send(html);
});

// Полный интерфейс отладки (редирект на порт 3000)
htmlApp.get('/debug/full', (req, res) => {
    res.redirect(`http://localhost:${PORT_API}/debug`);
});

// Запускаем HTML сервер на порту 3001
htmlApp.listen(PORT_HTML, () => {
    console.log(`✅ HTML интерфейс запущен на порту ${PORT_HTML}`);
    console.log(`🌐 http://localhost:${PORT_HTML}`);
    console.log(`🎮 http://localhost:${PORT_HTML}/debug - интерфейс отладки`);
    console.log('⚡ Откройте этот URL в двух вкладках для игры!');
});

// Обработка завершения работы
process.on('SIGINT', () => {
    console.log('\n🔻 Завершение работы сервера...');
    console.log(`📊 Итоговая статистика: ${games.size} игр, ${connections.size} соединений`);
    process.exit(0);
});

// Автоматическая очистка старых игр
setInterval(() => {
    const now = Date.now();
    const hourAgo = now - 3600000; // 1 час

    for (const [gameId, game] of games) {
        if (game.createdAt < hourAgo) {
            games.delete(gameId);
            console.log(`🗑️ Удалена старая игра: ${gameId}`);
        }
    }
}, 300000); // Каждые 5 минут